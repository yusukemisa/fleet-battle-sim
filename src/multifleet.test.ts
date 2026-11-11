import { describe, expect, it } from 'vitest'
import { FLEET_SHIP_MAX, FLEET_SHIP_MIN, FLEET_SHIP_STEP, FLEET_SEPARATION, MAX_SHIPS } from './balance.ts'
import { fitGroups, snapFleetShips } from './fleets.ts'
import { parseFleetShips } from './parse.ts'
import { createSim, dispatch } from './sim.ts'
import type { CommanderId, FleetSetup, SimState } from './types.ts'

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

  it('snaps fleet counts onto the step and into range', () => {
    expect(snapFleetShips(30)).toBe(FLEET_SHIP_MIN)
    expect(snapFleetShips(234)).toBe(250)
    expect(snapFleetShips(2000)).toBe(2000)
    expect(snapFleetShips(10040)).toBe(FLEET_SHIP_MAX)
    expect(snapFleetShips(Number.NaN)).toBe(FLEET_SHIP_MIN)
    expect(parseFleetShips('')).toBeNull()
    expect(parseFleetShips('たくさん')).toBeNull()
    expect(parseFleetShips('234')).toBe(250)
    let state = createSim({
      shipCount: 100,
      groups: [
        { side: 0, ships: 500 },
        { side: 1, ships: 500 },
      ],
    })
    state = dispatch(state, { type: 'set-fleet-ships', fleet: 0, ships: 234 })
    expect(state.fleets[0]?.ships).toBe(250)
    expect(state.ships.count).toBe(750)
    expect(state.fitNotice).toBeNull()
  })

  it('scales an over-cap battle in proportion and says so', () => {
    const groups: FleetSetup[] = [0, 1, 0, 1, 0, 1].map((side) => ({
      side: side as 0 | 1,
      ships: FLEET_SHIP_MAX,
    }))
    const fit = fitGroups(groups)
    const placed = fit.groups.reduce((sum, group) => sum + group.ships, 0)
    expect(placed).toBeLessThanOrEqual(MAX_SHIPS)
    expect(placed).toBeGreaterThan(MAX_SHIPS - groups.length * FLEET_SHIP_STEP)
    expect(fit.notice).toContain('上限')
    expect(fit.notice).toContain('同じ割合')
    const counts = fit.groups.map((group) => group.ships)
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(FLEET_SHIP_STEP)
    expect(fit.requested.every((group) => group.ships === FLEET_SHIP_MAX)).toBe(true)
    const state = createSim({ shipCount: 100, groups })
    expect(state.ships.count).toBe(placed)
    expect(state.fitNotice).toBe(fit.notice)
    expect(state.alive[0] + state.alive[1]).toBe(placed)
    expect(state.fleets.filter((fleet) => fleet.ships > 0).every((fleet) => fleet.requested === FLEET_SHIP_MAX)).toBe(true)
    let stepped = state
    for (const index of [0, 1, 2, 3, 4, 5]) {
      stepped = dispatch(stepped, { type: 'set-fleet-ships', fleet: index, ships: 50 })
      stepped = dispatch(stepped, { type: 'set-fleet-ships', fleet: index, ships: FLEET_SHIP_MAX })
    }
    const fielded = stepped.fleets.filter((fleet) => fleet.ships > 0)
    expect(fielded.every((fleet) => fleet.requested === FLEET_SHIP_MAX)).toBe(true)
    expect(stepped.ships.count).toBeLessThanOrEqual(MAX_SHIPS)
    expect(Math.max(...fielded.map((fleet) => fleet.ships)) - Math.min(...fielded.map((fleet) => fleet.ships))).toBeLessThanOrEqual(FLEET_SHIP_STEP)
    expect(stepped.fitNotice).toContain('60,000')
  })

  it('keeps 2,000 × 3 vs 2,000 × 3 when the cap allows it', () => {
    expect(MAX_SHIPS).toBeGreaterThanOrEqual(12000)
    const groups: FleetSetup[] = [0, 1, 0, 1, 0, 1].map((side) => ({
      side: side as 0 | 1,
      ships: 2000,
    }))
    const state = createSim({ shipCount: 100, groups })
    expect(state.ships.count).toBe(12000)
    expect(state.fitNotice).toBeNull()
    expect(state.fleets.filter((fleet) => fleet.ships === 2000)).toHaveLength(6)
  })

  it('keeps the two sides apart at the 20,000-ship shortcut', () => {
    const state = createSim({ shipCount: 20000, formations: ['oujin', 'kakuyoku'] })
    expect(state.ships.count).toBe(20000)
    expect(state.fleets[0]?.ships).toBe(10000)
    expect(state.fitNotice).toBeNull()
    let blueMax = -Infinity
    let redMin = Infinity
    for (let i = 0; i < state.ships.count; i++) {
      const x = state.ships.x[i] ?? 0
      if (state.ships.side[i] === 0) blueMax = Math.max(blueMax, x)
      else redMin = Math.min(redMin, x)
    }
    expect(blueMax).toBeLessThan(redMin)
  })

  it('keeps uneven fleets from overlapping at deployment', () => {
    const state = createSim({
      shipCount: 100,
      groups: [
        { side: 0, ships: 5000, formationId: 'oujin' },
        { side: 0, ships: 500, formationId: 'kakuyoku' },
        { side: 0, ships: 500, formationId: 'hoshi' },
        { side: 1, ships: 2000, formationId: 'oujin' },
        { side: 1, ships: 1500, formationId: 'gyorin' },
        { side: 1, ships: 1500, formationId: 'engetsu' },
      ],
    })
    expect(state.ships.count).toBe(11000)
    expect(gaps(state, 0).every((gap) => gap > 40)).toBe(true)
    expect(gaps(state, 1).every((gap) => gap > 40)).toBe(true)
    const blue = state.fleets.filter((fleet) => fleet.side === 0 && fleet.ships > 0)
    const big = blue.find((fleet) => fleet.ships === 5000)
    const small = blue.find((fleet) => fleet.ships === 500)
    expect(big).toBeDefined()
    expect(small).toBeDefined()
    if (!big || !small) return
    expect(Math.abs(big.centerY - small.centerY)).toBeGreaterThan(big.reach + small.reach)
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

function gaps(state: SimState, side: 0 | 1): number[] {
  const boxes = new Map<number, { minX: number; maxX: number; minY: number; maxY: number }>()
  const ships = state.ships
  for (let i = 0; i < ships.count; i++) {
    if (ships.side[i] !== side) continue
    const division = state.divisions[ships.division[i] ?? 0]
    const fleet = division?.fleet
    if (fleet === undefined) continue
    const box = boxes.get(fleet) ?? { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
    const x = ships.x[i] ?? 0
    const y = ships.y[i] ?? 0
    box.minX = Math.min(box.minX, x)
    box.maxX = Math.max(box.maxX, x)
    box.minY = Math.min(box.minY, y)
    box.maxY = Math.max(box.maxY, y)
    boxes.set(fleet, box)
  }
  const list = [...boxes.values()]
  const found: number[] = []
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]
      const b = list[j]
      if (!a || !b) continue
      const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX)
      const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY)
      found.push(Math.hypot(dx, dy))
    }
  }
  return found
}

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
