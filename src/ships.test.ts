import { describe, expect, it } from 'vitest'
import {
  CLASS_MODS,
  CLASS_STATS,
  DEFAULT_LINE,
  SHIP_CLASS_IDS,
  SHIP_STATS,
  anchorPace,
  type ShipClassId,
  classIndex,
  fleetLine,
  stepYaw,
  turningRadius,
} from './balance.ts'
import { createSim, dispatch } from './sim.ts'
import { DIVISIONS_PER_SIDE } from './types.ts'

describe('ship classes', () => {
  it('keeps the battleship equal to the baseline and derives the others from it', () => {
    const battleship = CLASS_STATS[classIndex('battleship')]
    const cruiser = CLASS_STATS[classIndex('cruiser')]
    const destroyer = CLASS_STATS[classIndex('destroyer')]
    expect(battleship?.hp).toBe(SHIP_STATS.hp)
    expect(battleship?.maxSpeed).toBe(SHIP_STATS.maxSpeed)
    expect(battleship?.turnRate).toBe(SHIP_STATS.turnRate)
    expect(battleship?.batteries[0]?.guns).toBe(8)
    expect(battleship?.batteries[1]?.guns).toBe(16)
    expect(battleship?.batteries[0]?.maxRange).toBe(900)
    expect(cruiser && battleship && cruiser.hp).toBeLessThan(battleship.hp)
    expect(cruiser && battleship && cruiser.maxSpeed).toBeGreaterThan(battleship.maxSpeed)
    expect(cruiser && battleship && cruiser.turnRate).toBeGreaterThan(battleship.turnRate)
    expect(cruiser && battleship && cruiser.response).toBeGreaterThan(battleship.response)
    expect(cruiser?.batteries[0]?.maxRange).toBeLessThan(battleship?.batteries[0]?.maxRange ?? 0)
    expect(destroyer && cruiser && destroyer.hp).toBeLessThan(cruiser.hp)
    expect(destroyer && cruiser && destroyer.turnRate).toBeGreaterThan(cruiser.turnRate)
    expect(destroyer && cruiser && destroyer.maxSpeed).toBeGreaterThan(cruiser.maxSpeed)
    const bow = (destroyer?.batteries[0]?.guns ?? 0) * (destroyer?.batteries[0]?.power ?? 0)
    const side = (destroyer?.batteries[1]?.guns ?? 0) * (destroyer?.batteries[1]?.power ?? 0)
    expect(side).toBeGreaterThan(bow)
    expect(destroyer?.batteries[0]?.maxRange).toBeLessThan(cruiser?.batteries[0]?.maxRange ?? 0)
    expect(destroyer?.armorFront).toBeGreaterThan(battleship?.armorFront ?? 0)
    expect(CLASS_MODS.destroyer.wing).toBeGreaterThan(CLASS_MODS.battleship.wing)
    const radius = (index: number) => turningRadius(CLASS_STATS[index]?.maxSpeed ?? 1, CLASS_STATS[index]?.turnRate ?? 1)
    expect(radius(0)).toBeGreaterThan(radius(1))
    expect(radius(1)).toBeGreaterThan(radius(2))
    const spread = (CLASS_STATS[2]?.turnRate ?? 0) / (CLASS_STATS[0]?.turnRate ?? 1)
    expect(spread).toBeGreaterThan(3)
    expect(spread).toBeLessThan(5.5)
    expect(CLASS_STATS[0]?.maxSpeed ?? 0).toBeLessThan(70)
    expect(CLASS_STATS[2]?.maxSpeed ?? 0).toBeGreaterThan((CLASS_STATS[0]?.maxSpeed ?? 1) * 2)
    const bb = stepYaw(0, Math.PI, CLASS_STATS[0]?.turnRate ?? 1, CLASS_STATS[0]?.yawAccel ?? 1, 0.2)
    const dd = stepYaw(0, Math.PI, CLASS_STATS[2]?.turnRate ?? 1, CLASS_STATS[2]?.yawAccel ?? 1, 0.2)
    expect(dd.delta).toBeGreaterThan(bb.delta * 3)
    expect(Math.abs(dd.delta)).toBeLessThanOrEqual((CLASS_STATS[2]?.turnRate ?? 1) * 0.2 + 1e-6)
  })

  it('keeps destroyer wings with the battleships until they maneuver alone', () => {
    let state = createSim({ shipCount: 100, commanders: ['manual', 'manual'] })
    const wing = state.divisions[0]
    const center = state.divisions[2]
    expect(wing?.classId).toBe('destroyer')
    expect(center?.classId).toBe('battleship')
    expect(anchorPace(wing!)).toBe(1)
    expect(anchorPace({ ...wing!, tacticId: 'flank' })).toBe(CLASS_MODS.destroyer.speed)
    const wx = wing?.ax ?? 0
    const cx = center?.ax ?? 0
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    for (let step = 0; step < 30; step++) state = dispatch(state, { type: 'tick', dt: 0.05 })
    const together = Math.abs((state.divisions[0]?.ax ?? 0) - wx - ((state.divisions[2]?.ax ?? 0) - cx))
    expect(together).toBeLessThan(50)
    const wx2 = state.divisions[0]?.ax ?? 0
    const wy2 = state.divisions[0]?.ay ?? 0
    const cx2 = state.divisions[2]?.ax ?? 0
    const cy2 = state.divisions[2]?.ay ?? 0
    state = dispatch(state, { type: 'set-tactic', division: 0, tacticId: 'flank' })
    for (let step = 0; step < 40; step++) state = dispatch(state, { type: 'tick', dt: 0.05 })
    const wingRun = Math.hypot((state.divisions[0]?.ax ?? 0) - wx2, (state.divisions[0]?.ay ?? 0) - wy2)
    const centerRun = Math.hypot((state.divisions[2]?.ax ?? 0) - cx2, (state.divisions[2]?.ay ?? 0) - cy2)
    expect(wingRun).toBeGreaterThan(centerRun * 1.2)
  })

  it('fills each division with one class and puts battleships in the center', () => {
    for (const count of [100, 1000, 10000] as const) {
      for (const formation of ['oujin', 'kakuyoku', 'engetsu', 'gyorin', 'hoshi', 'houen'] as const) {
        const state = createSim({ shipCount: count, formations: [formation, formation] })
        expect(fleetLine(undefined)).toEqual([...DEFAULT_LINE, ...DEFAULT_LINE])
        for (let d = 0; d < state.divisions.length; d++) {
          const division = state.divisions[d]
          expect(division?.classId).toBe(DEFAULT_LINE[d % DIVISIONS_PER_SIDE])
          const expected = classIndex(division?.classId ?? 'battleship')
          let seen = 0
          for (let i = 0; i < state.ships.count; i++) {
            if (state.ships.division[i] !== d || state.ships.alive[i] === 0) continue
            expect(state.ships.shipClass[i]).toBe(expected)
            expect(state.ships.hp[i]).toBe(CLASS_STATS[expected]?.hp)
            seen += 1
          }
          expect(seen).toBe(division?.roster)
          expect(seen).toBeGreaterThan(0)
        }
      }
    }
    expect(SHIP_CLASS_IDS).toEqual(['battleship', 'cruiser', 'destroyer'])
  })

  it('changes one division before the battle and leaves the others', () => {
    let state = createSim({ shipCount: 100 })
    state = dispatch(state, { type: 'set-class', division: 2, classId: 'destroyer' })
    expect(state.phase.kind).toBe('setup')
    expect(state.divisions[2]?.classId).toBe('destroyer')
    expect(state.divisions[0]?.classId).toBe('destroyer')
    expect(state.divisions[1]?.classId).toBe('cruiser')
    expect(state.divisions[7]?.classId).toBe('battleship')
    for (let i = 0; i < state.ships.count; i++) {
      if (state.ships.division[i] !== 2) continue
      expect(state.ships.shipClass[i]).toBe(classIndex('destroyer'))
    }
    state = dispatch(state, { type: 'start' })
    const ignored = dispatch(state, { type: 'set-class', division: 2, classId: 'cruiser' })
    expect(ignored.divisions[2]?.classId).toBe('destroyer')
  })

  it('lets a destroyer division pull ahead of a battleship division', () => {
    const travel = (classes: readonly ShipClassId[]) => {
      let state = createSim({ shipCount: 100, commanders: ['manual', 'manual'], classes })
      const x0 = state.centroidX[0]
      const y0 = state.centroidY[0]
      for (let division = 0; division < 5; division++) {
        state = dispatch(state, { type: 'set-tactic', division, tacticId: 'flank' })
      }
      state = dispatch(state, { type: 'set-speed', speed: 4 })
      state = dispatch(state, { type: 'start' })
      for (let step = 0; step < 30; step++) state = dispatch(state, { type: 'tick', dt: 0.05 })
      return Math.hypot(state.centroidX[0] - x0, state.centroidY[0] - y0)
    }
    expect(travel(['destroyer', 'destroyer', 'destroyer', 'destroyer', 'destroyer'])).toBeGreaterThan(
      travel(['battleship', 'battleship', 'battleship', 'battleship', 'battleship']) * 1.4,
    )
  })
})
