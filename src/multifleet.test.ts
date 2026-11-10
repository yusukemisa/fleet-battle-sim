import { describe, expect, it } from 'vitest'
import { FLEET_SEPARATION, MAX_SHIPS } from './balance.ts'
import { createSim, dispatch } from './sim.ts'
import type { CommanderId, FleetSetup } from './types.ts'

const three: FleetSetup[] = [
  { side: 0, ships: 100, formationId: 'oujin', commanderId: 'balanced' },
  { side: 0, ships: 100, formationId: 'kakuyoku', commanderId: 'fierce' },
  { side: 0, ships: 100, formationId: 'gyorin', commanderId: 'manual' },
  { side: 1, ships: 100, formationId: 'oujin', commanderId: 'guard' },
  { side: 1, ships: 100, formationId: 'hoshi', commanderId: 'cunning' },
  { side: 1, ships: 500, formationId: 'engetsu', commanderId: 'manual' },
]

describe('multiple fleets', () => {
  it('keeps a one-fleet battle on the original two fleets', () => {
    const state = createSim({ shipCount: 100 })
    expect(state.fleets).toHaveLength(2)
    expect(state.divisions).toHaveLength(10)
    expect(state.alive[0]).toBe(50)
    expect(state.alive[1]).toBe(50)
  })

  it('fields an uneven number of fleets, each with its own commander and formation', () => {
    let state = createSim({ shipCount: 100, groups: three })
    expect(state.fleets.filter((fleet) => fleet.side === 0 && fleet.ships > 0)).toHaveLength(3)
    expect(state.fleets.filter((fleet) => fleet.side === 1 && fleet.ships > 0)).toHaveLength(3)
    expect(state.ships.count).toBe(1000)
    expect(state.fleets[0]?.commanderId).toBe('balanced')
    expect(state.fleets[2]?.formationId).toBe('kakuyoku')
    expect(state.fleets[2]?.name).toBe('青軍二')
    const manual = state.divisions.filter((division) => division.fleet === 4 && division.alive > 0)
    expect(manual.length).toBeGreaterThan(0)
    expect(state.fleets[4]?.commanderId).toBe('manual')
    state = dispatch(state, { type: 'set-fleet-count', side: 1, count: 2 })
    expect(state.fleets.filter((fleet) => fleet.side === 1 && fleet.ships > 0)).toHaveLength(2)
    state = dispatch(state, { type: 'set-fleet-ships', fleet: 0, ships: 2000 })
    expect(state.fleets[0]?.ships).toBe(2000)
    expect(state.ships.count).toBeLessThanOrEqual(MAX_SHIPS)
  })

  it('does not let friendly fleets overlap', () => {
    let state = createSim({
      shipCount: 100,
      groups: [
        { side: 0, ships: 100, commanderId: 'fierce' },
        { side: 0, ships: 100, commanderId: 'guard' },
        { side: 1, ships: 100, commanderId: 'balanced' },
      ],
    })
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    let near = Infinity
    for (let step = 0; step < 80; step++) {
      state = dispatch(state, { type: 'tick', dt: 0.05 })
      const a = state.fleets[0]
      const b = state.fleets[2]
      if (!a || !b) continue
      near = Math.min(near, Math.hypot(a.meanX - b.meanX, a.meanY - b.meanY))
    }
    expect(near).toBeGreaterThan(FLEET_SEPARATION * 0.55)
  })

  it('keeps 10k ships across six fleets inside a 60fps step', () => {
    const group = (side: 0 | 1, ships: number, commanderId: CommanderId): FleetSetup => ({ side, ships, commanderId })
    let state = createSim({
      shipCount: 100,
      groups: [
        group(0, 2000, 'balanced'),
        group(0, 2000, 'fierce'),
        group(0, 1000, 'cunning'),
        group(1, 2000, 'guard'),
        group(1, 2000, 'fierce'),
        group(1, 1000, 'balanced'),
      ],
    })
    expect(state.ships.count).toBe(10000)
    state = dispatch(state, { type: 'set-speed', speed: 1 })
    state = dispatch(state, { type: 'start' })
    const samples: number[] = []
    for (let step = 0; step < 20; step++) {
      const start = performance.now()
      state = dispatch(state, { type: 'tick', dt: 1 / 60 })
      samples.push(performance.now() - start)
    }
    samples.sort((a, b) => a - b)
    const median = samples[Math.floor(samples.length / 2)] ?? 0
    expect(median).toBeLessThan(12)
  })

  it('wins only after every enemy fleet is gone', () => {
    let state = createSim({
      shipCount: 100,
      groups: [
        { side: 0, ships: 100, commanderId: 'manual' },
        { side: 1, ships: 100, commanderId: 'manual' },
        { side: 1, ships: 100, commanderId: 'manual' },
      ],
    })
    state = dispatch(state, { type: 'start' })
    clearFleet(state, 1)
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    expect(state.phase.kind).toBe('running')
    clearFleet(state, 3)
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    expect(state.phase.kind).toBe('finished')
    if (state.phase.kind === 'finished') expect(state.phase.winner).toBe(0)
  })
})

function clearFleet(state: ReturnType<typeof createSim>, fleetIndex: number): void {
  const ships = state.ships
  for (let i = 0; i < ships.count; i++) {
    const division = state.divisions[ships.division[i] ?? 0]
    if (!division || division.fleet !== fleetIndex || ships.alive[i] === 0) continue
    ships.alive[i] = 0
    state.alive[division.side] -= 1
  }
  for (const division of state.divisions) {
    if (division.fleet === fleetIndex) division.alive = 0
  }
}
