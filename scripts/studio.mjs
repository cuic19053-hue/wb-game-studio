#!/usr/bin/env node
/**
 * wb-game-studio - zero-dependency game project tool for WorkBuddy.
 *
 * Commands:
 *   create   --dir DIR --template collector|voxel [--title T] [--rules JSON] [--slots JSON] [--force]
 *   build    --dir DIR [--note TEXT]
 *   export   --dir DIR [--out FILE]
 *   list     [--root DIR]
 *   versions --dir DIR
 *   restore  --dir DIR --id BUILDID
 *
 * All commands print one JSON object to stdout. Run with `env -u NODE_OPTIONS`
 * on machines where the WorkBuddy sandbox shim intercepts directory creation.
 */
import { cp, copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATES = join(ROOT, 'assets', 'templates')
const VENDOR = join(ROOT, 'assets', 'vendor')
const MAX_ARTIFACT_BYTES = 24 * 1024 * 1024
const TEMPLATE_IDS = ['collector', 'voxel']

const CSP = [
  "default-src 'none'",
  'img-src data: blob:',
  'media-src data: blob:',
  "font-src data:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'none'",
  "form-action 'none'",
].join('; ')

const STYLE = 'html,body{margin:0;height:100%;overflow:hidden;background:#000}'
  + 'canvas{display:block;width:100vw;height:100vh;touch-action:none;outline:none}'

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

  let runtime = null
  if ((manifest.runtime || []).includes('three')) {
    try { runtime = await readFile(join(VENDOR, 'three.min.js'), 'utf8') }
    catch { throw new StudioError('缺少 assets/vendor/three.min.js，3D 模板无法构建', 'MISSING_RUNTIME') }
  }

  const game = {
    title: manifest.title || 'Untitled game',
    rules: manifest.rules || {},
    slots,
    assets,
  }
  const lines = [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `<title>${escapeHtml(game.title)}</title>`,
    `<style>${STYLE}</style></head><body><canvas id="game" tabindex="0"></canvas>`,
  ]
  if (runtime) lines.push(`<script>${inlineSafe(runtime)}</script>`)
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
    await atomicWrite(join(dir, 'game.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const ledger = Object.fromEntries(Object.keys(manifest.slots).map((k) => [k, { source: 'template' }]))
    await atomicWrite(join(dir, 'assets', 'ASSETS.json'), `${JSON.stringify(ledger, null, 2)}\n`)
    return {
      ok: true, command: 'create', dir, template, title: manifest.title,
      slots: Object.keys(manifest.slots),
      next: `env -u NODE_OPTIONS node ${join(ROOT, 'scripts', 'studio.mjs')} build --dir ${dir}`,
    }
  },

  async build(a) {
    const dir = a.dir ? resolve(String(a.dir)) : resolve(process.cwd())
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
      versionSaved: saved,
      versions: history.length,
      customSlots,
    }
  },

  async export(a) {
    const dir = a.dir ? resolve(String(a.dir)) : resolve(process.cwd())
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

  async list(a) {
    const root = a.root ? resolve(String(a.root)) : resolve(process.cwd())
    const found = []
    async function walk(dir, depth) {
      if (depth > 4 || found.length >= 60) return
      let entries
      try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
      if (entries.some((e) => e.name === 'game.json')) {
        try {
          const m = await readJson(join(dir, 'game.json'))
          found.push({
            dir: relative(root, dir) || '.',
            title: m.title || '(untitled)',
            kind: (m.runtime || []).includes('three') ? '3D' : '2D',
            built: existsSync(join(dir, 'dist', 'index.html')),
            artifact: existsSync(join(dir, 'dist', 'index.html')) ? join(dir, 'dist', 'index.html') : null,
          })
        } catch { /* skip broken projects */ }
        return
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
        await walk(join(dir, e.name), depth + 1)
      }
    }
    await walk(root, 0)
    return { ok: true, command: 'list', root, count: found.length, games: found }
  },

  async versions(a) {
    const dir = a.dir ? resolve(String(a.dir)) : resolve(process.cwd())
    let history = []
    try { history = JSON.parse(await readFile(projectPaths(dir).versionsJson, 'utf8')) }
    catch { /* none yet */ }
    return { ok: true, command: 'versions', dir, count: history.length, versions: history }
  },

  async restore(a) {
    const dir = a.dir ? resolve(String(a.dir)) : resolve(process.cwd())
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
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  if (!command || !COMMANDS[command]) {
    throw new StudioError(`用法: studio.mjs <${Object.keys(COMMANDS).join('|')}> [--dir DIR] [选项]`, 'BAD_ARGS')
  }
  const result = await COMMANDS[command](args)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: error.message,
    code: error.code || 'ERROR',
  }, null, 2)}\n`)
  process.exitCode = 1
})
