/**
 * Train one personality, or all four in a round robin.
 *
 *   npm run train:policy -- --personality fierce --gens 12
 *   npm run train:policy -- --personality all
 *   npm run train:policy -- --personality balanced --fresh
 *
 * A run continues from src/brain/weights/<id>.json. --fresh starts from the
 * 常勝 file (or small noise) and applies INITIAL_BIAS once. Seeds stay inside
 * 1..8. Held-out seeds begin at 101 and are not used here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { FORMATION_IDS } from '../src/types.ts'
import { PERSONALITIES, scoreBattle, scoreSuite } from '../src/brain/fitness.ts'
import { playMatch } from '../src/brain/match.ts'
import { applyInitialBias, pack, paramCount, policyFor, unpack } from '../src/brain/policy.ts'

const args = process.argv.slice(2)
function flag(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}
const requested = flag('--personality', 'all')
const gensFlag = args.includes('--gens') ? Number(flag('--gens', '12')) : null
const fresh = args.includes('--fresh')
const personalities = requested === 'all' ? [...PERSONALITIES] : [requested]
if (!personalities.every((id) => PERSONALITIES.includes(id))) {
  console.error(`personality must be one of ${PERSONALITIES.join(', ')} or all`)
  process.exit(1)
}

const PAIRS = 8
const SIGMA = 0.18
const LEARNING = 0.1
const DIM = paramCount()
const FORMS = [...FORMATION_IDS]
const FOES = [...PERSONALITIES]
const TUNING = [1, 2, 3, 4, 5, 6, 7, 8]
const GENS = {
  fierce: gensFlag ?? 12,
  cunning: gensFlag ?? 12,
  guard: gensFlag ?? 12,
  balanced: gensFlag ?? 20,
}

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

function tuningSeed(salt) {
  const base = TUNING[Math.abs(salt) % TUNING.length]
  return (Math.imul(base, 0x9e3779b1) ^ Math.imul(salt, 13)) | 0
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function loadTheta(personality) {
  const path = `src/brain/weights/${personality}.json`
  const logPath = `src/brain/logs/${personality}.json`
  const curve = existsSync(logPath) ? readJson(logPath).curve ?? [] : []
  if (!fresh && existsSync(path)) {
    const saved = readJson(path)
    const flat = pack(saved)
    if (flat.length === DIM) return { theta: flat, curve, biased: curve.length > 0 }
  }
  const seed = policyFor('balanced')
  const theta = seed ? pack(seed) : new Float64Array(DIM)
  if (!seed) {
    const rng = mulberry32(1000 + personality.length)
    for (let i = 0; i < DIM; i++) theta[i] = gaussian(rng) * 0.05
  }
  return { theta, curve: fresh ? [] : curve, biased: false }
}

function balancedGames(salt, rulesOnly) {
  const games = []
  const mirror = rulesOnly ? 6 : 8
  for (let i = 0; i < mirror; i++) {
    games.push({
      form: FORMS[i % FORMS.length],
      foeForm: FORMS[(i * 2 + (rulesOnly ? 1 : salt)) % FORMS.length],
      foe: 'balanced',
      kind: 'rule',
      side: i % 2,
      seed: tuningSeed((rulesOnly ? 500 : salt) * 20 + i + 1),
    })
  }
  const others = ['fierce', 'cunning', 'guard']
  for (let i = 0; i < others.length; i++) {
    games.push({
      form: FORMS[(rulesOnly ? i : salt + i) % FORMS.length],
      foeForm: FORMS[(rulesOnly ? i + 3 : salt + i + 2) % FORMS.length],
      foe: others[i],
      kind: 'rule',
      side: i % 2,
      seed: tuningSeed((rulesOnly ? 700 : salt) * 20 + 40 + i),
    })
  }
  if (!rulesOnly) {
    games.push({
      form: FORMS[salt % FORMS.length],
      foeForm: FORMS[(salt + 4) % FORMS.length],
      foe: 'balanced',
      kind: 'self',
      side: salt % 2,
      seed: tuningSeed(salt * 20 + 80),
    })
  }
  return games
}

function gamesFor(personality, salt, rulesOnly) {
  if (personality === 'balanced') return balancedGames(salt, rulesOnly)
  const count = 8
  const games = []
  for (let i = 0; i < count; i++) {
    const form = FORMS[(salt + i) % FORMS.length]
    const foeForm = FORMS[(salt + i * 2 + 1) % FORMS.length]
    const foe = FOES[(salt + i) % FOES.length]
    const league = !rulesOnly && i % 5 === 4
    const self = !rulesOnly && i % 5 === 3
    games.push({
      form,
      foeForm,
      foe: self ? personality : foe,
      kind: league ? 'league' : self ? 'self' : 'rule',
      side: i % 2,
      seed: tuningSeed(salt * 20 + i + 1),
    })
  }
  return games
}

function checkpointOf(bank, owner, salt) {
  const list = bank[owner]
  if (!list || list.length === 0) return null
  return list[Math.abs(salt) % list.length]
}

function evaluate(personality, flat, salt, bank, rulesOnly = false) {
  const weights = unpack(flat)
  const scores = []
  let mirrorWins = 0
  let mirrorGames = 0
  for (const game of gamesFor(personality, salt, rulesOnly)) {
    let foe = game.foe
    let foeWeights
    let foeBrain = 'rule'
    if (game.kind === 'league') {
      const others = PERSONALITIES.filter((id) => id !== personality)
      foe = others[Math.abs(salt + game.seed) % others.length]
      foeWeights = checkpointOf(bank, foe, salt)
      foeBrain = foeWeights ? 'ai' : 'rule'
    } else if (game.kind === 'self') {
      foeWeights = checkpointOf(bank, personality, salt + 1)
      foeBrain = foeWeights ? 'ai' : 'rule'
    }
    const commanders = game.side === 0 ? [personality, foe] : [foe, personality]
    const formations = game.side === 0 ? [game.form, game.foeForm] : [game.foeForm, game.form]
    const installed = [undefined, undefined]
    installed[game.side] = weights
    if (foeBrain === 'ai' && foeWeights) installed[1 - game.side] = unpack(foeWeights)
    const brains = ['rule', 'rule']
    brains[game.side] = 'ai'
    if (foeBrain === 'ai') brains[1 - game.side] = 'ai'
    const report = playMatch({
      commanders,
      formations,
      seed: game.seed,
      brains,
      weights: installed,
      focus: game.side,
    })
    scores.push(scoreBattle(personality, report))
    if (foe === 'balanced' && foeBrain === 'rule') {
      mirrorGames += 1
      if (report.won) mirrorWins += 1
    }
  }
  return { score: scoreSuite(personality, scores), mirrorWins, mirrorGames }
}

function add(theta, noise, scale) {
  const next = new Float64Array(theta.length)
  for (let i = 0; i < theta.length; i++) next[i] = theta[i] + noise[i] * scale
  return next
}

function save(personality, theta, curve, seconds) {
  mkdirSync('src/brain/weights', { recursive: true })
  mkdirSync('src/brain/logs', { recursive: true })
  const weights = { version: 1, personality, ...unpack(theta) }
  writeFileSync(`src/brain/weights/${personality}.json`, JSON.stringify(weights))
  writeFileSync(
    `src/brain/logs/${personality}.json`,
    JSON.stringify({ personality, seconds, curve }, null, 2),
  )
}

const rng = mulberry32(20261111)
const theta = {}
const curve = {}
const bestTheta = {}
const bestProbe = {}
const bank = {}
const startedAt = {}
for (const personality of personalities) {
  const loaded = loadTheta(personality)
  theta[personality] = loaded.theta
  curve[personality] = loaded.curve
  if (!loaded.biased) applyInitialBias(theta[personality], personality)
  bestTheta[personality] = Float64Array.from(theta[personality])
  bank[personality] = [Float64Array.from(theta[personality])]
  startedAt[personality] = Date.now()
  const opening = evaluate(personality, theta[personality], 800 + personality.length * 17, bank, true)
  bestProbe[personality] = opening.score
  console.log(`${personality} start ${opening.score.toFixed(3)} mirror ${opening.mirrorWins}/${opening.mirrorGames} gens ${GENS[personality]}`)
}
for (const id of PERSONALITIES) {
  if (bank[id]) continue
  const saved = policyFor(id)
  bank[id] = saved ? [pack(saved)] : []
}

const limit = Math.max(...personalities.map((id) => GENS[id]))
for (let step = 0; step < limit; step++) {
  for (const personality of personalities) {
    if (step >= GENS[personality]) continue
    const gen = curve[personality].length
    const noises = []
    const scores = []
    const sigma = personality === 'balanced' ? 0.1 : SIGMA
    const learning = personality === 'balanced' ? 0.06 : LEARNING
    for (let pair = 0; pair < PAIRS; pair++) {
      const noise = new Float64Array(DIM)
      for (let i = 0; i < DIM; i++) noise[i] = gaussian(rng)
      noises.push(noise)
      const salt = gen * 30 + pair + personality.length * 100
      scores.push(evaluate(personality, add(theta[personality], noise, sigma), salt, bank).score)
      scores.push(evaluate(personality, add(theta[personality], noise, -sigma), salt + 9, bank).score)
    }
    const order = scores.map((score, index) => ({ score, index })).sort((a, b) => a.score - b.score)
    const shaped = new Float64Array(scores.length)
    order.forEach((item, rank) => {
      shaped[item.index] = (rank / (scores.length - 1)) * 2 - 1
    })
    const grad = new Float64Array(DIM)
    for (let pair = 0; pair < PAIRS; pair++) {
      const scale = (shaped[pair * 2] - shaped[pair * 2 + 1]) / 2
      const noise = noises[pair]
      for (let i = 0; i < DIM; i++) grad[i] += noise[i] * scale
    }
    const next = theta[personality]
    for (let i = 0; i < DIM; i++) next[i] += (learning / PAIRS) * grad[i]
    const probe = evaluate(personality, next, 800 + personality.length * 17, bank, true)
    if (probe.score >= bestProbe[personality]) {
      bestProbe[personality] = probe.score
      bestTheta[personality] = Float64Array.from(next)
    }
    bank[personality].push(Float64Array.from(bestTheta[personality]))
    if (bank[personality].length > 6) bank[personality].shift()
    const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length
    const row = {
      gen,
      mean: Math.round(mean * 1000) / 1000,
      best: Math.round(Math.max(...scores) * 1000) / 1000,
      center: Math.round(probe.score * 1000) / 1000,
      mirror: probe.mirrorGames > 0 ? Math.round((probe.mirrorWins / probe.mirrorGames) * 1000) / 1000 : null,
    }
    curve[personality].push(row)
    const seconds = Math.round((Date.now() - startedAt[personality]) / 1000)
    save(personality, bestTheta[personality], curve[personality], seconds)
    const mirror = probe.mirrorGames > 0 ? ` mirror ${probe.mirrorWins}/${probe.mirrorGames}` : ''
    console.log(`${personality} gen ${gen} mean ${mean.toFixed(3)} best ${row.best.toFixed(3)} probe ${probe.score.toFixed(3)}${mirror}`)
  }
}

for (const personality of personalities) {
  save(personality, bestTheta[personality], curve[personality], Math.round((Date.now() - startedAt[personality]) / 1000))
  console.log(`${personality} kept probe ${bestProbe[personality].toFixed(3)}`)
}
