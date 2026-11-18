import { describe, expect, it } from 'vitest'
import { createSim, dispatch } from './sim.ts'
import type { FleetSetup } from './types.ts'

function groups(ships: number, fleets: number): FleetSetup[] {
  const out: FleetSetup[] = []
  for (let i = 0; i < fleets; i++) out.push({ side: 0, ships, formationId: 'oujin', commanderId: 'balanced' })
  for (let i = 0; i < fleets; i++) out.push({ side: 1, ships, formationId: 'oujin', commanderId: 'cunning' })
  return out
}

function engage(ships: number, fleets: number) {
  let state = createSim({ shipCount: 100, groups: groups(ships, fleets), brains: ['rule', 'rule'] })
  state.rng = 3
  state = dispatch(state, { type: 'set-speed', speed: 4 })
  state = dispatch(state, { type: 'start' })
  const origin = state.divisions.map((division) => [division.ax, division.ay] as const)
  let first = -1
  while (state.phase.kind === 'running' && state.time < 40) {
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    if (first < 0 && state.tally.shots > 0) first = state.time
  }
  let moved = 0
  for (let i = 0; i < state.divisions.length; i++) {
    const division = state.divisions[i]
    const at = origin[i]
    if (!division || division.roster === 0 || !at) continue
    moved = Math.max(moved, Math.hypot(division.ax - at[0], division.ay - at[1]))
  }
  return { first, shots: state.tally.shots, moved }
}

describe('large lines close', () => {
  for (const ships of [2000, 5000, 10000] as const) {
    for (const fleets of [1, 2] as const) {
      it(`closes and fires with ${fleets} fleet(s) of ${ships} within 40s`, () => {
        const result = engage(ships, fleets)
        expect(result.moved).toBeGreaterThan(200)
        expect(result.shots).toBeGreaterThan(0)
        expect(result.first).toBeGreaterThan(0)
        expect(result.first).toBeLessThan(40)
      }, 180_000)
    }
  }
})
