import { describe, expect, it } from 'vitest'
import {
  CLASS_MODS,
  CLASS_STATS,
  DEFAULT_LINE,
  SHIP_CLASS_IDS,
  SHIP_STATS,
  classIndex,
  fleetLine,
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
    const fast = createSim({
      shipCount: 100,
      commanders: ['manual', 'manual'],
      classes: ['destroyer', 'destroyer', 'destroyer', 'destroyer', 'destroyer'],
    })
    const slow = createSim({
      shipCount: 100,
      commanders: ['manual', 'manual'],
      classes: ['battleship', 'battleship', 'battleship', 'battleship', 'battleship'],
    })
    let a = dispatch(fast, { type: 'start' })
    let b = dispatch(slow, { type: 'start' })
    for (let step = 0; step < 40; step++) {
      a = dispatch(a, { type: 'tick', dt: 0.05 })
      b = dispatch(b, { type: 'tick', dt: 0.05 })
    }
    const closed = (state: typeof a) => Math.abs((state.centroidX[0] ?? 0) - (state.centroidX[1] ?? 0))
    expect(closed(a)).toBeLessThan(closed(b))
  })
})
