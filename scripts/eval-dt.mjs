/**
 * Held-out win rates for the Decision Transformer.
 * Seeds are 101 and up, which collection never uses.
 *
 *   npm run eval:dt
 *   npm run eval:dt -- --quick
 */
import { FORMATION_IDS } from '../src/types.ts'
import { PERSONALITIES } from '../src/brain/fitness.ts'
import { playMatch } from '../src/brain/match.ts'
import { decideTransformer } from '../src/brain/dt.ts'
import { observe } from '../src/brain/observe.ts'
import { createSim, dispatch } from '../src/sim.ts'

const quick = process.argv.includes('--quick')
const HELDOUT = [101, 102]
const FORMS = quick ? FORMATION_IDS.slice(0, 2) : [...FORMATION_IDS]

function round(value) {
  return Math.round(value * 1000) / 1000
}

function run(personality, foe, ownForm, foeForm, seed, swap, opponent) {
  const commanders = swap ? [foe, personality] : [personality, foe]
  const formations = swap ? [foeForm, ownForm] : [ownForm, foeForm]
  const focus = swap ? 1 : 0
  const brains = swap ? [opponent, 'dt'] : ['dt', opponent]
  return playMatch({ commanders, formations, seed, brains, focus, timeout: 90 })
}

const table = []
for (const personality of PERSONALITIES) {
  const byFoe = {}
  for (const foe of PERSONALITIES) {
    const versusRule = []
    const versusAi = []
    for (const ownForm of FORMS) {
      for (const foeForm of FORMS) {
        for (const seed of HELDOUT) {
          for (const swap of [false, true]) {
            const packed = (Math.imul(seed, 0x9e3779b1) + (swap ? 17 : 0) + ownForm.length * 3 + foeForm.length) | 0
            versusRule.push(run(personality, foe, ownForm, foeForm, packed, swap, 'rule'))
            versusAi.push(run(personality, foe, ownForm, foeForm, packed, swap, 'ai'))
          }
        }
      }
    }
    const ruleWins = versusRule.filter((row) => row.won).length / versusRule.length
    const aiWins = versusAi.filter((row) => row.won).length / versusAi.length
    byFoe[foe] = { vsRule: round(ruleWins), vsAi: round(aiWins), games: versusRule.length }
    console.log(`${personality} vs ${foe}  rules ${ruleWins.toFixed(3)}  es ${aiWins.toFixed(3)}  n=${versusRule.length}`)
  }
  table.push({ personality, byFoe })
}

let state = createSim({ shipCount: 100, commanders: ['balanced', 'fierce'] })
state = dispatch(state, { type: 'set-fleet-brain', fleet: 0, brain: 'dt' })
state = dispatch(state, { type: 'start' })
const fleet = state.fleets[0]
const observation = observe(state, 0)
const samples = []
for (let i = 0; i < 20; i++) {
  const started = performance.now()
  decideTransformer(fleet, observation)
  samples.push(performance.now() - started)
}
samples.sort((a, b) => a - b)
const median = samples[Math.floor(samples.length / 2)] ?? 0
console.log(`decision median ${median.toFixed(3)} ms`)
console.log(JSON.stringify(table))
