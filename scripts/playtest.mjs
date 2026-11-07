/**
 * Self-playing playtest. Drives the built game in headless Chrome over CDP,
 * samples __gameState(), reports phases / score / hearts / fps / errors and
 * writes screenshots plus a cover image used by the game wall.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { launchBrowser, KEYS, BrowserError } from './browser.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const DIRECTIONS = [KEYS.ArrowUp, KEYS.ArrowLeft, KEYS.ArrowDown, KEYS.ArrowRight]

function chooseDirection(state, tick) {
  const hero = state?.hero
  const pickups = Array.isArray(state?.pickups) ? state.pickups : []
  if (!hero || !pickups.length) return DIRECTIONS[tick % DIRECTIONS.length]
  let target = pickups[0]
  let best = Infinity
  for (const p of pickups) {
    const d = (p.x - hero.x) ** 2 + (p.y - hero.y) ** 2
    if (d < best) { best = d; target = p }
  }
  const dx = target.x - hero.x
  const dy = target.y - hero.y
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? KEYS.ArrowRight : KEYS.ArrowLeft
  return dy > 0 ? KEYS.ArrowDown : KEYS.ArrowUp
}

function round(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : value
}

export async function runPlaytest({ dir, artifact, seconds = 8, portrait = false, characters = false }) {
  const width = portrait ? 420 : 960
  const height = portrait ? 720 : 640
  const session = await launchBrowser({ width, height })
  const started = Date.now()
  const phases = []
  const fpsSamples = []
  const samples = []
  let bestScore = 0
  let lastHearts = null
  let cover = null
  let charactersOut = {}
  let autoplay = false

  try {
    await session.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__wbErrors=[];window.addEventListener('error',function(e){window.__wbErrors.push(String(e.message||e))});window.addEventListener('unhandledrejection',function(e){window.__wbErrors.push(String(e.reason&&e.reason.message||e.reason))});try{Object.defineProperty(document,'hidden',{configurable:true,get:function(){return false}});Object.defineProperty(document,'visibilityState',{configurable:true,get:function(){return 'visible'}})}catch(e){}window.addEventListener('blur',function(e){e.stopImmediatePropagation()},true);window.__wbFrames=0;(function tick(){window.__wbFrames++;requestAnimationFrame(tick)})();`,
    })
    await session.goto(artifact)
    // WebGL scenes can take a few seconds to finish initialising; wait until
    // __gameState is callable before starting the clock.
    const readyDeadline = Date.now() + 12000
    let initialState = null
    while (Date.now() < readyDeadline) {
      try { initialState = await session.eval('window.__gameState ? window.__gameState() : null') }
      catch { /* still initialising */ }
      if (initialState && typeof initialState === 'object') break
      await sleep(200)
    }
    if (initialState?.phase) phases.push({ phase: initialState.phase, at: 0 })
    autoplay = await session.eval('typeof window.__autoplay === "function"')
    await session.key(KEYS.Enter)
    await sleep(300)

    const playStart = Date.now()
    let tick = 0
    let lastFrames = await session.eval('window.__wbFrames || 0')
    let lastFrameAt = playStart
    const deadline = playStart + Math.max(2, Math.min(seconds, 120)) * 1000

    while (Date.now() < deadline) {
      let state = null
      try { state = await session.eval('window.__gameState ? window.__gameState() : null') } catch { /* page busy */ }
      if (state) {
        const phase = state.phase ?? 'unknown'
        if (phases.at(-1)?.phase !== phase) phases.push({ phase, at: round((Date.now() - started) / 1000) })
        const score = Number(state.score) || 0
        if (score > bestScore) bestScore = score
        if (state.hearts !== undefined) lastHearts = state.hearts
        samples.push({ t: round((Date.now() - started) / 1000), phase, score, hearts: state.hearts ?? null, fps: round(state.fps) })
        if (state.fps !== undefined) fpsSamples.push(Number(state.fps) || 0)
      }

      if (autoplay) {
        try { await session.eval('window.__autoplay(window.__gameState ? window.__gameState() : {})') }
        catch { /* a broken autoplay should not abort the playtest */ }
      } else {
        await session.key(chooseDirection(state, tick))
      }

      if (!cover && Date.now() - started > Math.min(2500, seconds * 400)) {
        cover = await session.shot({ format: 'jpeg', quality: 82 })
      }
      const frames = await session.eval('window.__wbFrames || 0')
      const now = Date.now()
      if (now > lastFrameAt) {
        const measured = ((frames - lastFrames) * 1000) / (now - lastFrameAt)
        if (measured > 0 && measured < 1000) fpsSamples.push(measured)
      }
      lastFrames = frames
      lastFrameAt = now
      tick += 1
      await sleep(160)
    }

    if (!cover) cover = await session.shot({ format: 'jpeg', quality: 82 })
    const frame = await session.shot({ format: 'png' })
    if (characters) {
      try {
        const renders = await session.eval('window.__renderSlots ? window.__renderSlots(256) : {}')
        if (renders && typeof renders === 'object') charactersOut = renders
      } catch { /* optional */ }
    }
    const pageErrors = await session.eval('window.__wbErrors || []')
    const errorList = [...new Set([...session.errors, ...(Array.isArray(pageErrors) ? pageErrors : [])])].slice(0, 20)

    const id = createHash('sha256').update(`${dir}:${Date.now()}`).digest('hex').slice(0, 12)
    const outDir = join(dir, '.studio', 'playtests', id)
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, 'frame.png'), frame)
    await writeFile(join(outDir, 'cover.jpg'), cover)
    await writeFile(join(dir, '.studio', 'cover.jpg'), cover)
    const characterFiles = []
    for (const [slot, dataUrl] of Object.entries(charactersOut)) {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) continue
      const file = join(outDir, `character-${slot}.png`)
      await writeFile(file, Buffer.from(dataUrl.split(',')[1], 'base64'))
      characterFiles.push(file)
    }

    const fps = fpsSamples.filter((v) => Number.isFinite(v) && v > 0)
    const report = {
      ok: true,
      command: 'playtest',
      dir,
      id,
      duration: round((Date.now() - playStart) / 1000),
      startupMs: playStart - started,
      viewport: { width, height, orientation: portrait ? 'portrait' : 'landscape' },
      autoplay,
      phases,
      bestScore,
      hearts: lastHearts,
      fps: {
        avg: fps.length ? round(fps.reduce((a, b) => a + b, 0) / fps.length) : null,
        min: fps.length ? round(Math.min(...fps)) : null,
        max: fps.length ? round(Math.max(...fps)) : null,
      },
      samples: samples.length,
      errors: errorList,
      errorCount: errorList.length,
      renderer: await session.eval('window.__gameState ? (window.__gameState().renderer || "canvas/webgl") : "none"').catch(() => 'none'),
      screenshot: join(outDir, 'frame.png'),
      cover: join(dir, '.studio', 'cover.jpg'),
      characters: characterFiles,
      reportFile: join(outDir, 'report.json'),
    }
    await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(join(dir, '.studio', 'playtest.json'), `${JSON.stringify(report, null, 2)}\n`)
    return report
  } finally {
    await session.close()
  }
}

export { BrowserError }
