import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STUDIO = join(ROOT, 'scripts', 'studio.mjs')

function run(...args) {
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  const stdout = execFileSync(process.execPath, [STUDIO, ...args], {
    env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'wb-game-studio-'))
  return dir
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
  assert.doesNotMatch(html, NO_EXTERNAL)
  assert.equal(run('export', '--dir', dir, '--out', join(root, 'isle.html')).offline, true)
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
