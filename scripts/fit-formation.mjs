/**
 * Fit the formation table for AI 常勝. Tuning seeds only. Writes src/brain/formation.json.
 *   npm run fit:formation
 */
import { writeFileSync } from 'node:fs'
import { FORMATION_IDS } from '../src/types.ts'
import { playMatch } from '../src/brain/match.ts'

const forms = [...FORMATION_IDS]
const foes = ['balanced', 'fierce', 'cunning', 'guard']
const tune = [1, 2, 3, 4]
const held = [101, 102]

function rate(own, foeForm, foe, seeds) {
  let wins = 0
  let games = 0
  for (const seed of seeds) {
    for (const swap of [false, true]) {
      const report = playMatch({
        commanders: swap ? [foe, 'balanced'] : ['balanced', foe],
        formations: swap ? [foeForm, own] : [own, foeForm],
        brains: swap ? ['rule', 'ai'] : ['ai', 'rule'],
        focus: swap ? 1 : 0,
        seed: (Math.imul(seed, 0x9e3779b1) + (swap ? 17 : 0) + own.length * 3 + foeForm.length) | 0,
        timeout: 80,
      })
      games += 1
      if (report.won) wins += 1
    }
  }
  return wins / games
}

const table = {}
for (const foeForm of forms) {
  let best = forms[0]
  let bestScore = -1
  for (const own of forms) {
    const mirror = rate(own, foeForm, 'balanced', tune)
    let others = 0
    for (const foe of foes.slice(1)) others += rate(own, foeForm, foe, [1, 2])
    const score = mirror * 2 + others / 3
    if (score > bestScore) {
      bestScore = score
      best = own
    }
    process.stdout.write(`${foeForm} <- ${own} mirror ${mirror.toFixed(2)} mix ${score.toFixed(2)}\n`)
  }
  table[foeForm] = best
  console.log('pick', foeForm, best, bestScore.toFixed(2))
}

let wins = 0
let games = 0
const byFoe = {}
for (const foe of foes) {
  let foeWins = 0
  let foeGames = 0
  for (const foeForm of forms) {
    const own = table[foeForm]
    for (const seed of held) {
      for (const swap of [false, true]) {
        const report = playMatch({
          commanders: swap ? [foe, 'balanced'] : ['balanced', foe],
          formations: swap ? [foeForm, own] : [own, foeForm],
          brains: swap ? ['rule', 'ai'] : ['ai', 'rule'],
          focus: swap ? 1 : 0,
          seed: (Math.imul(seed, 0x9e3779b1) + (swap ? 17 : 0) + own.length * 3 + foeForm.length) | 0,
          timeout: 90,
        })
        games += 1
        foeGames += 1
        if (report.won) {
          wins += 1
          foeWins += 1
        }
      }
    }
  }
  byFoe[foe] = foeWins / foeGames
  console.log('held', foe, byFoe[foe].toFixed(3))
}
console.log('table', JSON.stringify(table))
writeFileSync('src/brain/formation.json', JSON.stringify({ balanced: table }, null, 2))
