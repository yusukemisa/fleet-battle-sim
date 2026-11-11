import { MANEUVER } from '../balance.ts'
import { createSim, dispatch } from '../sim.ts'
import type { CommanderId, FormationId, SimState } from '../types.ts'
import type { BattleReport } from './fitness.ts'
import { clearFleetPolicies, useFleetPolicy, type PolicyWeights } from './policy.ts'

const ASSAULT = new Set(['charge', 'breakthrough', 'rear'])

export interface MatchSetup {
  commanders: readonly [CommanderId, CommanderId]
  formations: readonly [FormationId, FormationId]
  seed: number
  brains: readonly ['rule' | 'ai', 'rule' | 'ai']
  /** Candidate weights for a fleet. Omit to use the committed file for its commander. */
  weights?: readonly [PolicyWeights | undefined, PolicyWeights | undefined]
  /** The fleet whose damage, contact, and survival the report describes. */
  focus: 0 | 1
  timeout?: number
}

function hits(state: SimState, side: 0 | 1): { total: number; exposed: number } {
  const front = state.hits.front[side] ?? 0
  const flank = state.hits.side[side] ?? 0
  const rear = state.hits.rear[side] ?? 0
  return { total: front + flank + rear, exposed: flank + rear }
}

function sampleAssault(state: SimState, fleet: number): number {
  let living = 0
  let rushing = 0
  for (const division of state.divisions) {
    if (division.fleet !== fleet || division.alive <= 0) continue
    living += 1
    if (ASSAULT.has(division.tacticId)) rushing += 1
  }
  return living === 0 ? 0 : rushing / living
}

function sampleCohesion(state: SimState, fleet: number): number {
  const own = state.fleets[fleet]
  if (!own) return 1
  let count = 0
  let spread = 0
  for (const division of state.divisions) {
    if (division.fleet !== fleet || division.alive <= 0) continue
    spread += Math.hypot(division.ax - own.meanX, division.ay - own.meanY)
    count += 1
  }
  if (count < 2) return 1
  return Math.max(0, 1 - spread / count / 1200)
}

/** One deterministic battle. Fleet weight overrides are cleared before returning. */
export function playMatch(setup: MatchSetup): BattleReport {
  clearFleetPolicies()
  const weights = setup.weights ?? [undefined, undefined]
  if (weights[0]) useFleetPolicy(0, weights[0])
  if (weights[1]) useFleetPolicy(1, weights[1])
  let state = createSim({ shipCount: 100, commanders: setup.commanders, formations: setup.formations })
  state.rng = setup.seed | 0
  state = dispatch(state, { type: 'set-fleet-brain', fleet: 0, brain: setup.brains[0] })
  state = dispatch(state, { type: 'set-fleet-brain', fleet: 1, brain: setup.brains[1] })
  state = dispatch(state, { type: 'set-speed', speed: 4 })
  state = dispatch(state, { type: 'start' })
  const timeout = setup.timeout ?? 80
  const focus = setup.focus
  const enemy = focus === 0 ? 1 : 0
  const roster = state.alive[focus] || 1
  let contactTime = -1
  let assault = 0
  let cohesion = 0
  let samples = 0
  let steps = 0
  try {
    while (state.phase.kind === 'running' && state.time < timeout && steps < 2200) {
      state = dispatch(state, { type: 'tick', dt: 0.05 })
      steps += 1
      if (contactTime < 0) {
        const dist = Math.hypot((state.centroidX[0] ?? 0) - (state.centroidX[1] ?? 0), (state.centroidY[0] ?? 0) - (state.centroidY[1] ?? 0))
        if (dist < MANEUVER.contact) contactTime = state.time
      }
      if (steps % 8 === 0) {
        assault += sampleAssault(state, focus)
        cohesion += sampleCohesion(state, focus)
        samples += 1
      }
    }
    const dealt = state.dealt[focus] ?? 0
    const taken = state.dealt[enemy] ?? 0
    const landed = hits(state, focus)
    const received = hits(state, enemy)
    const met = contactTime >= 0
    const won = state.phase.kind === 'finished' ? state.phase.winner === focus : (state.alive[focus] ?? 0) > (state.alive[enemy] ?? 0)
    return {
      won,
      alive: (state.alive[focus] ?? 0) / roster,
      contactTime: met ? contactTime : state.time,
      contact: met ? Math.max(0, 1 - contactTime / 45) : 0,
      dealt,
      taken,
      exchange: taken <= 0 ? (dealt > 0 ? 2 : 1) : dealt / taken,
      flank: landed.total === 0 ? 0 : landed.exposed / landed.total,
      exposure: received.total === 0 ? 0 : received.exposed / received.total,
      hitsDealt: landed.total,
      hitsTaken: received.total,
      destroyerDealt: state.destroyerDealt[focus] ?? 0,
      assault: samples === 0 ? 0 : assault / samples,
      cohesion: samples === 0 ? 1 : cohesion / samples,
      time: state.time,
    }
  } finally {
    clearFleetPolicies()
  }
}
