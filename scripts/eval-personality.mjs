/**
 * Held-out win rates and personality stats for every AI commander.
 * Seeds are 101 and up, which training never uses.
 *
 *   npm run eval:personality
 */
import { FORMATION_IDS } from '../src/types.ts'
import { PERSONALITIES } from '../src/brain/fitness.ts'
import { playMatch } from '../src/brain/match.ts'

const only = process.argv.includes('--personality') ? process.argv[process.argv.indexOf('--personality') + 1] : null
const HELDOUT = [101, 102]
const FORMS = [...FORMATION_IDS]

function mean(values) {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

function run(personality, foe, ownForm, foeForm, seed, swap, brain) {
  const commanders = swap ? [foe, personality] : [personality, foe]
  const formations = swap ? [foeForm, ownForm] : [ownForm, foeForm]
  const focus = swap ? 1 : 0
  const brains = brain === 'ai' ? (swap ? ['rule', 'ai'] : ['ai', 'rule']) : ['rule', 'rule']
  return playMatch({ commanders, formations, seed, brains, focus, timeout: 90 })
}

const table = []
for (const personality of PERSONALITIES.filter((id) => !only || id === only)) {
  const byFoe = {}
  for (const foe of PERSONALITIES) {
    const ai = []
    const rule = []
    for (const ownForm of FORMS) {
      for (const foeForm of FORMS) {
        for (const seed of HELDOUT) {
          for (const swap of [false, true]) {
            const packed = (Math.imul(seed, 0x9e3779b1) + (swap ? 17 : 0) + ownForm.length * 3 + foeForm.length) | 0
            ai.push(run(personality, foe, ownForm, foeForm, packed, swap, 'ai'))
            rule.push(run(personality, foe, ownForm, foeForm, packed, swap, 'rule'))
          }
        }
      }
    }
    const wins = ai.filter((row) => row.won).length / ai.length
    byFoe[foe] = {
      win: round(wins),
      games: ai.length,
      ai: summarize(ai),
      rule: summarize(rule),
    }
    console.log(`${personality} vs ${foe} ${wins.toFixed(3)} contact ${byFoe[foe].ai.contact}s/${byFoe[foe].rule.contact}s exchange ${byFoe[foe].ai.exchange}/${byFoe[foe].rule.exchange} exposure ${byFoe[foe].ai.exposure}/${byFoe[foe].rule.exposure}`)
  }
  table.push({ personality, byFoe })
}

function summarize(rows) {
  return {
    contact: round(mean(rows.map((row) => row.contactTime))),
    exchange: round(mean(rows.map((row) => row.exchange))),
    exposure: round(mean(rows.map((row) => row.exposure))),
    flank: round(mean(rows.map((row) => row.flank))),
    assault: round(mean(rows.map((row) => row.assault))),
    alive: round(mean(rows.map((row) => row.alive))),
    cohesion: round(mean(rows.map((row) => row.cohesion))),
  }
}

console.log(JSON.stringify(table))
