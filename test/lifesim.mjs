/* Balance + logic regression for the lifesim template. Runs game.js against a
 * stub DOM (no browser needed) and plays whole games with different habits, so
 * a future tweak cannot quietly make the game trivial or impossible. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CODE = readFileSync(join(ROOT, 'assets', 'templates', 'lifesim', 'game.js'), 'utf8')

function makeNode() {
  const n = { style: { setProperty() {} }, children: [] }
  n.appendChild = (c) => { n.children.push(c); return c }
  n.setAttribute = () => {}
  n.getAttribute = () => null
  n.querySelectorAll = () => []
  n.querySelector = () => makeNode()
  n.addEventListener = () => {}
  n.scrollIntoView = () => {}
  n.getContext = () => new Proxy(function () {}, {
    get: (_t, k) => (k === 'measureText' ? () => ({ width: 10 })
      : k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {}),
    set: () => true,
  })
  return n
}

/** Plays one game. strategy: smart | balanced | studyonly | nostudy | random */
export function play({ seed, strategy, difficulty = 1, startGrade = 5 }) {
  const handlers = []
  const queue = []
  let now = 0
  const document = {
    getElementById: () => makeNode(), createElement: () => makeNode(), createTextNode: (t) => ({ t }),
    body: makeNode(), head: makeNode(), documentElement: makeNode(),
    addEventListener: (type, fn) => { if (type === 'keydown') handlers.push(fn) },
  }
  const window = {
    GAME: { title: 't', rules: { seed, difficulty, startGrade }, slots: {}, assets: {} },
    addEventListener() {}, innerWidth: 1000, innerHeight: 700, devicePixelRatio: 1,
    localStorage: { getItem: () => null, setItem() {} }, parent: {},
  }
  window.window = window
  const sandbox = vm.createContext({
    window, document, performance: { now: () => now }, requestAnimationFrame: (fn) => { queue.push(fn) },
    Image: function () {}, Math, Number, String, Object, Array, JSON, isFinite, console,
  })
  vm.runInContext(CODE, sandbox)
  const key = (k) => {
    handlers.forEach((fn) => fn({ key: k, target: {}, preventDefault() {} }))
    now += 5000
    queue.splice(0).forEach((fn) => fn(now)) // let reveal animations finish
  }
  let rng = seed * 7919 + 13
  const rnd = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return rng / 4294967296 }
  const slotKey = { health: '2', friends: '3', talent: '4', family: '5', mood: '6' }

  key('x') // any key starts
  let guard = 0
  while (window.__gameState().phase !== 'won' && guard++ < 2000) {
    const st = window.__gameState()
    if (st.stage === 'allocate') {
      for (let i = 0; i < 3; i += 1) {
        if (strategy === 'studyonly') key('1')
        else if (strategy === 'nostudy') key(String(2 + Math.floor(rnd() * 5)))
        else if (strategy === 'random') key(String(1 + Math.floor(rnd() * 6)))
        else if (strategy === 'balanced' && i === 0) key('1')
        else if (strategy === 'smart' && i < 2) key('1')
        else {
          const lowest = Object.keys(slotKey).sort((a, b) => st.stats[a] - st.stats[b])[0]
          key(slotKey[lowest])
        }
      }
      key('Enter')
    } else if (st.stage === 'event') key(String(1 + Math.floor(rnd() * 2)))
    else if (st.stage === 'report' || st.stage === 'exam') { key('Enter'); key('Enter') }
    else if (st.stage === 'retake') key('1')
  }
  const end = window.__gameState()
  return { finished: end.phase === 'won', ...end }
}

function summarize(strategy, n = 30, extra = {}) {
  let sum = 0
  const tiers = { top: 0, key: 0, ben: 0, zhuan: 0 }
  for (let seed = 1; seed <= n; seed += 1) {
    const r = play({ seed, strategy, ...extra })
    assert.equal(r.finished, true, `${strategy} seed ${seed} never reached the ending`)
    sum += r.ending.score
    tiers[r.ending.tier] += 1
  }
  return { avg: sum / n, tiers, n }
}

test('lifesim: every start grade reaches an ending without errors', () => {
  for (const startGrade of [1, 6, 7, 9, 10, 12]) {
    for (const strategy of ['smart', 'random', 'nostudy']) {
      const r = play({ seed: 3, strategy, startGrade })
      assert.equal(r.finished, true, `grade ${startGrade} / ${strategy} did not finish`)
      assert.ok(r.ending.score >= 200 && r.ending.score <= 748)
      assert.ok(r.ending.uni && r.ending.title)
    }
  }
})

test('lifesim: effort and balance are rewarded, neglect is not', () => {
  const smart = summarize('smart')
  const balanced = summarize('balanced')
  const studyOnly = summarize('studyonly')
  const random = summarize('random')
  const noStudy = summarize('nostudy')
  assert.ok(smart.avg > balanced.avg, `smart ${smart.avg} should beat balanced ${balanced.avg}`)
  assert.ok(balanced.avg > studyOnly.avg, `balanced ${balanced.avg} should beat study-only ${studyOnly.avg}`)
  assert.ok(studyOnly.avg > random.avg, `study-only ${studyOnly.avg} should beat random ${random.avg}`)
  assert.ok(random.avg > noStudy.avg, `random ${random.avg} should beat no-study ${noStudy.avg}`)
  // Not trivial: even good play should not make every run a top-tier result...
  assert.ok(balanced.tiers.top < balanced.n * 0.5, 'balanced play is too easy')
  // ...and not hopeless: diligent play should usually reach a key university or better.
  assert.ok(smart.tiers.top + smart.tiers.key >= smart.n * 0.9, 'smart play is too hard')
  // Skipping studying entirely should usually end in the lowest tier (and offers a retake).
  assert.ok(noStudy.tiers.zhuan >= noStudy.n * 0.6, 'ignoring study is not penalised enough')
})

test('lifesim: the difficulty dial moves results in the expected direction', () => {
  const easy = summarize('random', 20, { difficulty: 0.7 })
  const hard = summarize('random', 20, { difficulty: 1.4 })
  assert.ok(easy.avg > hard.avg + 60, `easy ${easy.avg} vs hard ${hard.avg}`)
})

test('lifesim: the same seed replays the same life', () => {
  const a = play({ seed: 42, strategy: 'random' })
  const b = play({ seed: 42, strategy: 'random' })
  assert.equal(a.ending.score, b.ending.score)
  assert.equal(JSON.stringify(a.stats), JSON.stringify(b.stats))
})
