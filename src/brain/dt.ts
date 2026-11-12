import { DIVISION_NAMES, type BrainOrder } from '../types.ts'
import { tacticById } from '../tactics.ts'
import { featurize, INPUT_SIZE } from './features.ts'
import type { DivisionView, Observation } from './observe.ts'
import type { BrainDecision } from './orders.ts'
import { POLICY_TACTICS } from './policy.ts'
import bundled from './weights/dt.json'

/** Timesteps of (return, observation, previous action) the transformer can see. */
export const DT_CONTEXT = 16
export const DT_MODEL = 96
export const DT_LAYERS = 4
export const DT_HEADS = 4
export const DT_FF = 192
const SLOTS = 5
const TACTICS = POLICY_TACTICS.length
const ACT = SLOTS * TACTICS
const EMBED = 1 + INPUT_SIZE + ACT

export interface DtBlock {
  ln1w: number[]
  ln1b: number[]
  wq: number[]
  bq: number[]
  wk: number[]
  bk: number[]
  wv: number[]
  bv: number[]
  wo: number[]
  bo: number[]
  ln2w: number[]
  ln2b: number[]
  w1: number[]
  b1: number[]
  w2: number[]
  b2: number[]
}

export interface DtWeights {
  dModel: number
  layers: number
  heads: number
  ff: number
  context: number
  obs: number
  target: number
  embedW: number[]
  embedB: number[]
  pos: number[]
  blocks: DtBlock[]
  headW: number[]
  headB: number[]
  probe?: number[]
  probePast?: number[]
  /** High return for 猛将, 智将, 守将, 常勝, in that order. */
  targets?: number[]
}

const COMMANDER_AT = 5 * 8 * 2 + 6 * 2

interface Step {
  obs: Float64Array
  act: number[]
}

const history = new WeakMap<object, Step[]>()
let override: DtWeights | null | undefined
let recorder: ((fleet: number, obs: Float64Array, act: number[]) => void) | null = null

export function setDecisionRecorder(fn: ((fleet: number, obs: Float64Array, act: number[]) => void) | null): void {
  recorder = fn
}

export function recordDecision(fleet: number, obs: Float64Array, act: number[]): void {
  recorder?.(fleet, obs, act)
}

export function tacticsFrom(observation: Observation, orders: BrainOrder[]): number[] {
  const action = Array<number>(SLOTS).fill(-1)
  for (const order of orders) {
    const division = observation.divisions.find((item) => item.id === order.division)
    if (!division) continue
    const index = POLICY_TACTICS.indexOf(order.tacticId as (typeof POLICY_TACTICS)[number])
    if (index >= 0) action[division.slot] = index
  }
  return action
}

export function useDtWeights(weights: DtWeights | null): void {
  override = weights === null ? undefined : weights
}

export function forgetTransformer(fleet: object): void {
  history.delete(fleet)
}

function bundledWeights(): DtWeights | null {
  return valid(bundled) ? (bundled as DtWeights) : null
}

function valid(raw: unknown): raw is DtWeights {
  if (!raw || typeof raw !== 'object') return false
  const weights = raw as DtWeights
  return (
    weights.dModel === DT_MODEL &&
    weights.layers === DT_LAYERS &&
    weights.heads === DT_HEADS &&
    weights.ff === DT_FF &&
    weights.context === DT_CONTEXT &&
    weights.obs === INPUT_SIZE &&
    Array.isArray(weights.blocks) &&
    weights.blocks.length === DT_LAYERS &&
    weights.embedW?.length === EMBED * DT_MODEL &&
    weights.pos?.length === DT_CONTEXT * DT_MODEL &&
    weights.headW?.length === DT_MODEL * ACT
  )
}

function current(): DtWeights | null {
  if (override !== undefined) return valid(override) ? override : null
  return bundledWeights()
}

const MAX_TOKENS = DT_CONTEXT
const GELU_SCALE = Math.sqrt(2 / Math.PI)

interface PackedBlock {
  ln1w: Float64Array
  ln1b: Float64Array
  wq: Float64Array
  bq: Float64Array
  wk: Float64Array
  bk: Float64Array
  wv: Float64Array
  bv: Float64Array
  wo: Float64Array
  bo: Float64Array
  ln2w: Float64Array
  ln2b: Float64Array
  w1: Float64Array
  b1: Float64Array
  w2: Float64Array
  b2: Float64Array
}

interface PackedWeights {
  source: DtWeights
  embedW: Float64Array
  embedB: Float64Array
  pos: Float64Array
  headW: Float64Array
  headB: Float64Array
  blocks: PackedBlock[]
}

const packedCache = new WeakMap<DtWeights, PackedWeights>()
const tokenBuf = new Float64Array(MAX_TOKENS * DT_MODEL)
const normBuf = new Float64Array(MAX_TOKENS * DT_MODEL)
const queryBuf = new Float64Array(MAX_TOKENS * DT_MODEL)
const keyBuf = new Float64Array(MAX_TOKENS * DT_MODEL)
const valueBuf = new Float64Array(MAX_TOKENS * DT_MODEL)
const mixedBuf = new Float64Array(MAX_TOKENS * DT_MODEL)
const hiddenBuf = new Float64Array(MAX_TOKENS * DT_FF)
const scoreBuf = new Float64Array(MAX_TOKENS)
const embedBuf = new Float64Array(EMBED)

function pack(weights: DtWeights): PackedWeights {
  const cached = packedCache.get(weights)
  if (cached) return cached
  const block = (raw: DtBlock): PackedBlock => ({
    ln1w: Float64Array.from(raw.ln1w),
    ln1b: Float64Array.from(raw.ln1b),
    wq: Float64Array.from(raw.wq),
    bq: Float64Array.from(raw.bq),
    wk: Float64Array.from(raw.wk),
    bk: Float64Array.from(raw.bk),
    wv: Float64Array.from(raw.wv),
    bv: Float64Array.from(raw.bv),
    wo: Float64Array.from(raw.wo),
    bo: Float64Array.from(raw.bo),
    ln2w: Float64Array.from(raw.ln2w),
    ln2b: Float64Array.from(raw.ln2b),
    w1: Float64Array.from(raw.w1),
    b1: Float64Array.from(raw.b1),
    w2: Float64Array.from(raw.w2),
    b2: Float64Array.from(raw.b2),
  })
  const prepared: PackedWeights = {
    source: weights,
    embedW: Float64Array.from(weights.embedW),
    embedB: Float64Array.from(weights.embedB),
    pos: Float64Array.from(weights.pos),
    headW: Float64Array.from(weights.headW),
    headB: Float64Array.from(weights.headB),
    blocks: weights.blocks.map(block),
  }
  packedCache.set(weights, prepared)
  return prepared
}

function gemv(
  out: Float64Array,
  outAt: number,
  input: Float64Array,
  inAt: number,
  weight: Float64Array,
  bias: Float64Array,
  inSize: number,
  outSize: number,
): void {
  for (let row = 0; row < outSize; row++) {
    let sum = bias[row] ?? 0
    const at = row * inSize
    let col = 0
    for (; col + 3 < inSize; col += 4) {
      sum +=
        weight[at + col]! * input[inAt + col]! +
        weight[at + col + 1]! * input[inAt + col + 1]! +
        weight[at + col + 2]! * input[inAt + col + 2]! +
        weight[at + col + 3]! * input[inAt + col + 3]!
    }
    for (; col < inSize; col++) sum += weight[at + col]! * input[inAt + col]!
    out[outAt + row] = sum
  }
}

function layerNormInto(
  dest: Float64Array,
  destAt: number,
  input: Float64Array,
  inAt: number,
  weight: Float64Array,
  bias: Float64Array,
  width: number,
): void {
  let mean = 0
  for (let i = 0; i < width; i++) mean += input[inAt + i]!
  mean /= width
  let variance = 0
  for (let i = 0; i < width; i++) {
    const delta = input[inAt + i]! - mean
    variance += delta * delta
  }
  const inv = 1 / Math.sqrt(variance / width + 1e-5)
  for (let i = 0; i < width; i++) dest[destAt + i] = (input[inAt + i]! - mean) * inv * weight[i]! + bias[i]!
}

function blockForwardPacked(count: number, block: PackedBlock): void {
  const width = DT_MODEL
  const span = width / DT_HEADS
  const scale = 1 / Math.sqrt(span)
  for (let token = 0; token < count; token++) {
    const at = token * width
    layerNormInto(normBuf, at, tokenBuf, at, block.ln1w, block.ln1b, width)
    gemv(queryBuf, at, normBuf, at, block.wq, block.bq, width, width)
    gemv(keyBuf, at, normBuf, at, block.wk, block.bk, width, width)
    gemv(valueBuf, at, normBuf, at, block.wv, block.bv, width, width)
  }
  mixedBuf.fill(0, 0, count * width)
  for (let head = 0; head < DT_HEADS; head++) {
    const offset = head * span
    for (let row = 0; row < count; row++) {
      let max = -1e9
      const qAt = row * width + offset
      for (let col = 0; col <= row; col++) {
        const kAt = col * width + offset
        let dot = 0
        for (let k = 0; k < span; k++) dot += queryBuf[qAt + k]! * keyBuf[kAt + k]!
        const scored = dot * scale
        scoreBuf[col] = scored
        if (scored > max) max = scored
      }
      let normal = 0
      for (let col = 0; col <= row; col++) {
        const weight = Math.exp(scoreBuf[col]! - max)
        scoreBuf[col] = weight
        normal += weight
      }
      const acc = row * width + offset
      const inv = 1 / normal
      for (let col = 0; col <= row; col++) {
        const weight = scoreBuf[col]! * inv
        const vAt = col * width + offset
        for (let k = 0; k < span; k++) mixedBuf[acc + k] = mixedBuf[acc + k]! + weight * valueBuf[vAt + k]!
      }
    }
  }
  for (let token = 0; token < count; token++) {
    const at = token * width
    gemv(normBuf, at, mixedBuf, at, block.wo, block.bo, width, width)
    for (let i = 0; i < width; i++) tokenBuf[at + i] = tokenBuf[at + i]! + normBuf[at + i]!
    layerNormInto(normBuf, at, tokenBuf, at, block.ln2w, block.ln2b, width)
    gemv(hiddenBuf, token * DT_FF, normBuf, at, block.w1, block.b1, width, DT_FF)
    const hAt = token * DT_FF
    for (let i = 0; i < DT_FF; i++) {
      const value = hiddenBuf[hAt + i]!
      const inner = GELU_SCALE * (value + 0.044715 * value * value * value)
      hiddenBuf[hAt + i] = 0.5 * value * (1 + Math.tanh(inner))
    }
    gemv(normBuf, at, hiddenBuf, hAt, block.w2, block.b2, DT_FF, width)
    for (let i = 0; i < width; i++) tokenBuf[at + i] = tokenBuf[at + i]! + normBuf[at + i]!
  }
}

/** Logits for the five divisions, given the return we want and the recent decisions. */
export function transformerLogits(observation: Float64Array, past: readonly Step[], target: number, weights: DtWeights): Float64Array {
  const prepared = pack(weights)
  const width = weights.dModel
  const steps = past.slice(-(weights.context - 1))
  let count = 0
  const previous = new Float64Array(ACT)
  const push = (obs: Float64Array) => {
    embedBuf[0] = target
    for (let i = 0; i < obs.length; i++) embedBuf[1 + i] = obs[i] ?? 0
    for (let i = 0; i < ACT; i++) embedBuf[1 + obs.length + i] = previous[i] ?? 0
    const at = count * width
    gemv(tokenBuf, at, embedBuf, 0, prepared.embedW, prepared.embedB, EMBED, width)
    for (let i = 0; i < width; i++) tokenBuf[at + i] = tokenBuf[at + i]! + prepared.pos[at + i]!
    count += 1
  }
  for (const step of steps) {
    push(step.obs)
    previous.fill(0)
    for (let slot = 0; slot < SLOTS; slot++) {
      const tactic = step.act[slot] ?? -1
      if (tactic >= 0 && tactic < TACTICS) previous[slot * TACTICS + tactic] = 1
    }
  }
  push(observation)
  for (const block of prepared.blocks) blockForwardPacked(count, block)
  const last = (count - 1) * width
  const logits = new Float64Array(ACT)
  gemv(logits, 0, tokenBuf, last, prepared.headW, prepared.headB, width, ACT)
  return logits
}

function nearestEnemy(observation: Observation, division: DivisionView): number | undefined {
  let best = -1
  let bestRange = Infinity
  for (const enemy of observation.divisions) {
    if (enemy.fleet !== observation.enemy.index || enemy.alive === 0) continue
    const range = Math.hypot(enemy.x - division.x, enemy.y - division.y)
    if (range < bestRange) {
      bestRange = range
      best = enemy.id
    }
  }
  return best >= 0 ? best : undefined
}

export function decideTransformer(fleet: object, observation: Observation): BrainDecision | null {
  const weights = current()
  if (!weights) return null
  const features = featurize(observation)
  const past = history.get(fleet) ?? []
  const logits = transformerLogits(features, past, desiredReturn(features, weights), weights)
  const action: number[] = []
  const orders: BrainOrder[] = []
  const notes: string[] = []
  for (let slot = 0; slot < SLOTS; slot++) {
    const division = observation.divisions.find((item) => item.fleet === observation.fleet && item.slot === slot && item.alive > 0)
    if (!division) {
      action.push(-1)
      continue
    }
    let best = 0
    let bestValue = -Infinity
    const offset = slot * TACTICS
    for (let tactic = 0; tactic < TACTICS; tactic++) {
      const value = logits[offset + tactic] ?? 0
      if (value > bestValue) {
        bestValue = value
        best = tactic
      }
    }
    action.push(best)
    const tacticId = POLICY_TACTICS[best] ?? 'hold'
    const enemy = nearestEnemy(observation, division)
    orders.push(enemy === undefined ? { division: division.id, tacticId } : { division: division.id, tacticId, target: enemy })
    notes.push(`${DIVISION_NAMES[slot]} ${tacticById(tacticId).name}`)
  }
  if (orders.length === 0) return null
  const next = past.slice(-(DT_CONTEXT - 1))
  next.push({ obs: features, act: action })
  history.set(fleet, next)
  return { orders, note: `DT ${notes.join('、')}` }
}

function desiredReturn(observation: Float64Array, weights: DtWeights): number {
  const targets = weights.targets
  if (!targets || targets.length < 4) return weights.target
  for (let i = 0; i < 4; i++) {
    if ((observation[COMMANDER_AT + i] ?? 0) > 0.5) return targets[i] ?? weights.target
  }
  return weights.target
}

/** Zero-observation logits, used to check the TypeScript pass against the trainer. */
export function probeLogits(weights: DtWeights = bundled as DtWeights): Float64Array | null {
  if (!valid(weights)) return null
  return transformerLogits(new Float64Array(INPUT_SIZE), [], weights.target, weights)
}
