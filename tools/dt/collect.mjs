/**
 * Log decision trajectories for the Decision Transformer.
 * Training seeds stay in 1..8. Held-out seeds start at 101.
 * The return is the personality fitness of the learner's fleet.
 *
 *   npm run dt:collect
 *   npm run dt:collect -- --games 40 --brain dt --out tools/dt/data/online.jsonl
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { FORMATION_IDS } from '../../src/types.ts'
import { scoreBattle } from '../../src/brain/fitness.ts'
import { setDecisionRecorder } from '../../src/brain/dt.ts'
import { playMatch } from '../../src/brain/match.ts'

const personalities = ['fierce', 'cunning', 'guard', 'balanced']
const forms = [...FORMATION_IDS]
const games = Number(process.argv.find((arg, i, list) => list[i - 1] === '--games') ?? 120)
const learner = process.argv.includes('--brain') ? process.argv[process.argv.indexOf('--brain') + 1] : 'ai'
const outFile = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'tools/dt/data/trajectories.jsonl'

function tuningSeed(index) {
  const base = (index % 8) + 1
  return (Math.imul(base, 0x9e3779b1) ^ Math.imul(index + 1, 13)) | 0
}

function play(index) {
  const self = personalities[index % 4]
  const foe = personalities[(index * 3) % 4]
  const league = index % 5 === 0
  const side = index % 2
  const ownForm = forms[index % forms.length]
  const foeForm = forms[(index * 2) % forms.length]
  const commanders = side === 0 ? [self, foe] : [foe, self]
  const formations = side === 0 ? [ownForm, foeForm] : [foeForm, ownForm]
  const brains = side === 0 ? [learner, league ? 'ai' : 'rule'] : [league ? 'ai' : 'rule', learner]
  const steps = []
  setDecisionRecorder((fleet, obs, act) => {
    if (fleet !== side) return
    steps.push({ obs: Array.from(obs), act: [...act] })
  })
  const report = playMatch({
    commanders,
    formations,
    seed: tuningSeed(index),
    brains,
    focus: side,
    timeout: 70,
  })
  setDecisionRecorder(null)
  return {
    personality: self,
    foe,
    league,
    seed: tuningSeed(index),
    return: Math.round(scoreBattle(self, report) * 1000) / 1000,
    won: report.won,
    steps,
  }
}

const episodes = []
for (let index = 0; index < games; index++) episodes.push(play(index))
const lines = episodes.filter((episode) => episode.steps.length > 0)
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, lines.map((episode) => JSON.stringify(episode)).join('\n') + '\n')
const steps = lines.reduce((sum, episode) => sum + episode.steps.length, 0)
const wins = lines.filter((episode) => episode.won).length
console.log(`episodes ${lines.length} steps ${steps} wins ${wins}/${lines.length}`)
