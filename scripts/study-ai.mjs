/**
 * Study three ways to train the commander policy. Writes nothing under src/brain/weights.
 * Held-out seeds 101 and 102 are evaluation only. The learning curve uses seed 201.
 *
 *   npx vite-node scripts/study-ai.mjs time
 *   npx vite-node scripts/study-ai.mjs baseline
 *   npx vite-node scripts/study-ai.mjs compute
 *   npx vite-node scripts/study-ai.mjs diversity
 *   npx vite-node scripts/study-ai.mjs control
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { FORMATION_IDS } from '../src/types.ts'
import { PERSONALITIES, scoreBattle, scoreSuite } from '../src/brain/fitness.ts'
import { playMatch } from '../src/brain/match.ts'
import { featurize, INPUT_SIZE } from '../src/brain/features.ts'
import {
  HIDDEN,
  OUTPUT_SIZE,
  POLICY_TACTICS,
  pack,
  policyFor,
  unpack,
  useStudyDecider,
} from '../src/brain/policy.ts'

const phase = process.argv[2] ?? 'time'
const outPath = 'docs/ai-study-data.json'
const FORMS = [...FORMATION_IDS]
const FOES = [...PERSONALITIES]
const MANEUVERS = ['press', 'seize', 'envelop', 'wheel', 'breakout', 'refuse', 'reform']
const SHAPES = ['pincer', 'spindle', 'contract']
const EXTRA = 6
const C_IN = INPUT_SIZE + EXTRA
const C_HID = 48
const C_OUT = OUTPUT_SIZE + MANEUVERS.length + SHAPES.length + 5

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(rng) {
  const u = Math.max(1e-12, rng())
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function tuningSeed(pool, salt) {
  const base = pool[Math.abs(salt) % pool.length]
  return (Math.imul(base, 0x9e3779b1) ^ Math.imul(salt, 13)) | 0
}

function gamesFor(salt, pool, mode) {
  const games = []
  const count = mode === 'wide' ? 16 : 8
  for (let i = 0; i < count; i++) {
    const league = mode === 'diverse' ? i % 2 === 0 : i % 5 === 4
    const self = mode === 'diverse' ? i % 4 === 3 : i % 5 === 3
    const foe = self ? 'balanced' : FOES[(salt + i) % FOES.length]
    games.push({
      form: FORMS[(salt + i) % FORMS.length],
      foeForm: FORMS[(salt + i * 2 + 1) % FORMS.length],
      foe,
      kind: league ? 'league' : self ? 'self' : 'rule',
      side: i % 2,
      seed: tuningSeed(pool, salt * 20 + i + 1),
    })
  }
  return games
}

function forwardFlat(flat, input, inputSize, hidden, output) {
  const b1at = inputSize * hidden
  const w2at = b1at + hidden
  const b2at = w2at + hidden * output
  const hiddenOut = new Float64Array(hidden)
  for (let neuron = 0; neuron < hidden; neuron++) {
    let sum = flat[b1at + neuron] ?? 0
    const row = neuron * inputSize
    for (let i = 0; i < inputSize; i++) sum += (flat[row + i] ?? 0) * (input[i] ?? 0)
    hiddenOut[neuron] = Math.tanh(sum)
  }
  const logits = new Float64Array(output)
  for (let neuron = 0; neuron < output; neuron++) {
    let sum = flat[b2at + neuron] ?? 0
    const row = w2at + neuron * hidden
    for (let i = 0; i < hidden; i++) sum += (flat[row + i] ?? 0) * hiddenOut[i]
    logits[neuron] = sum
  }
  return logits
}

function loadBalanced() {
  const saved = policyFor('balanced')
  if (!saved) throw new Error('missing balanced weights')
  return pack(saved)
}

function asWeights(flat) {
  return unpack(flat)
}

let controlFlat = null

function extraFeatures(observation) {
  const own = observation.divisions.filter((division) => division.fleet === observation.fleet)
  const enemy = observation.divisions.filter((division) => division.fleet === observation.enemy.index)
  const flag = own.some((division) => division.flag === 1) ? 1 : 0
  const enemyFlag = enemy.some((division) => division.flag === 1) ? 1 : 0
  const dx = observation.enemy.x - observation.own.x
  const dy = observation.enemy.y - observation.own.y
  const range = Math.hypot(dx, dy) || 1
  let ownAlive = 0
  let enemyAlive = 0
  let seen = 0
  for (const division of enemy) {
    enemyAlive += division.alive
    // Every enemy division is visible. This slot stays so the wider net's input width does not change.
    seen += 1
  }
  for (const division of own) ownAlive += division.alive
  return [
    flag,
    enemyFlag,
    dx / range,
    dy / range,
    ownAlive / Math.max(1, ownAlive + enemyAlive),
    enemy.length === 0 ? 0 : seen / enemy.length,
  ]
}

function controlDecision(observation) {
  if (!controlFlat) return null
  const base = featurize(observation)
  const input = new Float64Array(C_IN)
  input.set(base)
  extraFeatures(observation).forEach((value, index) => {
    input[INPUT_SIZE + index] = value
  })
  const logits = forwardFlat(controlFlat, input, C_IN, C_HID, C_OUT)
  const orders = []
  const notes = []
  let preySlot = 0
  let preyValue = -Infinity
  for (let slot = 0; slot < 5; slot++) {
    const value = logits[OUTPUT_SIZE + MANEUVERS.length + SHAPES.length + slot] ?? 0
    if (value > preyValue) {
      preyValue = value
      preySlot = slot
    }
  }
  const prey = observation.divisions.find(
    (division) => division.fleet === observation.enemy.index && division.slot === preySlot && division.alive > 0,
  )
  for (let slot = 0; slot < 5; slot++) {
    const division = observation.divisions.find((item) => item.fleet === observation.fleet && item.slot === slot && item.alive > 0)
    if (!division) continue
    let best = 0
    let bestValue = -Infinity
    const offset = slot * POLICY_TACTICS.length
    for (let action = 0; action < POLICY_TACTICS.length; action++) {
      const value = logits[offset + action] ?? 0
      if (value > bestValue) {
        bestValue = value
        best = action
      }
    }
    const tacticId = POLICY_TACTICS[best] ?? 'hold'
    orders.push(prey ? { division: division.id, tacticId, target: prey.id } : { division: division.id, tacticId })
  }
  let maneuver = 0
  let maneuverValue = -Infinity
  for (let i = 0; i < MANEUVERS.length; i++) {
    const value = logits[OUTPUT_SIZE + i] ?? 0
    if (value > maneuverValue) {
      maneuverValue = value
      maneuver = i
    }
  }
  let shape = 0
  let shapeValue = -Infinity
  for (let i = 0; i < SHAPES.length; i++) {
    const value = logits[OUTPUT_SIZE + MANEUVERS.length + i] ?? 0
    if (value > shapeValue) {
      shapeValue = value
      shape = i
    }
  }
  if (orders.length === 0) return null
  return {
    orders,
    note: 'study',
    maneuver: MANEUVERS[maneuver],
    shape: SHAPES[shape],
  }
}

function warmControl(rng) {
  const base = policyFor('balanced')
  if (!base) throw new Error('missing balanced weights')
  const flat = new Float64Array(C_IN * C_HID + C_HID + C_HID * C_OUT + C_OUT)
  for (let neuron = 0; neuron < HIDDEN; neuron++) {
    for (let i = 0; i < INPUT_SIZE; i++) flat[neuron * C_IN + i] = base.w1[neuron * INPUT_SIZE + i] ?? 0
    flat[C_IN * C_HID + neuron] = base.b1[neuron] ?? 0
  }
  const w2 = C_IN * C_HID + C_HID
  for (let neuron = 0; neuron < OUTPUT_SIZE; neuron++) {
    for (let i = 0; i < HIDDEN; i++) flat[w2 + neuron * C_HID + i] = base.w2[neuron * HIDDEN + i] ?? 0
    flat[w2 + C_HID * C_OUT + neuron] = base.b2[neuron] ?? 0
  }
  flat[w2 + C_HID * C_OUT + OUTPUT_SIZE] = 0.5
  flat[w2 + C_HID * C_OUT + OUTPUT_SIZE + MANEUVERS.length] = 0.4
  for (let i = 0; i < flat.length; i++) if (flat[i] === 0) flat[i] = gaussian(rng) * 0.01
  return flat
}

function scoreFlat(flat, salt, mode, shipCount) {
  const scores = []
  const previous = controlFlat
  if (mode === 'control') controlFlat = flat
  try {
    const list = gamesFor(salt, mode === 'diverse' ? pool32 : pool8, mode === 'wide' ? 'wide' : mode === 'diverse' ? 'diverse' : 'current')
    for (const game of (mode === 'control' ? list.slice(0, 4) : list)) {
      const commanders = game.side === 0 ? ['balanced', game.foe] : [game.foe, 'balanced']
      const formations = game.side === 0 ? [game.form, game.foeForm] : [game.foeForm, game.form]
      const weights = [undefined, undefined]
      if (mode !== 'control') weights[game.side] = asWeights(flat)
      if (mode === 'control') useStudyDecider(controlDecision)
      const report = playMatch({
        commanders,
        formations,
        seed: game.seed,
        brains: game.side === 0 ? ['ai', 'rule'] : ['rule', 'ai'],
        weights,
        focus: game.side,
        shipCount,
        timeout: shipCount === 1000 ? 50 : 80,
      })
      scores.push(scoreBattle('balanced', report))
    }
  } finally {
    controlFlat = previous
  }
  return scoreSuite('balanced', scores)
}

const pool8 = [1, 2, 3, 4, 5, 6, 7, 8]
const pool32 = Array.from({ length: 32 }, (_, index) => index + 1)

function train({ name, start, gens, pairs, mode, shipCount, every }) {
  const rng = mulberry32(name.length * 10007 + gens)
  let theta = Float64Array.from(start)
  const sigma = mode === 'control' ? 0.08 : 0.12
  const learning = mode === 'control' ? 0.04 : 0.06
  const curve = []
  const t0 = Date.now()
  let best = theta
  let bestScore = -Infinity
  for (let gen = 0; gen < gens; gen++) {
    const noises = []
    const scores = []
    for (let pair = 0; pair < pairs; pair++) {
      const noise = new Float64Array(theta.length)
      for (let i = 0; i < theta.length; i++) noise[i] = gaussian(rng)
      noises.push(noise)
      const salt = gen * 30 + pair + 3
      scores.push(scoreFlat(add(theta, noise, sigma), salt, mode, shipCount))
      scores.push(scoreFlat(add(theta, noise, -sigma), salt + 9, mode, shipCount))
    }
    const order = scores.map((score, index) => ({ score, index })).sort((a, b) => a.score - b.score)
    const shaped = new Float64Array(scores.length)
    order.forEach((item, rank) => {
      shaped[item.index] = (rank / Math.max(1, scores.length - 1)) * 2 - 1
    })
    const grad = new Float64Array(theta.length)
    for (let pair = 0; pair < pairs; pair++) {
      const scale = (shaped[pair * 2] - shaped[pair * 2 + 1]) / 2
      const noise = noises[pair]
      for (let i = 0; i < theta.length; i++) grad[i] += noise[i] * scale
    }
    for (let i = 0; i < theta.length; i++) theta[i] += (learning / pairs) * grad[i]
    const probe = scoreFlat(theta, 900 + gen, mode, shipCount)
    if (probe >= bestScore) {
      bestScore = probe
      best = Float64Array.from(theta)
    }
    const row = {
      gen,
      seconds: Math.round((Date.now() - t0) / 1000),
      mean: round(scores.reduce((sum, score) => sum + score, 0) / scores.length),
      probe: round(probe),
    }
    if (gen % every === 0 || gen === gens - 1) {
      row.curve = curveProbe(mode === 'control' ? best : best)
      row.mode = mode
    }
    curve.push(row)
    console.log(JSON.stringify({ name, ...row }))
  }
  return { name, theta: best, curve, seconds: Math.round((Date.now() - t0) / 1000) }
}

function add(theta, noise, scale) {
  const next = new Float64Array(theta.length)
  for (let i = 0; i < theta.length; i++) next[i] = theta[i] + (noise[i] ?? 0) * scale
  return next
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

function curveProbe(flat) {
  const previous = controlFlat
  const usingControl = flat.length !== loadBalanced().length
  if (usingControl) controlFlat = flat
  let wins = 0
  let games = 0
  try {
    for (const foe of ['fierce', 'guard']) {
      for (const seed of [201, 202]) {
        for (const swap of [false, true]) {
          if (usingControl) useStudyDecider(controlDecision)
          const report = playMatch({
            commanders: swap ? [foe, 'balanced'] : ['balanced', foe],
            formations: swap ? ['kakuyoku', 'oujin'] : ['oujin', 'kakuyoku'],
            seed,
            brains: swap ? ['rule', 'ai'] : ['ai', 'rule'],
            weights: usingControl ? [undefined, undefined] : swap ? [undefined, asWeights(flat)] : [asWeights(flat), undefined],
            focus: swap ? 1 : 0,
            shipCount: usingControl ? 1000 : 100,
            timeout: usingControl ? 50 : 80,
          })
          games += 1
          if (report.won) wins += 1
        }
      }
    }
  } finally {
    controlFlat = previous
  }
  return { wins, games, win: round(wins / games) }
}

function evalForms(flat, usingControl, forms) {
  const previous = controlFlat
  if (usingControl) controlFlat = flat
  const byFoe = {}
  let wins = 0
  let games = 0
  const t0 = Date.now()
  try {
    for (const foe of FOES) {
      let foeWins = 0
      let foeGames = 0
      for (const ownForm of forms) {
        for (const foeForm of forms) {
          for (const seed of [101, 102]) {
            for (const swap of [false, true]) {
              if (usingControl) useStudyDecider(controlDecision)
              const report = playMatch({
                commanders: swap ? [foe, 'balanced'] : ['balanced', foe],
                formations: swap ? [foeForm, ownForm] : [ownForm, foeForm],
                seed: (Math.imul(seed, 0x9e3779b1) + ownForm.length * 3 + foeForm.length + (swap ? 19 : 0)) | 0,
                brains: swap ? ['rule', 'ai'] : ['ai', 'rule'],
                weights: usingControl ? [undefined, undefined] : swap ? [undefined, asWeights(flat)] : [asWeights(flat), undefined],
                focus: swap ? 1 : 0,
                shipCount: 1000,
                timeout: 50,
              })
              foeGames += 1
              games += 1
              if (report.won) {
                wins += 1
                foeWins += 1
              }
            }
          }
        }
      }
      byFoe[foe] = round(foeWins / foeGames)
      console.log(JSON.stringify({ label: usingControl ? 'control' : 'baseline-1000', foe, win: byFoe[foe] }))
    }
  } finally {
    controlFlat = previous
  }
  return { win: round(wins / games), games, byFoe, seconds: Math.round((Date.now() - t0) / 1000) }
}

function heldOut(flat, label) {
  const usingControl = flat.length !== loadBalanced().length
  const previous = controlFlat
  if (usingControl) controlFlat = flat
  const byFoe = {}
  const bySeed = {}
  let wins = 0
  let games = 0
  const t0 = Date.now()
  try {
    for (const foe of FOES) {
      let foeWins = 0
      let foeGames = 0
      for (const ownForm of FORMS) {
        for (const foeForm of FORMS) {
          for (const seed of [101, 102]) {
            for (const swap of [false, true]) {
              if (usingControl) useStudyDecider(controlDecision)
              const packed = (Math.imul(seed, 0x9e3779b1) + (swap ? 17 : 0) + ownForm.length * 3 + foeForm.length) | 0
              const report = playMatch({
                commanders: swap ? [foe, 'balanced'] : ['balanced', foe],
                formations: swap ? [foeForm, ownForm] : [ownForm, foeForm],
                seed: packed,
                brains: swap ? ['rule', 'ai'] : ['ai', 'rule'],
                weights: usingControl ? [undefined, undefined] : swap ? [undefined, asWeights(flat)] : [asWeights(flat), undefined],
                focus: swap ? 1 : 0,
                shipCount: usingControl ? 1000 : 100,
                timeout: usingControl ? 50 : 80,
              })
              foeGames += 1
              games += 1
              bySeed[seed] = bySeed[seed] ?? { wins: 0, games: 0 }
              bySeed[seed].games += 1
              if (report.won) {
                wins += 1
                foeWins += 1
                bySeed[seed].wins += 1
              }
            }
          }
        }
      }
      byFoe[foe] = round(foeWins / foeGames)
      console.log(JSON.stringify({ label, foe, win: byFoe[foe], games: foeGames }))
    }
  } finally {
    controlFlat = previous
  }
  const rates = Object.values(bySeed).map((row) => row.wins / row.games)
  const mean = rates.reduce((sum, value) => sum + value, 0) / rates.length
  const variance = rates.reduce((sum, value) => sum + (value - mean) ** 2, 0) / rates.length
  return {
    label,
    win: round(wins / games),
    games,
    byFoe,
    seedStd: round(Math.sqrt(variance)),
    seconds: Math.round((Date.now() - t0) / 1000),
  }
}

function readStore() {
  try {
    return JSON.parse(readFileSync(outPath, 'utf8'))
  } catch {
    return {}
  }
}

function writeStore(patch) {
  mkdirSync('docs', { recursive: true })
  const next = { ...readStore(), ...patch }
  writeFileSync(outPath, JSON.stringify(next, null, 2))
}

const started = Date.now()
if (phase === 'time') {
  const t0 = Date.now()
  for (let i = 0; i < 20; i++) {
    playMatch({
      commanders: ['balanced', 'fierce'],
      formations: ['oujin', 'kakuyoku'],
      seed: 50 + i,
      brains: ['ai', 'rule'],
      focus: 0,
    })
  }
  const ms = Date.now() - t0
  console.log(JSON.stringify({ matches: 20, ms, each: Math.round(ms / 20) }))
}

if (phase === 'baseline' || phase === 'all') {
  const row = heldOut(loadBalanced(), 'baseline')
  writeStore({ baseline: row })
  console.log(JSON.stringify(row))
}

if (phase === 'compute' || phase === 'all') {
  const current = train({
    name: 'compute-current',
    start: loadBalanced(),
    gens: 24,
    pairs: 8,
    mode: 'current',
    shipCount: 100,
    every: 6,
  })
  const wide = train({
    name: 'compute-wide',
    start: loadBalanced(),
    gens: 12,
    pairs: 16,
    mode: 'wide',
    shipCount: 100,
    every: 4,
  })
  const currentHeld = heldOut(current.theta, 'compute-current')
  const wideHeld = heldOut(wide.theta, 'compute-wide')
  writeStore({
    compute: {
      current: { seconds: current.seconds, curve: current.curve, held: currentHeld },
      wide: { seconds: wide.seconds, curve: wide.curve, held: wideHeld },
    },
  })
}

if (phase === 'diversity' || phase === 'all') {
  const diverse = train({
    name: 'diversity',
    start: loadBalanced(),
    gens: 16,
    pairs: 8,
    mode: 'diverse',
    shipCount: 100,
    every: 4,
  })
  const held = heldOut(diverse.theta, 'diversity')
  const seeds = []
  for (const seed of [101, 102, 103, 104, 105, 106]) {
    let wins = 0
    for (const foe of FOES) {
      for (const swap of [false, true]) {
        const report = playMatch({
          commanders: swap ? [foe, 'balanced'] : ['balanced', foe],
          formations: swap ? ['kakuyoku', 'oujin'] : ['oujin', 'kakuyoku'],
          seed: (Math.imul(seed, 0x9e3779b1) + (swap ? 17 : 0)) | 0,
          brains: swap ? ['rule', 'ai'] : ['ai', 'rule'],
          weights: swap ? [undefined, asWeights(diverse.theta)] : [asWeights(diverse.theta), undefined],
          focus: swap ? 1 : 0,
        })
        if (report.won) wins += 1
      }
    }
    seeds.push({ seed, win: round(wins / (FOES.length * 2)) })
  }
  let baseWins = []
  const base = loadBalanced()
  for (const seed of [101, 102, 103, 104, 105, 106]) {
    let wins = 0
    for (const foe of FOES) {
      for (const swap of [false, true]) {
        const report = playMatch({
          commanders: swap ? [foe, 'balanced'] : ['balanced', foe],
          formations: swap ? ['kakuyoku', 'oujin'] : ['oujin', 'kakuyoku'],
          seed: (Math.imul(seed, 0x9e3779b1) + (swap ? 17 : 0)) | 0,
          brains: swap ? ['rule', 'ai'] : ['ai', 'rule'],
          weights: swap ? [undefined, asWeights(base)] : [asWeights(base), undefined],
          focus: swap ? 1 : 0,
        })
        if (report.won) wins += 1
      }
    }
    baseWins.push({ seed, win: round(wins / (FOES.length * 2)) })
  }
  writeStore({ diversity: { seconds: diverse.seconds, curve: diverse.curve, held, seeds, baselineSeeds: baseWins } })
}

if (phase === 'control' || phase === 'all') {
  const trained = train({
    name: 'control',
    start: warmControl(mulberry32(77)),
    gens: 6,
    pairs: 4,
    mode: 'control',
    shipCount: 1000,
    every: 2,
  })
  const smallForms = ['oujin', 'kakuyoku', 'gyorin']
  const learned = evalForms(trained.theta, true, smallForms)
  const base1000 = evalForms(loadBalanced(), false, smallForms)
  writeStore({
    control: {
      seconds: trained.seconds,
      curve: trained.curve,
      held: learned,
      baseline1000: base1000,
    },
  })
}

console.log(JSON.stringify({ phase, seconds: Math.round((Date.now() - started) / 1000) }))
