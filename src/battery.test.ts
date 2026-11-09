import { describe, expect, it } from 'vitest'
import { BATTERIES, SHIP_STATS } from './balance.ts'
import { inBattery } from './combat.ts'
import { createSim, dispatch } from './sim.ts'
import type { SimState } from './types.ts'

describe('batteries', () => {
  it('gives the bow a long reach and a minimum range, and the broadsides the sides', () => {
    const bow = BATTERIES[0]
    const port = BATTERIES[1]
    const starboard = BATTERIES[2]
    expect(bow?.guns).toBe(8)
    expect(port?.guns).toBe(16)
    expect(starboard?.guns).toBe(16)
    expect((bow?.guns ?? 0) + (port?.guns ?? 0) + (starboard?.guns ?? 0)).toBe(40)
    expect(bow?.cooldown).toBe(2)
    expect(port?.maxRange).toBeLessThan(bow?.maxRange ?? 0)
    expect(bow?.minRange).toBeGreaterThan(port?.maxRange ? 0 : 0)
    expect(inBattery(1, 0, 0, 0, bow?.minRange ? bow.minRange - 40 : 0, 0, bow!)).toBe(false)
    expect(inBattery(1, 0, 0, 0, 500, 0, bow!)).toBe(true)
    expect(inBattery(1, 0, 0, 0, 0, 300, port!)).toBe(true)
    expect(inBattery(1, 0, 0, 0, 0, -300, starboard!)).toBe(true)
    expect(inBattery(1, 0, 0, 0, 0, (port?.maxRange ?? 0) + 80, port!)).toBe(false)
    expect(inBattery(1, 0, 0, 0, -300, 0, port!)).toBe(false)
  })

  it('does not let the bow hit inside its minimum range', () => {
    const state = duel(0, 0, 120)
    const before = state.ships.hp[50] ?? 0
    const next = dispatch(dispatch(state, { type: 'start' }), { type: 'tick', dt: 0.05 })
    expect(next.ships.hp[50]).toBe(before)
    expect(next.tally.shots).toBe(0)
  })

  it('fires a broadside into the beam and not past its maximum range', () => {
    const closeState = duel(0, Math.PI / 2, 300)
    closeState.ships.gunCd[0] = 0
    const close = dispatch(dispatch(closeState, { type: 'start' }), { type: 'tick', dt: 0.05 })
    expect(close.tally.shots).toBe(1)
    expect((close.ships.hp[50] ?? 0)).toBeLessThan(SHIP_STATS.hp)
    const farState = duel(0, Math.PI / 2, 700)
    farState.ships.gunCd[0] = 0
    const far = dispatch(dispatch(farState, { type: 'start' }), { type: 'tick', dt: 0.05 })
    expect(far.tally.shots).toBe(0)
    expect(far.ships.hp[50]).toBe(SHIP_STATS.hp)
  })

  it('keeps a separate cooldown on each battery', () => {
    const state = duel(0, 0, 500)
    state.ships.gunCd[0] = 0
    state.ships.gunCd[1] = 0
    const next = dispatch(dispatch(state, { type: 'start' }), { type: 'tick', dt: 0.05 })
    expect(next.ships.cooldown[0]).toBeGreaterThan(1)
    expect(next.ships.gunCd[0] ?? 0).toBeLessThan(0.1)
    expect(next.ships.gunCd[1] ?? 0).toBeLessThan(0.1)
    const side = duel(0, Math.PI / 2, 300)
    side.ships.cooldown[0] = 0
    side.ships.gunCd[0] = 0
    const fired = dispatch(dispatch(side, { type: 'start' }), { type: 'tick', dt: 0.05 })
    expect(fired.ships.gunCd[0]).toBeGreaterThan(1)
    expect(fired.ships.cooldown[0]).toBeLessThanOrEqual(0)
  })
})

function duel(heading: number, targetAngle: number, distance: number): SimState {
  const state = createSim({ shipCount: 100, commanders: ['manual', 'manual'], gunnery: 'aimed', maneuver: 'legacy' })
  state.stats.hitChance = 1
  const ships = state.ships
  for (let i = 0; i < ships.count; i++) {
    ships.alive[i] = 0
    ships.cooldown[i] = 100
    ships.gunCd[i * 2] = 100
    ships.gunCd[i * 2 + 1] = 100
  }
  ships.alive[0] = 1
  ships.side[0] = 0
  ships.hp[0] = SHIP_STATS.hp
  ships.cooldown[0] = 0
  ships.x[0] = 0
  ships.y[0] = 0
  ships.heading[0] = heading
  ships.alive[50] = 1
  ships.side[50] = 1
  ships.hp[50] = SHIP_STATS.hp
  ships.cooldown[50] = 100
  ships.x[50] = Math.cos(targetAngle) * distance
  ships.y[50] = Math.sin(targetAngle) * distance
  ships.heading[50] = heading + Math.PI
  const division = state.divisions[0]
  if (division) {
    division.ax = 0
    division.ay = 0
    division.fx = Math.cos(heading)
    division.fy = Math.sin(heading)
    division.tacticId = 'hold'
    division.holdArmed = true
  }
  ships.slotX[0] = 0
  ships.slotY[0] = 0
  ships.division[0] = 0
  return state
}
