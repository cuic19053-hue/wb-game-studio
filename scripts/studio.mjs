#!/usr/bin/env node
/**
 * wb-game-studio - zero-dependency game project tool for WorkBuddy.
 *
 * Commands:
 *   create      --dir DIR --template collector|voxel [--title T] [--rules JSON] [--slots JSON]
 *               [--orientation portrait|landscape] [--lang zh|en] [--force]
 *   build       --dir DIR [--note TEXT]
 *   playtest    --dir DIR [--seconds N] [--portrait] [--characters]
 *   asset       <generate|stage|apply|revert|list> --dir DIR --slot NAME [options]
 *   versions    --dir DIR
 *   restore     --dir DIR --id BUILDID
 *   export      --dir DIR [--out FILE]
 *   share       --dir DIR [--seconds N] [--port N] [--no-wait]
 *   list        [--root DIR]
 *   wall        [--root DIR] [--filter 2d|3d|all] [--sort recent|versions|name] [--out FILE]
 *   export-wall (alias of wall)
 *   locale
 *
 * All commands print one JSON object to stdout. Run with `env -u NODE_OPTIONS`
 * on machines where the WorkBuddy sandbox shim intercepts directory creation.
 */
import { cp, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPlaytest } from './playtest.mjs'
import {
  stageCandidate, listCandidates, applyCandidate, revertSlot,
  generateOpenai, generateCodex, builtinHandoff, costCard,
} from './assets.mjs'
import { startShare } from './share.mjs'
import { buildWall, scanGames } from './wall.mjs'
import { localize, LANGS } from './i18n.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATES = join(ROOT, 'assets', 'templates')
const VENDOR = join(ROOT, 'assets', 'vendor')
const MAX_ARTIFACT_BYTES = 24 * 1024 * 1024
const TEMPLATE_IDS = ['collector', 'voxel']

const CSP = [
  "default-src 'none'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'none'",
  "form-action 'none'",
].join('; ')

const BASE_STYLE = 'html,body{margin:0;height:100%;overflow:hidden;background:#000}'
  + 'canvas{display:block;width:100vw;height:100vh;touch-action:none;outline:none}'

function styleFor(orientation) {
  if (orientation !== 'portrait') return BASE_STYLE
  return BASE_STYLE
    + 'body{display:flex;align-items:center;justify-content:center}'
    + '#game{width:min(100vw,56.25vh)!important;height:min(100vh,177.78vw)!important}'
}

class StudioError extends Error {
  constructor(message, code = 'ERROR') {
    super(message)
    this.code = code
  }
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) { out._.push(arg); continue }
    const eq = arg.indexOf('=')
    if (eq > -1) { out[arg.slice(2, eq)] = arg.slice(eq + 1); continue }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i += 1 }
  }
  return out
}

function parseJson(value, fallback, label) {
  if (value === undefined || value === true) return fallback
  try { return JSON.parse(value) }
  catch { throw new StudioError(`${label} 不是合法 JSON: ${String(value).slice(0, 120)}`, 'BAD_JSON') }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge(base, patch) {
  if (!isObject(patch)) return patch === undefined ? base : patch
  const out = { ...(isObject(base) ? base : {}) }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isObject(value) && isObject(out[key]) ? deepMerge(out[key], value) : value
  }
  return out
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function mimeOf(file) {
  const ext = extname(file).toLowerCase()
  return {
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  }[ext] || 'application/octet-stream'
}

function inlineSafe(text) {
  return text.replace(/<\/(script)/giu, '<\\/$1').replace(/<!--/gu, '<\\!--')
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

function slug(text) {
  return String(text || 'game').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 48) || 'game'
}

async function atomicWrite(file, data) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, file)
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) }
  catch (error) { throw new StudioError(`无法读取 ${file}: ${error.message}`, 'BAD_FILE') }
}

async function loadManifest(dir) {
  const manifest = await readJson(join(dir, 'game.json'))
  if (manifest.schema !== 1) throw new StudioError('game.json 需要 schema: 1', 'BAD_MANIFEST')
  if (!TEMPLATE_IDS.includes(manifest.template)) {
    throw new StudioError(`未知模板 "${manifest.template}"，可选: ${TEMPLATE_IDS.join(', ')}`, 'BAD_MANIFEST')
  }
  if (!isObject(manifest.slots)) throw new StudioError('game.json 缺少 slots 对象', 'BAD_MANIFEST')
  return manifest
}

/** A slot counts as custom art when its file differs from the pristine template file. */
async function slotIsCustom(dir, manifest, slot, spec) {
  const current = join(dir, spec.file)
  const pristine = join(TEMPLATES, manifest.template, spec.file)
  if (!existsSync(pristine)) return true
  try {
    const [a, b] = await Promise.all([readFile(current), readFile(pristine)])
    return sha256(a) !== sha256(b)
  } catch { return true }
}

async function renderHtml(dir, manifest) {
  const assets = {}
  const slots = {}
  for (const [slot, spec] of Object.entries(manifest.slots)) {
    if (!spec || typeof spec.file !== 'string') throw new StudioError(`槽位 ${slot} 缺少 file`, 'BAD_MANIFEST')
    let bytes
    try { bytes = await readFile(join(dir, spec.file)) }
    catch { throw new StudioError(`槽位 ${slot} 的素材不存在: ${spec.file}`, 'MISSING_ASSET') }
    assets[slot] = `data:${mimeOf(spec.file)};base64,${bytes.toString('base64')}`
    slots[slot] = {
      tile: spec.tile === true,
      custom: await slotIsCustom(dir, manifest, slot, spec),
    }
  }
  let code
  try { code = await readFile(join(dir, 'game.js'), 'utf8') }
  catch { throw new StudioError('game.js 不存在', 'MISSING_CODE') }
  const lang = manifest.lang || 'zh'
  code = localize(code, lang)

  let runtime = null
  if ((manifest.runtime || []).includes('three')) {
    try { runtime = await readFile(join(VENDOR, 'three.min.js'), 'utf8') }
    catch { throw new StudioError('缺少 assets/vendor/three.min.js，3D 模板无法构建', 'MISSING_RUNTIME') }
  }

  const orientation = manifest.orientation === 'portrait' ? 'portrait' : 'landscape'
  const game = {
    title: manifest.title || 'Untitled game',
    rules: manifest.rules || {},
    slots,
    assets,
    orientation,
    lang,
  }
  const lines = [
    '<!doctype html>',
    `<html lang="${escapeHtml(lang)}"><head><meta charset="utf-8">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `<title>${escapeHtml(game.title)}</title>`,
    `<style>${styleFor(orientation)}</style></head><body><canvas id="game" tabindex="0"></canvas>`,
  ]
  if (runtime) lines.push(`<script id="wb-three-runtime">${inlineSafe(runtime)}</script>`)
  lines.push(
    `<script>window.GAME=${inlineSafe(JSON.stringify(game))};</script>`,
    `<script>${inlineSafe(code)}</script>`,
    '</body></html>',
    '',
  )
  return lines.join('\n')
}

function projectPaths(dir) {
  return {
    versionsJson: join(dir, '.studio', 'versions.json'),
    versionDir: (id) => join(dir, '.studio', 'versions', id),
    artifact: join(dir, 'dist', 'index.html'),
  }
}

async function recordVersion(dir, buildId, note, bytes) {
  const p = projectPaths(dir)
  let history = []
  try { history = JSON.parse(await readFile(p.versionsJson, 'utf8')) } catch { /* first build */ }
  if (history.length && history[0].id === buildId) return { history, saved: false }
  const snap = p.versionDir(buildId)
  await mkdir(snap, { recursive: true })
  await copyFile(join(dir, 'game.json'), join(snap, 'game.json'))
  await copyFile(join(dir, 'game.js'), join(snap, 'game.js'))
  if (existsSync(join(dir, 'assets'))) {
    await cp(join(dir, 'assets'), join(snap, 'assets'), { recursive: true })
  }
  history.unshift({ id: buildId, note, at: new Date().toISOString(), bytes })
  await atomicWrite(p.versionsJson, `${JSON.stringify(history.slice(0, 50), null, 2)}\n`)
  return { history, saved: true }
}

function dirOf(a) {
  return a.dir ? resolve(String(a.dir)) : resolve(process.cwd())
}

const COMMANDS = {
  async create(a) {
    const dir = a.dir ? resolve(String(a.dir)) : null
    if (!dir) throw new StudioError('create 需要 --dir', 'BAD_ARGS')
    const template = String(a.template || 'collector')
    if (!TEMPLATE_IDS.includes(template)) {
      throw new StudioError(`未知模板 "${template}"，可选: ${TEMPLATE_IDS.join(', ')}`, 'BAD_TEMPLATE')
    }
    if (existsSync(join(dir, 'game.json')) && a.force !== true) {
      throw new StudioError(`${dir} 已有游戏项目；加 --force 覆盖`, 'EXISTS')
    }
    const source = join(TEMPLATES, template)
    await mkdir(dir, { recursive: true })
    await copyFile(join(source, 'game.js'), join(dir, 'game.js'))
    await cp(join(source, 'assets'), join(dir, 'assets'), { recursive: true })
    const manifest = await readJson(join(source, 'game.json'))
    if (a.title) manifest.title = String(a.title)
    const rules = parseJson(a.rules, undefined, '--rules')
    if (rules) manifest.rules = deepMerge(manifest.rules || {}, rules)
    const slotPatch = parseJson(a.slots, undefined, '--slots')
    if (slotPatch) {
      for (const [key, value] of Object.entries(slotPatch)) {
        if (value === null) delete manifest.slots[key]
        else manifest.slots[key] = deepMerge(manifest.slots[key] || {}, value)
      }
    }
    if (a.orientation) manifest.orientation = String(a.orientation)
    if (a.lang) manifest.lang = String(a.lang)
    await atomicWrite(join(dir, 'game.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const ledger = Object.fromEntries(Object.keys(manifest.slots).map((k) => [k, { source: 'template' }]))
    await atomicWrite(join(dir, 'assets', 'ASSETS.json'), `${JSON.stringify(ledger, null, 2)}\n`)
    return {
      ok: true, command: 'create', dir, template, title: manifest.title,
      orientation: manifest.orientation || 'landscape', lang: manifest.lang || 'zh',
      slots: Object.keys(manifest.slots),
      next: `env -u NODE_OPTIONS node ${join(ROOT, 'scripts', 'studio.mjs')} build --dir ${dir}`,
    }
  },

  async build(a) {
    const dir = dirOf(a)
    const manifest = await loadManifest(dir)
    const html = await renderHtml(dir, manifest)
    const bytes = Buffer.byteLength(html)
    if (bytes > MAX_ARTIFACT_BYTES) {
      throw new StudioError(`产物 ${(bytes / 1048576).toFixed(1)} MB 超过 24 MB 上限`, 'TOO_LARGE')
    }
    const buildId = sha256(html).slice(0, 12)
    await atomicWrite(projectPaths(dir).artifact, html)
    const { history, saved } = await recordVersion(dir, buildId, String(a.note || 'Built'), bytes)
    const customSlots = []
    for (const [slot, spec] of Object.entries(manifest.slots)) {
      if (await slotIsCustom(dir, manifest, slot, spec)) customSlots.push(slot)
    }
    return {
      ok: true, command: 'build', dir, buildId, bytes,
      artifact: projectPaths(dir).artifact,
      title: manifest.title,
      runtime: manifest.runtime || [],
      orientation: manifest.orientation || 'landscape',
      lang: manifest.lang || 'zh',
      versionSaved: saved,
      versions: history.length,
      customSlots,
    }
  },

  async playtest(a) {
    const dir = dirOf(a)
    const artifact = projectPaths(dir).artifact
    if (!existsSync(artifact)) throw new StudioError('还没有 dist/index.html，请先 build', 'NOT_BUILT')
    return runPlaytest({
      dir, artifact,
      seconds: Number(a.seconds || 8),
      portrait: a.portrait === true,
      characters: a.characters === true,
    })
  },

  async asset(a) {
    const sub = String(a._[1] || '')
    const dir = dirOf(a)
    const slot = a.slot ? String(a.slot) : undefined
    const count = Math.max(1, Math.min(4, Number(a.count || 2)))
    const prompt = a.prompt ? String(a.prompt) : undefined
    if (!['generate', 'stage', 'apply', 'revert', 'list'].includes(sub)) {
      throw new StudioError('asset 子命令: generate | stage | apply | revert | list', 'BAD_ARGS')
    }
    if (sub !== 'list' && !slot) throw new StudioError('asset 需要 --slot', 'BAD_ARGS')

    if (sub === 'stage') {
      if (!a.file) throw new StudioError('asset stage 需要 --file', 'BAD_ARGS')
      return stageCandidate({ dir, slot, file: resolve(String(a.file)), label: a.label ? String(a.label) : undefined, prompt, source: a.source ? String(a.source) : 'external' })
    }
    if (sub === 'list') return listCandidates({ dir, slot })
    if (sub === 'apply') {
      const result = await applyCandidate({ dir, slot, number: a.number })
      const built = await COMMANDS.build({ dir, note: `应用 ${slot} 美术` })
      return { ...result, rebuilt: { buildId: built.buildId, bytes: built.bytes, customSlots: built.customSlots } }
    }
    if (sub === 'revert') {
      const result = await revertSlot({ dir, slot })
      const built = await COMMANDS.build({ dir, note: `回退 ${slot} 美术` })
      return { ...result, rebuilt: { buildId: built.buildId, bytes: built.bytes, customSlots: built.customSlots } }
    }

    const provider = String(a.provider || 'auto')
    if (provider === 'builtin' || (provider === 'auto' && !process.env.OPENAI_API_KEY)) {
      return builtinHandoff({ dir, slot, count, prompt })
    }
    if (provider === 'codex') {
      return generateCodex({ dir, slot, count, prompt, command: a.command ? String(a.command) : undefined, timeoutMinutes: Number(a['timeout-minutes'] || 15) })
    }
    return generateOpenai({
      dir, slot, count, prompt,
      reference: a.reference ? resolve(String(a.reference)) : undefined,
      model: a.model ? String(a.model) : undefined,
      baseUrl: a['base-url'] ? String(a['base-url']) : undefined,
      credential: a.credential ? String(a.credential) : undefined,
      yes: a.yes === true,
    })
  },

  async export(a) {
    const dir = dirOf(a)
    const manifest = await loadManifest(dir)
    const src = projectPaths(dir).artifact
    if (!existsSync(src)) throw new StudioError('还没有 dist/index.html，请先 build', 'NOT_BUILT')
    const html = await readFile(src, 'utf8')
    const externalRefs = [
      /<script[^>]+src=/iu,
      /<link[^>]+href=/iu,
      /<img[^>]+src=["']https?:/iu,
      /<iframe[^>]+src=/iu,
    ].filter((re) => re.test(html)).map((re) => String(re))
    const out = a.out ? resolve(String(a.out)) : join(dir, `${slug(manifest.title)}-offline.html`)
    await atomicWrite(out, html)
    return {
      ok: true, command: 'export', out, bytes: Buffer.byteLength(html),
      offline: externalRefs.length === 0, externalRefs,
      title: manifest.title,
    }
  },

  async share(a) {
    const dir = dirOf(a)
    const seconds = Number(a.seconds || 1800)
    const info = await startShare({
      dir, artifact: projectPaths(dir).artifact,
      seconds, port: Number(a.port || 0),
    })
    const printable = { ...info, qrSvg: undefined }
    process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`)
    if (a['no-wait'] !== true) await info.wait()
    await info.close()
    return null
  },

  async list(a) {
    const root = a.root ? resolve(String(a.root)) : resolve(process.cwd())
    const games = await scanGames(root)
    return {
      ok: true, command: 'list', root, count: games.length,
      games: games.map((g) => ({
        dir: g.dir, title: g.title, kind: g.kind, built: g.built,
        versions: g.versions, artifact: g.built ? g.artifact : null,
        cover: g.cover,
      })),
    }
  },

  async versions(a) {
    const dir = dirOf(a)
    let history = []
    try { history = JSON.parse(await readFile(projectPaths(dir).versionsJson, 'utf8')) }
    catch { /* none yet */ }
    return { ok: true, command: 'versions', dir, count: history.length, versions: history }
  },

  async restore(a) {
    const dir = dirOf(a)
    const id = String(a.id || '')
    if (!/^[0-9a-f]{12}$/u.test(id)) throw new StudioError('restore 需要 --id（12 位构建号）', 'BAD_ARGS')
    const snap = projectPaths(dir).versionDir(id)
    if (!existsSync(join(snap, 'game.json'))) throw new StudioError(`找不到版本 ${id}`, 'NO_VERSION')
    await copyFile(join(snap, 'game.json'), join(dir, 'game.json'))
    await copyFile(join(snap, 'game.js'), join(dir, 'game.js'))
    if (existsSync(join(snap, 'assets'))) await cp(join(snap, 'assets'), join(dir, 'assets'), { recursive: true })
    const manifest = await loadManifest(dir)
    const html = await renderHtml(dir, manifest)
    await atomicWrite(projectPaths(dir).artifact, html)
    return { ok: true, command: 'restore', dir, id, rebuilt: projectPaths(dir).artifact, bytes: Buffer.byteLength(html) }
  },

  async wall(a) {
    return COMMANDS['export-wall']({ ...a, _: ['export-wall'] })
  },

  async 'export-wall'(a) {
    const root = a.root ? resolve(String(a.root)) : resolve(process.cwd())
    const out = a.out ? resolve(String(a.out)) : join(root, 'wall.html')
    return buildWall({
      root, out,
      filter: String(a.filter || 'all'),
      sort: String(a.sort || 'recent'),
      title: String(a.title || 'My games'),
    })
  },

  async locale() {
    const files = {}
    for (const lang of LANGS) {
      try { files[lang] = JSON.parse(await readFile(join(ROOT, 'locale', `${lang}.json`), 'utf8')) }
      catch { files[lang] = null }
    }
    return { ok: true, command: 'locale', default: 'zh', languages: LANGS, files }
  },
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  if (!command || !COMMANDS[command]) {
    throw new StudioError(`用法: studio.mjs <${Object.keys(COMMANDS).join('|')}> [--dir DIR] [选项]`, 'BAD_ARGS')
  }
  const result = await COMMANDS[command](args)
  if (result !== null) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (result.ok === false) process.exitCode = 1
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: error.message,
    code: error.code || 'ERROR',
  }, null, 2)}\n`)
  process.exitCode = 1
})
