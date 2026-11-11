import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createSim, dispatch } from '../src/sim.ts'
import { INPUT_SIZE } from '../src/brain/features.ts'
import { HIDDEN, OUTPUT_SIZE, paramCount, unpack, usePolicy } from '../src/brain/policy.ts'

const GENS = Number(process.argv.find((arg, i, list) => list[i - 1] === '--gens') ?? 14)
const PAIRS = 8
const SIGMA = 0.2
const LEARNING = 0.12
const DIM = paramCount()
const FOES = ['fierce', 'cunning', 'guard', 'balanced']
const FORMS = ['oujin', 'kakuyoku', 'engetsu', 'gyorin']

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

function play(aiSide, foe, ownForm, foeForm, seed) {
  const commanders = aiSide === 0 ? ['balanced', foe] : [foe, 'balanced']
  const formations = aiSide === 0 ? [ownForm, foeForm] : [foeForm, ownForm]
  let state = createSim({ shipCount: 100, commanders, formations })
  state.rng = seed | 0
  state = dispatch(state, { type: 'set-fleet-brain', fleet: aiSide, brain: 'ai' })
  state = dispatch(state, { type: 'set-speed', speed: 4 })
  state = dispatch(state, { type: 'start' })
  let steps = 0
  while (state.phase.kind === 'running' && state.time < 80 && steps < 2200) {
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    steps += 1
  }
  const won = state.phase.kind === 'finished' ? state.phase.winner === aiSide : state.alive[aiSide] > state.alive[1 - aiSide]
  const margin = state.alive[aiSide] / Math.max(1, state.alive[0] + state.alive[1])
  return (won ? 1 : 0) + 0.15 * margin
}

function fitness(flat, salt) {
  let total = 0
  const games = 8
  for (let i = 0; i < games; i++) {
    const foe = FOES[i % FOES.length]
    const ownForm = FORMS[i % FORMS.length]
    const foeForm = FORMS[(i + 1) % FORMS.length]
    const seed = (Math.imul(1 + (salt + i) % 8, 0x9e3779b1) + i) | 0
    usePolicy(unpack(flat))
    total += play(i % 2, foe, ownForm, foeForm, seed)
  }
  return total / games
}

function add(theta, noise, scale) {
  const next = new Float64Array(theta.length)
  for (let i = 0; i < theta.length; i++) next[i] = theta[i] + noise[i] * scale
  return next
}

const rng = mulberry32(20261110 + GENS)
const savedPath = 'src/brain/weights.json'
let theta = new Float64Array(DIM)
let curve = []
if (!process.argv.includes('--fresh') && existsSync(savedPath)) {
  const saved = JSON.parse(readFileSync(savedPath, 'utf8'))
  const packed = [...saved.w1, ...saved.b1, ...saved.w2, ...saved.b2]
  if (packed.length === DIM) theta = Float64Array.from(packed)
  if (Array.isArray(saved.curve)) curve = saved.curve
  console.log(`resume from ${savedPath}, curve ${curve.length}`)
} else {
  for (let i = 0; i < DIM; i++) theta[i] = gaussian(rng) * 0.05
}
let bestTheta = Float64Array.from(theta)
let bestCenter = fitness(theta, 500)
console.log(`params ${DIM} input ${INPUT_SIZE} hidden ${HIDDEN} output ${OUTPUT_SIZE} gens ${GENS} probe ${bestCenter.toFixed(3)}`)
const started = Date.now()
const startGen = curve.length
for (let gen = startGen; gen < startGen + GENS; gen++) {
  const noises = []
  const scores = []
  for (let pair = 0; pair < PAIRS; pair++) {
    const noise = new Float64Array(DIM)
    for (let i = 0; i < DIM; i++) noise[i] = gaussian(rng)
    noises.push(noise)
    scores.push(fitness(add(theta, noise, SIGMA), gen * 20 + pair))
    scores.push(fitness(add(theta, noise, -SIGMA), gen * 20 + pair + 9))
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
  for (let i = 0; i < DIM; i++) theta[i] += (LEARNING / PAIRS) * grad[i]
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length
  const best = Math.max(...scores)
  const center = fitness(theta, 500)
  if (center >= bestCenter) {
    bestCenter = center
    bestTheta = Float64Array.from(theta)
  }
  curve.push({ gen, mean: round(mean), best: round(best), center: round(center) })
  console.log(`gen ${gen} mean ${mean.toFixed(3)} best ${best.toFixed(3)} center ${center.toFixed(3)}`)
}
theta = bestTheta

function round(value) {
  return Math.round(value * 1000) / 1000
}

const weights = { version: 1, ...unpack(theta), curve }
mkdirSync('src/brain', { recursive: true })
writeFileSync('src/brain/weights.json', JSON.stringify(weights))
writeFileSync('src/brain/train-log.json', JSON.stringify({ seconds: Math.round((Date.now() - started) / 1000), curve }, null, 2))
console.log(`wrote weights in ${Math.round((Date.now() - started) / 1000)}s`)
usePolicy(null)
