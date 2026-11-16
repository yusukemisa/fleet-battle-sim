/**
 * Held-out comparison of /tmp/big-policy against the shipped policies.
 * Seeds are 101 and up. The trainee is the big net; the opponent is the current AI.
 *
 *   npx vite-node scripts/eval-big-policy.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { FORMATION_IDS } from '../src/types.ts'
import { PERSONALITIES } from '../src/brain/fitness.ts'
import { playMatch } from '../src/brain/match.ts'
import { createSim, dispatch } from '../src/sim.ts'
import { featurize, INPUT_SIZE } from '../src/brain/features.ts'
import { OUTPUT_SIZE, POLICY_TACTICS, policyFor, useStudyDecider } from '../src/brain/policy.ts'

const DIR = '/tmp/big-policy'
const FORMS = [...FORMATION_IDS]
const SMALL_FORMS = ['oujin', 'kakuyoku', 'gyorin']
const SEEDS = [101, 102, 103, 104]
const MANEUVERS = ['press', 'seize', 'envelop', 'wheel', 'breakout', 'refuse', 'reform']
const SHAPES = ['pincer', 'spindle', 'contract']

function load(id) {
  return Float64Array.from(JSON.parse(readFileSync(`${DIR}/${id}.json`, 'utf8')))
}

function wilson(wins, games) {
  const z = 1.96
  const p = wins / games
  const z2 = z * z
  const den = 1 + z2 / games
  const centre = p + z2 / (2 * games)
  const margin = z * Math.sqrt((p * (1 - p)) / games + z2 / (4 * games * games))
  return [Math.round(((centre - margin) / den) * 1000) / 1000, Math.round(((centre + margin) / den) * 1000) / 1000]
}

function localForward(flat, input) {
  const inputSize = input.length
  const hidden = 48
  const output = (flat.length - inputSize * hidden - hidden) / (hidden + 1)
  const b1 = inputSize * hidden
  const w2 = b1 + hidden
  const b2 = w2 + hidden * output
  const hiddenOut = new Float64Array(hidden)
  for (let neuron = 0; neuron < hidden; neuron++) {
    let sum = flat[b1 + neuron] ?? 0
    const row = neuron * inputSize
    for (let i = 0; i < inputSize; i++) sum += (flat[row + i] ?? 0) * (input[i] ?? 0)
    hiddenOut[neuron] = Math.tanh(sum)
  }
  const logits = new Float64Array(output)
  for (let neuron = 0; neuron < output; neuron++) {
    let sum = flat[b2 + neuron] ?? 0
    const row = w2 + neuron * hidden
    for (let i = 0; i < hidden; i++) sum += (flat[row + i] ?? 0) * hiddenOut[i]
    logits[neuron] = sum
  }
  return logits
}

function inputOf(observation) {
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
  const input = new Float64Array(INPUT_SIZE + 6)
  input.set(featurize(observation))
  ;[
    own.some((division) => division.flag === 1) ? 1 : 0,
    enemy.some((division) => division.flag === 1) ? 1 : 0,
    dx / range,
    dy / range,
    ownAlive / Math.max(1, ownAlive + enemyAlive),
    enemy.length === 0 ? 0 : seen / enemy.length,
  ].forEach((value, index) => {
    input[INPUT_SIZE + index] = value
  })
  return input
}

function decideFlat(flat, observation) {
  const logits = localForward(flat, inputOf(observation))
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

function matrix(forms, seeds, shipCount) {
  const table = {}
  let wins = 0
  let games = 0
  for (const trainee of PERSONALITIES) {
    table[trainee] = {}
    const flat = load(trainee)
    for (const foe of PERSONALITIES) {
      let cellWins = 0
      let cellGames = 0
      for (const ownForm of forms) {
        for (const foeForm of forms) {
          for (const seed of seeds) {
            for (const swap of [false, true]) {
              const side = swap ? 1 : 0
              const report = playMatch({
                commanders: swap ? [foe, trainee] : [trainee, foe],
                formations: swap ? [foeForm, ownForm] : [ownForm, foeForm],
                seed: (Math.imul(seed, 0x9e3779b1) + ownForm.length * 5 + foeForm.length * 7 + (swap ? 19 : 0)) | 0,
                brains: ['ai', 'ai'],
                weights: swap ? [policyFor(foe), undefined] : [undefined, policyFor(foe)],
                focus: side,
                shipCount,
                timeout: shipCount === 1000 ? 55 : 80,
                study: {
                  fleets: [side],
                  decider: (observation) => (observation.fleet === side ? decideFlat(flat, observation) : null),
                },
              })
              cellGames += 1
              games += 1
              if (report.won) {
                cellWins += 1
                wins += 1
              }
            }
          }
        }
      }
      table[trainee][foe] = {
        win: Math.round((cellWins / cellGames) * 1000) / 1000,
        games: cellGames,
        ci: wilson(cellWins, cellGames),
      }
      console.log(JSON.stringify({ shipCount, trainee, foe, ...table[trainee][foe] }))
    }
  }
  return { win: Math.round((wins / games) * 1000) / 1000, games, ci: wilson(wins, games), table }
}

function medianStep(setup, withNet) {
  let state = createSim(setup)
  state = dispatch(state, { type: 'set-speed', speed: 1 })
  state = dispatch(state, { type: 'start' })
  const flats = Object.fromEntries(PERSONALITIES.map((id) => [id, load(id)]))
  if (withNet) {
    useStudyDecider((observation) => decideFlat(flats[observation.own.commanderId] ?? flats.balanced, observation))
  }
  const samples = []
  for (let step = 0; step < 30; step++) {
    const start = performance.now()
    state = dispatch(state, { type: 'tick', dt: 1 / 60 })
    samples.push(performance.now() - start)
  }
  useStudyDecider(null)
  samples.sort((a, b) => a - b)
  return Math.round((samples[Math.floor(samples.length / 2)] ?? 0) * 100) / 100
}

const hundred = matrix(FORMS, SEEDS, 100)
const thousand = matrix(SMALL_FORMS, SEEDS, 1000)
const group = (side, ships, commanderId) => ({ side, ships, commanderId })
const six = {
  shipCount: 100,
  groups: [
    group(0, 2000, 'balanced'),
    group(0, 2000, 'fierce'),
    group(0, 1000, 'cunning'),
    group(1, 2000, 'guard'),
    group(1, 2000, 'fierce'),
    group(1, 1000, 'balanced'),
  ],
}
const perf = {
  oneFleetOff: medianStep({ shipCount: 10000, formations: ['oujin', 'kakuyoku'] }, false),
  oneFleetOn: medianStep({ shipCount: 10000, formations: ['oujin', 'kakuyoku'] }, true),
  sixOff: medianStep(six, false),
  sixOn: medianStep(six, true),
}
console.log(JSON.stringify({ perf }))
mkdirSync('docs', { recursive: true })
writeFileSync('docs/big-policy-eval.json', JSON.stringify({ hundred, thousand, perf }, null, 2))
console.log(JSON.stringify({
  hundred: { win: hundred.win, games: hundred.games, ci: hundred.ci },
  thousand: { win: thousand.win, games: thousand.games, ci: thousand.ci },
}))
