/**
 * Long-budget training for the wider policy.
 * Hidden 48, input 135, outputs tactics plus maneuver, density shape, and target.
 * Weights stay in /tmp/big-policy until an evaluation says to ship them.
 * Held-out seeds 101+ are not used here. The curve probe uses seed 301.
 *
 *   npx vite-node scripts/train-big-policy.mjs
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { FORMATION_IDS } from '../src/types.ts'
import { PERSONALITIES, scoreBattle } from '../src/brain/fitness.ts'
import { playMatch } from '../src/brain/match.ts'
import { featurize, INPUT_SIZE } from '../src/brain/features.ts'
import { HIDDEN, OUTPUT_SIZE, POLICY_TACTICS, policyFor } from '../src/brain/policy.ts'

const HOURS = Number(process.env.BIG_POLICY_HOURS ?? 2.5)
const BUDGET_MS = HOURS * 3600 * 1000
const DIR = '/tmp/big-policy'
const C_IN = INPUT_SIZE + 6
const C_HID = 48
const C_OUT = OUTPUT_SIZE + 7 + 3 + 5
const MANEUVERS = ['press', 'seize', 'envelop', 'wheel', 'breakout', 'refuse', 'reform']
const SHAPES = ['pincer', 'spindle', 'contract']
const FORMS = [...FORMATION_IDS]
const PAIRS = 8
const SIGMA = 0.1
const LEARNING = 0.05

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

function forward(flat, input) {
  const b1 = C_IN * C_HID
  const w2 = b1 + C_HID
  const b2 = w2 + C_HID * C_OUT
  const hidden = new Float64Array(C_HID)
  for (let neuron = 0; neuron < C_HID; neuron++) {
    let sum = flat[b1 + neuron] ?? 0
    const row = neuron * C_IN
    for (let i = 0; i < C_IN; i++) sum += (flat[row + i] ?? 0) * (input[i] ?? 0)
    hidden[neuron] = Math.tanh(sum)
  }
  const logits = new Float64Array(C_OUT)
  for (let neuron = 0; neuron < C_OUT; neuron++) {
    let sum = flat[b2 + neuron] ?? 0
    const row = w2 + neuron * C_HID
    for (let i = 0; i < C_HID; i++) sum += (flat[row + i] ?? 0) * hidden[i]
    logits[neuron] = sum
  }
  return logits
}

function extra(observation) {
  const own = observation.divisions.filter((division) => division.fleet === observation.fleet)
  const enemy = observation.divisions.filter((division) => division.fleet === observation.enemy.index)
  const dx = observation.enemy.x - observation.own.x
  const dy = observation.enemy.y - observation.own.y
  const range = Math.hypot(dx, dy) || 1
  let ownAlive = 0
  let enemyAlive = 0
  let seen = 0
  for (const division of own) ownAlive += division.alive
  for (const division of enemy) {
    enemyAlive += division.alive
    if (Math.hypot(division.x - observation.own.x, division.y - observation.own.y) < 6400) seen += 1
  }
  return [
    own.some((division) => division.flag === 1) ? 1 : 0,
    enemy.some((division) => division.flag === 1) ? 1 : 0,
    dx / range,
    dy / range,
    ownAlive / Math.max(1, ownAlive + enemyAlive),
    enemy.length === 0 ? 0 : seen / enemy.length,
  ]
}

function inputOf(observation) {
  const input = new Float64Array(C_IN)
  input.set(featurize(observation))
  extra(observation).forEach((value, index) => {
    input[INPUT_SIZE + index] = value
  })
  return input
}

const nets = [null, null]

function decider(observation) {
  const flat = nets[observation.fleet]
  if (!flat) return null
  const logits = forward(flat, inputOf(observation))
  let preySlot = 0
  let preyValue = -Infinity
  const preyAt = OUTPUT_SIZE + MANEUVERS.length + SHAPES.length
  for (let slot = 0; slot < 5; slot++) {
    const value = logits[preyAt + slot] ?? 0
    if (value > preyValue) {
      preyValue = value
      preySlot = slot
    }
  }
  const prey = observation.divisions.find(
    (division) => division.fleet === observation.enemy.index && division.slot === preySlot && division.alive > 0,
  )
  const orders = []
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
  return { orders, note: 'big', maneuver: MANEUVERS[maneuver], shape: SHAPES[shape] }
}

function warm(personality, rng) {
  const base = policyFor(personality)
  if (!base) throw new Error(`missing ${personality}`)
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
  flat[w2 + C_HID * C_OUT + OUTPUT_SIZE] = 0.4
  flat[w2 + C_HID * C_OUT + OUTPUT_SIZE + MANEUVERS.length] = 0.3
  for (let i = 0; i < flat.length; i++) if (flat[i] === 0) flat[i] = gaussian(rng) * 0.01
  return flat
}

function add(theta, noise, scale) {
  const next = new Float64Array(theta.length)
  for (let i = 0; i < theta.length; i++) next[i] = theta[i] + noise[i] * scale
  return next
}

function play(personality, flat, foeFlat, game) {
  const side = game.side
  nets[0] = null
  nets[1] = null
  nets[side] = flat
  const fleets = [side]
  const weights = [undefined, undefined]
  const brains = ['rule', 'rule']
  brains[side] = 'ai'
  if (game.kind === 'self' && foeFlat) {
    nets[1 - side] = foeFlat
    fleets.push(1 - side)
    brains[1 - side] = 'ai'
  } else if (game.kind === 'current') {
    weights[1 - side] = policyFor(game.foe)
    brains[1 - side] = 'ai'
  }
  const commanders = side === 0 ? [personality, game.foe] : [game.foe, personality]
  const formations = side === 0 ? [game.form, game.foeForm] : [game.foeForm, game.form]
  return playMatch({
    commanders,
    formations,
    seed: game.seed,
    brains,
    weights,
    focus: side,
    shipCount: game.ships,
    timeout: game.ships === 1000 ? 55 : 80,
    study: { decider, fleets },
  })
}

function gamesFor(personality, salt) {
  const others = PERSONALITIES.filter((id) => id !== personality)
  const foe = others[Math.abs(salt) % others.length]
  const form = FORMS[Math.abs(salt) % FORMS.length]
  const foeForm = FORMS[Math.abs(salt * 3 + 1) % FORMS.length]
  const seed = (Math.imul(salt, 0x9e3779b1) ^ 0x51) | 0
  return [
    { foe: personality, kind: 'current', ships: 100, form, foeForm, side: salt % 2, seed },
    { foe, kind: 'current', ships: 100, form: foeForm, foeForm: form, side: (salt + 1) % 2, seed: seed + 1 },
    { foe, kind: 'rule', ships: 100, form, foeForm, side: salt % 2, seed: seed + 2 },
    { foe: personality, kind: 'self', ships: 100, form: foeForm, foeForm: form, side: (salt + 1) % 2, seed: seed + 3 },
    { foe, kind: 'current', ships: 1000, form, foeForm, side: salt % 2, seed: seed + 4 },
    { foe: 'balanced', kind: 'rule', ships: 1000, form: foeForm, foeForm: form, side: (salt + 1) % 2, seed: seed + 5 },
  ]
}

function score(personality, flat, foeFlat, salt) {
  const values = []
  for (const game of gamesFor(personality, salt)) {
    const report = play(personality, flat, foeFlat, game)
    values.push(scoreBattle(personality, report))
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function probe(personality, flat) {
  let wins = 0
  const foes = PERSONALITIES
  for (const foe of foes) {
    for (const swap of [false, true]) {
      const side = swap ? 1 : 0
      const report = play(personality, flat, null, {
        foe,
        kind: 'current',
        ships: 100,
        form: 'oujin',
        foeForm: 'kakuyoku',
        side,
        seed: 301 + (swap ? 17 : 0) + foe.length,
      })
      if (report.won) wins += 1
    }
  }
  return { wins, games: foes.length * 2 }
}

function save(theta, bank, round, startedAt) {
  mkdirSync(DIR, { recursive: true })
  const payload = {
    round,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    theta: Object.fromEntries(PERSONALITIES.map((id) => [id, Array.from(theta[id])])),
    bank: Object.fromEntries(PERSONALITIES.map((id) => [id, bank[id].map((row) => Array.from(row))])),
  }
  writeFileSync(`${DIR}/state.json`, JSON.stringify(payload))
  for (const id of PERSONALITIES) {
    writeFileSync(`${DIR}/${id}.json`, JSON.stringify(Array.from(theta[id])))
  }
}

function load(startedAt) {
  const rng = mulberry32(20261116)
  const theta = {}
  const bank = {}
  let round = 0
  if (existsSync(`${DIR}/state.json`)) {
    const saved = JSON.parse(readFileSync(`${DIR}/state.json`, 'utf8'))
    for (const id of PERSONALITIES) {
      theta[id] = Float64Array.from(saved.theta[id])
      bank[id] = (saved.bank[id] ?? []).map((row) => Float64Array.from(row))
    }
    round = saved.round ?? 0
    console.log(JSON.stringify({ resume: round, seconds: saved.seconds }))
  } else {
    for (const id of PERSONALITIES) {
      theta[id] = warm(id, rng)
      bank[id] = [Float64Array.from(theta[id])]
    }
  }
  return { theta, bank, round, rng, startedAt }
}

const startedAt = Date.now()

function main() {
  const state = load(startedAt)
  const theta = state.theta
  const bank = state.bank
  const rng = state.rng
  let round = state.round
  mkdirSync(DIR, { recursive: true })
  while (Date.now() - startedAt < BUDGET_MS) {
    for (const personality of PERSONALITIES) {
      if (Date.now() - startedAt >= BUDGET_MS) break
      const noises = []
      const scores = []
      for (let pair = 0; pair < PAIRS; pair++) {
        const noise = new Float64Array(theta[personality].length)
        for (let i = 0; i < noise.length; i++) noise[i] = gaussian(rng)
        noises.push(noise)
        const salt = round * 40 + pair + personality.length * 9
        const past = bank[personality][Math.abs(salt) % bank[personality].length]
        scores.push(score(personality, add(theta[personality], noise, SIGMA), past, salt))
        scores.push(score(personality, add(theta[personality], noise, -SIGMA), past, salt + 11))
      }
      const order = scores.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value)
      const shaped = new Float64Array(scores.length)
      order.forEach((item, rank) => {
        shaped[item.index] = (rank / (scores.length - 1)) * 2 - 1
      })
      const grad = new Float64Array(theta[personality].length)
      for (let pair = 0; pair < PAIRS; pair++) {
        const scale = (shaped[pair * 2] - shaped[pair * 2 + 1]) / 2
        const noise = noises[pair]
        for (let i = 0; i < grad.length; i++) grad[i] += noise[i] * scale
      }
      const next = theta[personality]
      for (let i = 0; i < next.length; i++) next[i] += (LEARNING / PAIRS) * grad[i]
      const look = probe(personality, next)
      const row = {
        round,
        personality,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        mean: Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 1000) / 1000,
        probe: look.wins / look.games,
        probeWins: look.wins,
        probeGames: look.games,
      }
      appendFileSync(`${DIR}/curve.jsonl`, JSON.stringify(row) + '\n')
      console.log(JSON.stringify(row))
      bank[personality].push(Float64Array.from(next))
      if (bank[personality].length > 6) bank[personality].shift()
    }
    round += 1
    save(theta, bank, round, startedAt)
  }
  save(theta, bank, round, startedAt)
  console.log(JSON.stringify({ done: true, round, seconds: Math.round((Date.now() - startedAt) / 1000) }))
}

main()
