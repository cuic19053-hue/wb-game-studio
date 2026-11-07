import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findChrome } from '../scripts/browser.mjs'
import { startShare } from '../scripts/share.mjs'

const hasChrome = (() => {
  if (process.env.WB_SKIP_BROWSER === '1') return false
  try { findChrome(); return true } catch { return false }
})()
const skipBrowser = hasChrome ? false : 'no Chrome/Edge found (set CHROME_PATH to enable browser tests)'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STUDIO = join(ROOT, 'scripts', 'studio.mjs')

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.NODE_OPTIONS // WorkBuddy sandbox shim blocks mkdir with a fake EEXIST
  delete env.OPENAI_API_KEY // keep provider tests deterministic
  delete env.OPENAI_BASE_URL
  return env
}

function run(...args) {
  const stdout = execFileSync(process.execPath, [STUDIO, ...args], {
    env: childEnv(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180000,
  })
  return JSON.parse(stdout)
}

/** For commands that intentionally exit 1 (e.g. the missing-credential guard). */
function runMaybe(...args) {
  const result = spawnSync(process.execPath, [STUDIO, ...args], {
    env: childEnv(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180000,
  })
  return { status: result.status, body: JSON.parse(result.stdout) }
}

async function workspace() {
  return mkdtemp(join(tmpdir(), 'wb-game-studio-'))
}

function httpRequest(url, method = 'GET') {
  return new Promise((done, fail) => {
    const req = http.request(url, { method }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => done({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', fail)
    req.end()
  })
}

/* A deterministic 64x64 RGBA PNG: white background, orange square in the
   middle. Corner sampling must key out the white and leave a transparent
   sprite, so the AI-art path can be tested without spending any credits. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function solidSprite(size = 64) {
  const raw = Buffer.alloc(size * (1 + size * 4))
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 4)
    raw[row] = 0 // filter: none
    for (let x = 0; x < size; x += 1) {
      const i = row + 1 + x * 4
      const inner = x > size * 0.3 && x < size * 0.7 && y > size * 0.3 && y < size * 0.7
      raw[i] = inner ? 230 : 255
      raw[i + 1] = inner ? 120 : 255
      raw[i + 2] = inner ? 40 : 255
      raw[i + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const HTML_MUST_HAVE = ['<canvas id="game"', 'Content-Security-Policy', 'window.GAME=']
const NO_EXTERNAL = /<script[^>]+src=|<link[^>]+href=|<iframe[^>]+src=/iu

test('2D collector: create, build, export one offline HTML', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'fox')

  const created = run('create', '--dir', dir, '--template', 'collector', '--title', '月夜狐·提灯',
    '--rules', '{"duration":60,"hearts":3}', '--slots', '{"hero":{"label":"小狐狸"}}')
  assert.equal(created.ok, true)
  assert.equal(created.template, 'collector')

  const built = run('build', '--dir', dir, '--note', 'first')
  assert.equal(built.ok, true)
  assert.equal(built.versionSaved, true)
  assert.ok(built.bytes > 10000 && built.bytes < 200000, `unexpected 2D size: ${built.bytes}`)
  assert.deepEqual(built.customSlots, [])

  const html = await readFile(built.artifact, 'utf8')
  for (const needle of HTML_MUST_HAVE) assert.ok(html.includes(needle), `missing ${needle}`)
  assert.ok(html.includes('月夜狐·提灯'))
  assert.doesNotMatch(html, NO_EXTERNAL)

  const exported = run('export', '--dir', dir)
  assert.equal(exported.offline, true)
  assert.deepEqual(exported.externalRefs, [])
  assert.equal(exported.bytes, built.bytes)
})

test('3D voxel: three.js is inlined and the build stays offline', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'isle')

  assert.equal(run('create', '--dir', dir, '--template', 'voxel', '--title', '体素岛·提灯').ok, true)
  const built = run('build', '--dir', dir)
  assert.deepEqual(built.runtime, ['three'])
  assert.ok(built.bytes > 600000, `three.js was not inlined: ${built.bytes}`)

  const html = await readFile(built.artifact, 'utf8')
  assert.ok(html.includes('window.THREE') || html.includes('THREE =') || html.includes('THREE.REVISION'),
    'three.js global not found in artifact')
  assert.ok(html.includes('<script id="wb-three-runtime">'), 'three.js runtime is not tagged for wall sharing')
  assert.doesNotMatch(html, NO_EXTERNAL)
  assert.equal(run('export', '--dir', dir, '--out', join(root, 'isle.html')).offline, true)
})

test('life simulator: create with rules, build one offline HTML', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'life')

  const created = run('create', '--dir', dir, '--template', 'lifesim', '--title', '我的人生模拟器',
    '--rules', '{"name":"小红","startGrade":5,"dream":"北京大学","hobby":"跳舞"}')
  assert.equal(created.ok, true)
  assert.equal(created.template, 'lifesim')
  assert.deepEqual(created.slots, ['hero'])

  const built = run('build', '--dir', dir)
  assert.equal(built.ok, true)
  assert.ok(built.bytes > 20000 && built.bytes < 200000, `unexpected lifesim size: ${built.bytes}`)
  const html = await readFile(built.artifact, 'utf8')
  for (const needle of HTML_MUST_HAVE) assert.ok(html.includes(needle), `missing ${needle}`)
  for (const needle of ['小红', '北京大学', '跳舞']) assert.ok(html.includes(needle), `rule did not reach the page: ${needle}`)
  assert.doesNotMatch(html, NO_EXTERNAL)
  assert.equal(run('export', '--dir', dir).offline, true)
})

test('playtest: life simulator plays itself from grade 5 to the university result',
  { skip: skipBrowser }, async (t) => {
    const root = await workspace()
    t.after(() => rm(root, { recursive: true, force: true }))
    const dir = join(root, 'lifeplay')
    run('create', '--dir', dir, '--template', 'lifesim', '--title', 'Life playtest', '--rules', '{"seed":7}')
    run('build', '--dir', dir)

    const report = run('playtest', '--dir', dir, '--seconds', '8', '--characters')
    assert.equal(report.ok, true)
    assert.equal(report.autoplay, true, 'lifesim must provide window.__autoplay')
    assert.equal(report.errorCount, 0, `script errors: ${JSON.stringify(report.errors)}`)
    const phases = report.phases.map((p) => p.phase)
    assert.ok(phases.includes('playing') && phases.includes('won'), `never reached the ending: ${phases}`)
    assert.ok(report.bestScore >= 200, `no gaokao score reported: ${report.bestScore}`)
    assert.ok((await stat(report.screenshot)).size > 0)
  })

test('custom art is detected by hashing slot files, no registration needed', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'art')
  run('create', '--dir', dir, '--template', 'collector')
  assert.deepEqual(run('build', '--dir', dir).customSlots, [])

  await copyFile(join(dir, 'assets', 'enemy.svg'), join(dir, 'assets', 'hero.svg'))
  const rebuilt = run('build', '--dir', dir)
  assert.deepEqual(rebuilt.customSlots, ['hero'])
  const html = await readFile(rebuilt.artifact, 'utf8')
  assert.ok(html.includes('"custom":true'), 'custom flag not passed to window.GAME')
})

test('versions: restore brings back code, rules and art together', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'versions')
  run('create', '--dir', dir, '--template', 'collector', '--title', '第一版')
  const first = run('build', '--dir', dir, '--note', 'first')

  const manifestPath = join(dir, 'game.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.title = '第二版'
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const second = run('build', '--dir', dir, '--note', 'second')
  assert.notEqual(second.buildId, first.buildId)

  const history = run('versions', '--dir', dir)
  assert.equal(history.count, 2)

  const restored = run('restore', '--dir', dir, '--id', first.buildId)
  assert.equal(restored.ok, true)
  const html = await readFile(restored.rebuilt, 'utf8')
  assert.ok(html.includes('第一版'))
  assert.ok(!html.includes('第二版'))
})

test('list finds every built project under a root', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [name, template] of [['a', 'collector'], ['b', 'voxel']]) {
    const dir = join(root, name)
    run('create', '--dir', dir, '--template', template, '--title', name)
    run('build', '--dir', dir)
  }
  const result = run('list', '--root', root)
  assert.equal(result.count, 2)
  assert.deepEqual(result.games.map((g) => g.kind).sort(), ['2D', '3D'])
  assert.ok(result.games.every((g) => g.built === true))
})

test('locale: en/zh resources exist and build-time i18n swaps the UI strings', async (t) => {
  const langs = run('locale')
  assert.deepEqual(langs.languages, ['zh', 'en'])
  assert.equal(langs.default, 'zh')
  assert.ok(langs.files.zh?.meta?.title && langs.files.en?.meta?.title)

  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const zh = join(root, 'zh')
  const en = join(root, 'en')

  run('create', '--dir', zh, '--template', 'collector', '--lang', 'zh', '--title', 'Lantern ZH')
  const zhBuilt = run('build', '--dir', zh)
  assert.equal(zhBuilt.lang, 'zh')
  const zhHtml = await readFile(zhBuilt.artifact, 'utf8')
  assert.ok(zhHtml.includes('按任意键'), 'zh build lost its Chinese prompt')
  assert.ok(zhHtml.includes('"lang":"zh"'))

  run('create', '--dir', en, '--template', 'collector', '--lang', 'en',
    '--orientation', 'portrait', '--title', 'Lantern EN')
  const enBuilt = run('build', '--dir', en)
  assert.equal(enBuilt.lang, 'en')
  assert.equal(enBuilt.orientation, 'portrait')
  const enHtml = await readFile(enBuilt.artifact, 'utf8')
  assert.ok(enHtml.includes('Press any key / tap to start'), 'en build was not localised')
  assert.ok(!enHtml.includes('按任意键'), 'Chinese strings leaked into the en build')
  assert.ok(enHtml.includes('"orientation":"portrait"') && enHtml.includes('"lang":"en"'))
  assert.ok(enHtml.includes('min(100vw,56.25vh)'), 'portrait CSS was not injected')
  assert.ok(enHtml.includes('<html lang="en">'))
  assert.notEqual(zhBuilt.buildId, enBuilt.buildId, 'locale/orientation must change the artifact')
  assert.doesNotMatch(enHtml, NO_EXTERNAL)
})

test('playtest: 2D portrait run samples state, writes screenshots and reports no errors',
  { skip: skipBrowser }, async (t) => {
    const root = await workspace()
    t.after(() => rm(root, { recursive: true, force: true }))
    const dir = join(root, 'play2d')
    run('create', '--dir', dir, '--template', 'collector', '--title', 'Playtest 2D',
      '--orientation', 'portrait')
    run('build', '--dir', dir)

    const report = run('playtest', '--dir', dir, '--seconds', '2', '--portrait', '--characters')
    assert.equal(report.ok, true)
    assert.equal(report.viewport.orientation, 'portrait')
    assert.deepEqual(report.viewport, { width: 420, height: 720, orientation: 'portrait' })
    assert.ok(report.samples > 0, 'no state samples were collected')
    assert.ok(report.phases.length > 0, 'no phase transitions were observed')
    assert.ok(report.fps.avg > 0, 'fps was not measured')
    assert.equal(report.errorCount, 0, `script errors: ${JSON.stringify(report.errors)}`)
    for (const file of [report.screenshot, report.cover, report.reportFile]) {
      assert.ok((await stat(file)).size > 0, `empty playtest artifact: ${file}`)
    }
    assert.ok(Array.isArray(report.characters))
    assert.equal(run('list', '--root', root).games[0].cover !== null, true)
  })

test('playtest: 3D WebGL run waits for startup and samples the scene',
  { skip: skipBrowser }, async (t) => {
    const root = await workspace()
    t.after(() => rm(root, { recursive: true, force: true }))
    const dir = join(root, 'play3d')
    run('create', '--dir', dir, '--template', 'voxel', '--title', 'Playtest 3D')
    run('build', '--dir', dir)

    const report = run('playtest', '--dir', dir, '--seconds', '2')
    assert.equal(report.ok, true)
    assert.ok(report.startupMs > 0, 'startup wait was not recorded')
    // WebGL init is slow; the whole point is that samples are non-zero anyway.
    assert.ok(report.samples > 0, '3D scene never became ready')
    assert.equal(report.errorCount, 0, `script errors: ${JSON.stringify(report.errors)}`)
    assert.ok((await stat(report.screenshot)).size > 0)
  })

test('asset generate: builtin hands off to the host, OpenAI requires a cost approval',
  async (t) => {
    const root = await workspace()
    t.after(() => rm(root, { recursive: true, force: true }))
    const dir = join(root, 'assets')
    run('create', '--dir', dir, '--template', 'collector')

    const builtin = run('asset', 'generate', '--dir', dir, '--slot', 'hero', '--provider', 'builtin', '--count', '2')
    assert.equal(builtin.ok, true)
    assert.equal(builtin.handoff, true)
    assert.equal(builtin.generated, 0, 'CLI must not fake host-generated images')
    assert.ok(builtin.instruction.includes('asset stage'))

    const auto = run('asset', 'generate', '--dir', dir, '--slot', 'hero', '--provider', 'auto')
    assert.equal(auto.provider, 'builtin', 'auto should fall back to builtin without a key')

    const guarded = runMaybe('asset', 'generate', '--dir', dir, '--slot', 'hero',
      '--provider', 'openai', '--count', '2', '--prompt', 'a fox with a lantern')
    assert.equal(guarded.status, 1)
    assert.equal(guarded.body.ok, false)
    assert.equal(guarded.body.code, 'NO_CREDENTIAL')
    assert.equal(guarded.body.card.approvalRequired, true)
    assert.equal(guarded.body.card.imageCount, 2)
    assert.ok(guarded.body.card.estimatedCostUsd > 0)
    // No network call and no candidate files may be produced by the guard.
    assert.deepEqual(run('asset', 'list', '--dir', dir).slots.hero, [])
  })

test('asset stage/apply/revert: transparent background, numbered candidates and rollback',
  { skip: skipBrowser }, async (t) => {
    const root = await workspace()
    t.after(() => rm(root, { recursive: true, force: true }))
    const dir = join(root, 'hero')
    run('create', '--dir', dir, '--template', 'collector', '--title', 'AI Hero')
    run('build', '--dir', dir)
    const sprite = join(root, 'sprite.png')
    await writeFile(sprite, solidSprite())

    const staged = run('asset', 'stage', '--dir', dir, '--slot', 'hero',
      '--file', sprite, '--label', '测试角色', '--prompt', 'orange fox with a lantern')
    assert.equal(staged.ok, true)
    assert.equal(staged.candidates, 1)
    assert.equal(staged.candidate.number, 1)
    assert.equal(staged.candidate.transparent, true)
    assert.equal(staged.candidate.backgroundRemoved, true, 'light background was not keyed out')
    assert.ok(staged.candidate.transparentRatio > 0.3)
    assert.ok((await stat(staged.candidate.file)).size > 0)

    const listed = run('asset', 'list', '--dir', dir)
    assert.equal(listed.slots.hero.length, 1)
    assert.equal(listed.slots.hero[0].label, '测试角色')

    const applied = run('asset', 'apply', '--dir', dir, '--slot', 'hero', '--number', '1')
    assert.equal(applied.ok, true)
    assert.equal(applied.custom, true)
    assert.equal(applied.file, 'assets/hero.png')
    assert.ok(applied.rebuilt.customSlots.includes('hero'), 'rebuild did not flag custom art')
    const manifest = JSON.parse(await readFile(join(dir, 'game.json'), 'utf8'))
    assert.equal(manifest.slots.hero.file, 'assets/hero.png')
    const html = await readFile(join(dir, 'dist', 'index.html'), 'utf8')
    assert.ok(html.includes('"custom":true'))

    const reverted = run('asset', 'revert', '--dir', dir, '--slot', 'hero')
    assert.equal(reverted.ok, true)
    assert.equal(reverted.restoredFile, 'assets/hero.svg')
    assert.equal(reverted.remaining, 0)
    assert.ok(!reverted.rebuilt.customSlots.includes('hero'), 'rollback left custom art behind')
  })

test('wall: filters, sorts, excludes unbuilt games and shares one three.js runtime', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [name, template, title] of [
    ['alpha', 'collector', 'Alpha 2D'],
    ['beta', 'voxel', 'Beta 3D'],
    ['gamma', 'collector', 'Gamma unbuilt'],
  ]) {
    const dir = join(root, name)
    run('create', '--dir', dir, '--template', template, '--title', title)
    if (name !== 'gamma') run('build', '--dir', dir)
  }

  const out = join(root, 'wall.html')
  const wall = run('wall', '--root', root, '--out', out, '--title', 'My Shelf')
  assert.equal(wall.ok, true)
  assert.equal(wall.included, 2)
  assert.equal(wall.excluded.length, 1)
  assert.equal(wall.excluded[0].reason, 'not built')
  assert.equal(wall.sharedThree, true)

  const html = await readFile(out, 'utf8')
  assert.doesNotMatch(html, NO_EXTERNAL)
  assert.ok(html.includes('<script id="wall-data" type="application/json">'))
  assert.ok(html.includes('srcdoc') && html.includes('Escape'))
  assert.ok(html.includes('Alpha 2D') && html.includes('Beta 3D'))
  assert.ok(!html.includes('Gamma unbuilt'), 'unbuilt game leaked into the wall')
  assert.equal((html.match(/wb-three-runtime/gu) || []).length, 1,
    'three.js must be packed once and reused by every 3D tile')

  const only2d = run('wall', '--root', root, '--out', join(root, '2d-wall.html'), '--filter', '2d')
  assert.equal(only2d.included, 1)
  assert.equal(only2d.sharedThree, false)
  assert.deepEqual(only2d.games.map((g) => g.kind), ['2D'])

  const byName = run('export-wall', '--root', root, '--out', join(root, 'named.html'), '--sort', 'name')
  assert.equal(byName.ok, true)
  assert.equal(byName.sort, 'name')
  assert.deepEqual(byName.games.map((g) => g.title), ['Alpha 2D', 'Beta 3D'])
})

test('share: read-only GET/HEAD only, QR code, 404/405 handling and auto-expiry fields', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'shared')
  run('create', '--dir', dir, '--template', 'collector', '--title', 'Shared Game')
  const built = run('build', '--dir', dir)
  const artifact = await readFile(built.artifact, 'utf8')

  const info = await startShare({
    dir, artifact: built.artifact, seconds: 30, port: 0, host: '127.0.0.1',
  })
  t.after(() => info.close())
  assert.equal(info.ok, true)
  assert.equal(info.readOnly, true)
  assert.match(info.url, /^http:\/\/.+:\d+\/\?t=[0-9a-f]{10}$/u)
  assert.ok(Date.parse(info.expiresAt) > Date.now())

  const qr = await readFile(info.qr, 'utf8')
  assert.ok(qr.startsWith('<svg') && qr.includes('<rect'), 'QR code is not an SVG')

  const get = await httpRequest(info.localUrl, 'GET')
  assert.equal(get.status, 200)
  assert.equal(get.body, artifact)
  assert.ok(String(get.headers['content-security-policy']).includes("default-src 'none'"))
  assert.equal(get.headers['cache-control'], 'no-store')

  const head = await httpRequest(info.localUrl, 'HEAD')
  assert.equal(head.status, 200)
  assert.equal(head.body, '')

  const post = await httpRequest(info.localUrl, 'POST')
  assert.equal(post.status, 405)
  const missing = await httpRequest(`${info.localUrl.split('?')[0]}missing`, 'GET')
  assert.equal(missing.status, 404)
  assert.ok(info.connections() >= 3)
})

test('share CLI with --no-wait prints one JSON object and closes immediately', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'cli-share')
  run('create', '--dir', dir, '--template', 'collector')
  run('build', '--dir', dir)
  const info = run('share', '--dir', dir, '--seconds', '2', '--no-wait')
  assert.equal(info.ok, true)
  assert.equal(info.readOnly, true)
  assert.equal(info.seconds, 2)
  assert.ok(info.qr && info.url && info.expiresAt)
  assert.equal(info.qrSvg, undefined, 'the raw SVG must not be dumped into CLI JSON')
  assert.ok((await stat(info.qr)).size > 0)
})
