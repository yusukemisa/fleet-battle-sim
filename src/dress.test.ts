import { afterEach, describe, expect, it } from 'vitest'
import { createSim, dispatch } from './sim.ts'
import { dressShape, dressStation } from './dress.ts'
import { resetTacticVariants, setTacticVariant } from './operation.ts'
import type { FleetSetup, SimState } from './types.ts'

afterEach(() => {
  resetTacticVariants()
})

function dressed(count: 100 | 1000 | 10000 = 1000): SimState {
  setTacticVariant(0, 'dress')
  return createSim({ shipCount: count, commanders: ['balanced', 'cunning'], brains: ['rule', 'rule'] })
}

function groups(ships: number, fleets: number): FleetSetup[] {
  const out: FleetSetup[] = []
  for (let side = 0; side < 2; side++) {
    for (let i = 0; i < fleets; i++) {
      out.push({ side: side === 0 ? 0 : 1, ships, formationId: 'oujin', commanderId: 'balanced', brain: 'rule' })
    }
  }
  return out
}

describe('dress line', () => {
  it('stays wide and shallow at every size', () => {
    expect(dressShape(10).rows).toBeLessThanOrEqual(6)
    expect(dressShape(10).cols / dressShape(10).rows).toBeGreaterThanOrEqual(4)
    expect(dressShape(10000).rows).toBeLessThanOrEqual(6)
    expect(dressShape(10000).cols / dressShape(10000).rows).toBeGreaterThan(4)
    expect(dressShape(10000).pitch).toBeGreaterThanOrEqual(40)
    const state = dressed(10000)
    const fleet = state.fleets[0]
    if (!fleet) throw new Error('fleet')
    let minAlong = Infinity
    let maxAlong = -Infinity
    let minAcross = Infinity
    let maxAcross = -Infinity
    let nearest = Infinity
    const half = state.shipCount / 2
    for (let i = 0; i < half; i++) {
      const dx = (state.ships.x[i] ?? 0) - fleet.meanX
      const dy = (state.ships.y[i] ?? 0) - fleet.meanY
      const along = dx * fleet.facingX + dy * fleet.facingY
      const across = dx * fleet.facingY + dy * -fleet.facingX
      minAlong = Math.min(minAlong, along)
      maxAlong = Math.max(maxAlong, along)
      minAcross = Math.min(minAcross, across)
      maxAcross = Math.max(maxAcross, across)
      const station = dressStation(state, i)
      if (!station) continue
      for (let j = i + 1; j < half; j++) {
        const other = dressStation(state, j)
        if (!other) continue
        const file = Math.abs(station.file - other.file)
        const rank = Math.abs(station.rank - other.rank)
        if (file + rank !== 1) continue
        const dist = Math.hypot((state.ships.x[i] ?? 0) - (state.ships.x[j] ?? 0), (state.ships.y[i] ?? 0) - (state.ships.y[j] ?? 0))
        nearest = Math.min(nearest, dist)
        break
      }
    }
    const depth = maxAlong - minAlong
    const width = maxAcross - minAcross
    expect(width / Math.max(1, depth)).toBeGreaterThan(4)
    expect(depth).toBeLessThan(width / 4 + 1)
    expect(nearest).toBeGreaterThan(39)
  })

  it('fills a hole from the rank behind', () => {
    let state = dressed(1000)
    const half = state.shipCount / 2
    const files = new Map<number, { index: number; rank: number }[]>()
    for (let i = 0; i < half; i++) {
      const station = dressStation(state, i)
      if (!station) continue
      const list = files.get(station.file) ?? []
      list.push({ index: i, rank: station.rank })
      files.set(station.file, list)
    }
    let front = -1
    let behind = -1
    for (const list of files.values()) {
      if (list.length < 2) continue
      list.sort((a, b) => a.rank - b.rank)
      front = list[0]?.index ?? -1
      behind = list[1]?.index ?? -1
      break
    }
    expect(front).toBeGreaterThanOrEqual(0)
    expect(behind).toBeGreaterThanOrEqual(0)
    state.ships.alive[front] = 0
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    expect(dressStation(state, behind)?.rank).toBe(0)
  })

  it('slides sideways while the bow stays on the enemy', () => {
    let state = dressed(100)
    const fleet = state.fleets[0]
    if (!fleet) throw new Error('fleet')
    const rx = fleet.facingY
    const ry = -fleet.facingX
    state.ships.x[0] = (state.ships.x[0] ?? 0) + rx * 40
    state.ships.y[0] = (state.ships.y[0] ?? 0) + ry * 40
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    const vx = state.ships.vx[0] ?? 0
    const vy = state.ships.vy[0] ?? 0
    const slide = vx * rx + vy * ry
    expect(slide).toBeLessThan(-5)
    const facing = state.fleets[0]
    if (!facing) throw new Error('fleet')
    const dot = (state.ships.headingCos[0] ?? 0) * facing.facingX + (state.ships.headingSin[0] ?? 0) * facing.facingY
    expect(dot).toBeGreaterThan(0.95)
  })

  it('does not add lateral thrust to the default tactic', () => {
    let state = createSim({ shipCount: 100, commanders: ['balanced', 'cunning'], brains: ['rule', 'rule'] })
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    for (let i = 0; i < 30; i++) state = dispatch(state, { type: 'tick', dt: 0.05 })
    const ships = state.ships
    for (let i = 0; i < ships.count; i++) {
      if (ships.alive[i] !== 1) continue
      const hx = ships.headingCos[i] ?? 1
      const hy = ships.headingSin[i] ?? 0
      const cross = (ships.vx[i] ?? 0) * hy - (ships.vy[i] ?? 0) * hx
      expect(Math.abs(cross)).toBeLessThan(1e-3)
    }
  })

  it('closes and fires with one, two, and three fleets', () => {
    for (const fleets of [1, 2, 3]) {
      setTacticVariant(0, 'dress')
      let state = createSim({ shipCount: 100, groups: groups(200, fleets), brains: ['rule', 'rule'] })
      state.rng = 3
      state = dispatch(state, { type: 'set-speed', speed: 4 })
      state = dispatch(state, { type: 'start' })
      let first = -1
      const origin = state.fleets.map((fleet) => [fleet.meanX, fleet.meanY] as const)
      while (state.phase.kind === 'running' && state.time < 40) {
        state = dispatch(state, { type: 'tick', dt: 0.05 })
        if (first < 0 && state.tally.shots > 0) first = state.time
      }
      let moved = 0
      for (let i = 0; i < state.fleets.length; i++) {
        const fleet = state.fleets[i]
        const at = origin[i]
        if (!fleet || fleet.ships <= 0 || !at) continue
        moved = Math.max(moved, Math.hypot(fleet.meanX - at[0], fleet.meanY - at[1]))
      }
      expect(moved, `${fleets} fleets`).toBeGreaterThan(80)
      expect(first, `${fleets} fleets`).toBeGreaterThan(0)
      expect(first, `${fleets} fleets`).toBeLessThan(40)
    }
  }, 60_000)
})
