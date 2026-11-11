import { DIVISION_NAMES, type BrainOrder, type TacticId } from '../types.ts'
import { tacticById } from '../tactics.ts'
import { featurize, INPUT_SIZE } from './features.ts'
import { INITIAL_BIAS, type Personality } from './fitness.ts'
import type { DivisionView, Observation } from './observe.ts'
import type { BrainDecision } from './orders.ts'
import fierceFile from './weights/fierce.json'
import cunningFile from './weights/cunning.json'
import guardFile from './weights/guard.json'
import balancedFile from './weights/balanced.json'

/** Tactics the policy may assign. Each is already in the rule commanders' vocabulary. */
export const POLICY_TACTICS = ['hold', 'charge', 'flank', 'rear', 'focus', 'breakthrough', 'pin', 'broadside'] as const satisfies readonly TacticId[]

export const HIDDEN = 32
export const OUTPUT_SIZE = 5 * POLICY_TACTICS.length
/** Sim seconds between decisions. The last orders keep running in between. */
export const DECISION_INTERVAL = 2

const FILES: Record<string, unknown> = {
  fierce: fierceFile,
  cunning: cunningFile,
  guard: guardFile,
  balanced: balancedFile,
}

export interface PolicyWeights {
  input: number
  hidden: number
  output: number
  w1: number[]
  b1: number[]
  w2: number[]
  b2: number[]
}

const fleetOverride: Array<PolicyWeights | undefined> = []
let globalOverride: PolicyWeights | undefined

export function loadPolicy(raw: unknown): PolicyWeights | null {
  if (!raw || typeof raw !== 'object') return null
  const weights = raw as PolicyWeights
  const fits =
    weights.input === INPUT_SIZE &&
    weights.hidden === HIDDEN &&
    weights.output === OUTPUT_SIZE &&
    Array.isArray(weights.w1) &&
    weights.w1.length === INPUT_SIZE * HIDDEN &&
    Array.isArray(weights.b1) &&
    weights.b1.length === HIDDEN &&
    Array.isArray(weights.w2) &&
    weights.w2.length === HIDDEN * OUTPUT_SIZE &&
    Array.isArray(weights.b2) &&
    weights.b2.length === OUTPUT_SIZE
  if (!fits) return null
  const values = [...weights.w1, ...weights.b1, ...weights.w2, ...weights.b2]
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return null
  return weights
}

/** The committed file for this commander. Manual, and any untrained id, have none. */
export function policyFor(commanderId: string): PolicyWeights | null {
  return loadPolicy(FILES[commanderId])
}

/** Tests force one weight set onto every fleet. Null clears that and uses the files. */
export function usePolicy(weights: PolicyWeights | null): void {
  globalOverride = weights === null ? undefined : weights
}

/** Training installs a candidate on one fleet without touching the other. */
export function useFleetPolicy(fleet: number, weights: PolicyWeights | undefined): void {
  fleetOverride[fleet] = weights
}

export function clearFleetPolicies(): void {
  fleetOverride.length = 0
}

export function currentPolicy(commanderId: string, fleet: number): PolicyWeights | null {
  const slotted = fleetOverride[fleet]
  if (slotted !== undefined) return slotted
  if (globalOverride !== undefined) return globalOverride
  return policyFor(commanderId)
}

export function paramCount(): number {
  return INPUT_SIZE * HIDDEN + HIDDEN + HIDDEN * OUTPUT_SIZE + OUTPUT_SIZE
}

export function pack(weights: PolicyWeights): Float64Array {
  return Float64Array.from([...weights.w1, ...weights.b1, ...weights.w2, ...weights.b2])
}

export function unpack(flat: ArrayLike<number>): PolicyWeights {
  const w1 = INPUT_SIZE * HIDDEN
  const b1 = w1 + HIDDEN
  const w2 = b1 + HIDDEN * OUTPUT_SIZE
  return {
    input: INPUT_SIZE,
    hidden: HIDDEN,
    output: OUTPUT_SIZE,
    w1: Array.from(flat).slice(0, w1),
    b1: Array.from(flat).slice(w1, b1),
    w2: Array.from(flat).slice(b1, w2),
    b2: Array.from(flat).slice(w2, w2 + OUTPUT_SIZE),
  }
}

/** Nudge a fresh weight vector toward the tactics that personality is scored on. */
export function applyInitialBias(flat: Float64Array, personality: Personality): void {
  const bias = INITIAL_BIAS[personality] as Partial<Record<TacticId, number>>
  const start = INPUT_SIZE * HIDDEN + HIDDEN + HIDDEN * OUTPUT_SIZE
  for (let tactic = 0; tactic < POLICY_TACTICS.length; tactic++) {
    const amount = bias[POLICY_TACTICS[tactic] ?? 'hold'] ?? 0
    if (amount === 0) continue
    for (let slot = 0; slot < 5; slot++) {
      const at = start + slot * POLICY_TACTICS.length + tactic
      flat[at] = (flat[at] ?? 0) + amount
    }
  }
}

export function forward(weights: PolicyWeights, input: Float64Array): Float64Array {
  const hidden = new Float64Array(weights.hidden)
  for (let neuron = 0; neuron < weights.hidden; neuron++) {
    let sum = weights.b1[neuron] ?? 0
    const row = neuron * weights.input
    for (let i = 0; i < weights.input; i++) sum += (weights.w1[row + i] ?? 0) * (input[i] ?? 0)
    hidden[neuron] = Math.tanh(sum)
  }
  const output = new Float64Array(weights.output)
  for (let neuron = 0; neuron < weights.output; neuron++) {
    let sum = weights.b2[neuron] ?? 0
    const row = neuron * weights.hidden
    for (let i = 0; i < weights.hidden; i++) sum += (weights.w2[row + i] ?? 0) * (hidden[i] ?? 0)
    output[neuron] = sum
  }
  return output
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

/** One discrete tactic per division, from the weights of this fleet's commander. */
export function decidePolicy(observation: Observation): BrainDecision | null {
  const weights = currentPolicy(observation.own.commanderId, observation.fleet)
  if (!weights || weights.input !== INPUT_SIZE || weights.w1.length !== INPUT_SIZE * weights.hidden) return null
  const logits = forward(weights, featurize(observation))
  const orders: BrainOrder[] = []
  const notes: string[] = []
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
    const target = nearestEnemy(observation, division)
    orders.push(target === undefined ? { division: division.id, tacticId } : { division: division.id, tacticId, target })
    notes.push(`${DIVISION_NAMES[slot]} ${tacticById(tacticId).name}`)
  }
  if (orders.length === 0) return null
  return { orders, note: notes.join('、') }
}
