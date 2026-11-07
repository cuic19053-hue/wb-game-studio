/**
 * Art slots, numbered candidates, spending approval and image providers.
 *
 * Three ways to produce a candidate:
 *   builtin  - the WorkBuddy skill generates the picture and calls `asset stage`
 *   openai   - OpenAI image API (or any compatible gateway), with a cost card
 *   codex    - the local Codex CLI, charged to the Codex plan
 * Candidates are checked for a transparent background and framing, fitted to
 * the slot, then offered by number; apply/revert keep a ledger for rollback.
 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchBrowser } from './browser.mjs'

const execFileAsync = promisify(execFile)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export class AssetError extends Error {
  constructor(message, code = 'ASSET') { super(message); this.code = code }
}

const CANDIDATES_DIR = (dir, slot) => join(dir, '.studio', 'candidates', slot)
const CANDIDATES_JSON = (dir, slot) => join(CANDIDATES_DIR(dir, slot), 'candidates.json')
const LEDGER = (dir) => join(dir, '.studio', 'assets.json')
const BACKUPS = (dir) => join(dir, '.studio', 'asset-backups')

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function loadManifest(dir) {
  try { return JSON.parse(await readFile(join(dir, 'game.json'), 'utf8')) }
  catch { throw new AssetError('找不到 game.json', 'NO_PROJECT') }
}

async function saveManifest(dir, manifest) {
  await writeFile(join(dir, 'game.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function dataUrl(file, bytes) {
  const ext = extname(file).toLowerCase()
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream'
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/** Fit an image to 256x256 on a transparent canvas and inspect its framing. */
export async function stageCandidate({ dir, slot, file, label, source = 'external', prompt, cost }) {
  const manifest = await loadManifest(dir)
  const spec = manifest.slots?.[slot]
  if (!spec) throw new AssetError(`未知美术槽位 "${slot}"，可选: ${Object.keys(manifest.slots || {}).join(', ')}`, 'BAD_SLOT')
  if (!file || !existsSync(file)) throw new AssetError(`素材文件不存在: ${file || '(空)'}`, 'NO_FILE')

  const bytes = await readFile(file)
  const session = await launchBrowser({ width: 256, height: 256 })
  let inspection
  try { inspection = await session.inspectImage(dataUrl(file, bytes), 256, spec.transparent !== false) }
  finally { await session.close() }
  if (!inspection?.fitted) throw new AssetError('浏览器无法解码这张图片', 'BAD_IMAGE')

  const folder = CANDIDATES_DIR(dir, slot)
  await mkdir(folder, { recursive: true })
  const list = await readJson(CANDIDATES_JSON(dir, slot), [])
  const number = list.length + 1
  const candidateFile = join(folder, `${String(number).padStart(2, '0')}.png`)
  await writeFile(candidateFile, Buffer.from(inspection.fitted.split(',')[1], 'base64'))
  const entry = {
    number,
    label: label || spec.label || slot,
    file: candidateFile,
    source,
    prompt: prompt || null,
    cost: cost ?? null,
    createdAt: new Date().toISOString(),
    original: { file, width: inspection.width, height: inspection.height },
    transparentRatio: Math.round((inspection.transparentRatio ?? 0) * 1000) / 1000,
    transparent: (inspection.transparentRatio ?? 0) > 0.15,
    backgroundRemoved: Boolean(inspection.backgroundRemoved),
    slotSize: spec.size || [256, 256],
  }
  list.push(entry)
  await writeJson(CANDIDATES_JSON(dir, slot), list)
  return {
    ok: true, command: 'asset stage', slot, candidate: entry,
    warning: entry.transparent
      ? (entry.backgroundRemoved ? '已自动抠掉浅色背景并缩放到槽位尺寸' : null)
      : '角色图仍带不透明背景；建议换一张透明底图片，或在生成时指定 background: transparent',
    candidates: list.length,
  }
}

export async function listCandidates({ dir, slot }) {
  const manifest = await loadManifest(dir)
  const slots = slot ? [slot] : Object.keys(manifest.slots || {})
  const out = {}
  for (const name of slots) {
    out[name] = await readJson(CANDIDATES_JSON(dir, name), [])
  }
  return { ok: true, command: 'asset list', dir, slots: out }
}

export async function applyCandidate({ dir, slot, number }) {
  const manifest = await loadManifest(dir)
  const spec = manifest.slots?.[slot]
  if (!spec) throw new AssetError(`未知美术槽位 "${slot}"`, 'BAD_SLOT')
  const list = await readJson(CANDIDATES_JSON(dir, slot), [])
  const candidate = number ? list.find((c) => c.number === Number(number)) : list.at(-1)
  if (!candidate) throw new AssetError(`槽位 ${slot} 没有编号 ${number || '最新'} 的候选`, 'NO_CANDIDATE')

  const ledger = await readJson(LEDGER(dir), {})
  const stack = ledger[slot] || []
  const oldFile = join(dir, spec.file)
  await mkdir(BACKUPS(dir), { recursive: true })
  const backup = join(BACKUPS(dir), `${slot}-${Date.now()}${extname(spec.file)}`)
  if (existsSync(oldFile)) await copyFile(oldFile, backup)
  stack.push({ file: spec.file, backup: existsSync(oldFile) ? backup : null, candidate: candidate.number, at: new Date().toISOString() })
  ledger[slot] = stack
  await writeJson(LEDGER(dir), ledger)

  const target = join(dir, 'assets', `${slot}.png`)
  await copyFile(candidate.file, target)
  spec.file = `assets/${slot}.png`
  await saveManifest(dir, manifest)
  return {
    ok: true, command: 'asset apply', slot, number: candidate.number,
    file: spec.file, custom: true, previous: stack.length > 1 ? stack.at(-2).file : 'template',
    note: '重新 build 后该槽会被自动标记为 custom',
  }
}

export async function revertSlot({ dir, slot }) {
  const manifest = await loadManifest(dir)
  const spec = manifest.slots?.[slot]
  if (!spec) throw new AssetError(`未知美术槽位 "${slot}"`, 'BAD_SLOT')
  const ledger = await readJson(LEDGER(dir), {})
  const stack = ledger[slot] || []
  if (!stack.length) throw new AssetError(`槽位 ${slot} 没有可回退的记录`, 'NOTHING_TO_REVERT')
  const last = stack.pop()
  if (last.backup && existsSync(last.backup)) {
    await copyFile(last.backup, join(dir, last.file))
  } else {
    const pristine = join(REPO_ROOT, 'assets', 'templates', manifest.template, last.file)
    if (existsSync(pristine)) await copyFile(pristine, join(dir, last.file))
  }
  spec.file = last.file
  ledger[slot] = stack
  await writeJson(LEDGER(dir), ledger)
  await saveManifest(dir, manifest)
  return { ok: true, command: 'asset revert', slot, restoredFile: spec.file, remaining: stack.length }
}

/** Cost card shown before any OpenAI spend. Set --yes to approve. */
export function costCard({ model, count, reference }) {
  const perImage = model.includes('mini') || model.includes('flare') ? 0.02 : 0.04
  const estimated = perImage * count * (reference ? 1.25 : 1)
  return {
    approvalRequired: true,
    service: 'openai',
    model,
    imageCount: count,
    reference: Boolean(reference),
    estimatedCostUsd: Math.round(estimated * 1000) / 1000,
    note: '估算值，实际以你的 OpenAI 账单为准。加 --yes 才会真正发起请求。',
  }
}

/** Generate candidates with the OpenAI image API using curl as transport (proxy-friendly). */
export async function generateOpenai({ dir, slot, count = 2, prompt, reference, model, baseUrl, credential, yes = false }) {
  const finalModel = model || process.env.OPENAI_MODEL || 'gpt-image-1'
  const key = credential ? process.env[credential] : (process.env.OPENAI_API_KEY || '')
  if (!key) {
    return {
      ok: false, code: 'NO_CREDENTIAL',
      error: '未找到 API key。设置 OPENAI_API_KEY，或用 --credential 指定环境变量名。',
      card: costCard({ model: finalModel, count, reference }),
    }
  }
  const card = costCard({ model: finalModel, count, reference })
  if (!yes) return { ok: true, command: 'asset generate', provider: 'openai', ...card, generated: 0 }

  const root = (baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/u, '')
  const endpoint = reference ? `${root}/images/edits` : `${root}/images/generations`
  const args = ['-sS', '--max-time', '180', '-X', 'POST', endpoint,
    '-H', `Authorization: Bearer ${key}`]
  const form = []
  form.push('-F', `model=${finalModel}`)
  form.push('-F', `prompt=${prompt || `a game character for slot ${slot}`}`)
  if (!reference) {
    form.push('-F', `n=${count}`)
    form.push('-F', 'size=1024x1024')
    form.push('-F', 'response_format=b64_json')
  } else {
    form.push('-F', `image=@${reference}`)
    form.push('-F', `n=${count}`)
    form.push('-F', 'size=1024x1024')
  }
  let stdout
  try { ({ stdout } = await execFileAsync('curl', [...args, ...form], { maxBuffer: 32 * 1024 * 1024 })) }
  catch (error) { throw new AssetError(`OpenAI 请求失败: ${String(error.stderr || error.message).slice(0, 300)}`, 'PROVIDER_FAILED') }
  let payload
  try { payload = JSON.parse(stdout) }
  catch { throw new AssetError(`OpenAI 返回不是 JSON: ${stdout.slice(0, 200)}`, 'PROVIDER_FAILED') }
  if (payload.error) throw new AssetError(`OpenAI: ${payload.error.message}`, 'PROVIDER_FAILED')
  const images = (payload.data || []).map((d) => d.b64_json).filter(Boolean)
  if (!images.length) throw new AssetError('OpenAI 未返回图片数据', 'PROVIDER_FAILED')

  const staged = []
  for (let i = 0; i < images.length; i += 1) {
    const tmp = join(CANDIDATES_DIR(dir, slot), `raw-${Date.now()}-${i}.png`)
    await mkdir(CANDIDATES_DIR(dir, slot), { recursive: true })
    await writeFile(tmp, Buffer.from(images[i], 'base64'))
    staged.push(await stageCandidate({
      dir, slot, file: tmp, source: 'openai', prompt,
      label: `${slot} 候选 ${i + 1}`, cost: card.estimatedCostUsd / images.length,
    }))
  }
  return { ok: true, command: 'asset generate', provider: 'openai', approval: card, generated: staged.length, candidates: staged.map((s) => s.candidate.number) }
}

/** Generate candidates through the local Codex CLI (charged to the Codex plan, no API key). */
export async function generateCodex({ dir, slot, count = 1, prompt, command, timeoutMinutes = 15 }) {
  const bin = command || process.env.CODEX_PATH || 'codex'
  const outDir = join(CANDIDATES_DIR(dir, slot), 'codex')
  await mkdir(outDir, { recursive: true })
  const request = `Generate ${count} game sprite image(s) with a transparent background for the slot "${slot}". ${prompt || ''} Save them as PNG files inside ${outDir}. Do not write any other files.`
  try {
    await execFileAsync(bin, ['exec', '--skip-git-repo-check', request], {
      timeout: Math.max(1, timeoutMinutes) * 60 * 1000, maxBuffer: 8 * 1024 * 1024,
    })
  } catch (error) {
    throw new AssetError(`Codex CLI 调用失败: ${String(error.stderr || error.message).slice(0, 300)}`, 'PROVIDER_FAILED')
  }
  const files = (await readdir(outDir)).filter((f) => /\.(png|webp|jpg|jpeg)$/iu.test(f))
  if (!files.length) throw new AssetError('Codex 没有在输出目录生成图片', 'PROVIDER_FAILED')
  const staged = []
  for (const file of files) {
    staged.push(await stageCandidate({ dir, slot, file: join(outDir, file), source: 'codex', prompt, label: basename(file) }))
  }
  return { ok: true, command: 'asset generate', provider: 'codex', generated: staged.length, candidates: staged.map((s) => s.candidate.number) }
}

export function builtinHandoff({ dir, slot, count, prompt }) {
  return {
    ok: true,
    command: 'asset generate',
    provider: 'builtin',
    handoff: true,
    generated: 0,
    instruction: '由 WorkBuddy 用内置图像生成产出图片（建议 background: transparent、1024x1024），再执行 asset stage 投放为编号候选。CLI 不访问宿主模型，因此不伪造生成结果。',
    next: `asset stage --dir ${dir} --slot ${slot} --file <生成的图片路径> --label "${prompt || slot}"`,
    count, prompt: prompt || null,
  }
}
