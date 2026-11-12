import { describe, expect, it } from 'vitest'
import { featurize, INPUT_SIZE } from './brain/features.ts'
import { observe } from './brain/observe.ts'
import {
  FLAGSHIP,
  appointFlagships,
  commandMods,
  exposedFlagship,
  noteFlagshipLoss,
} from './flagship.ts'
import { createSim, dispatch } from './sim.ts'

describe('flagships', () => {
  it('appoints a battleship fleet flagship and a flagship in every division', () => {
    const state = createSim({ shipCount: 100, commanders: ['guard', 'fierce'], brains: ['rule', 'rule'] })
    expect(INPUT_SIZE).toBe(129)
    for (const fleet of state.fleets) {
      expect(fleet.flagship).toBeGreaterThanOrEqual(0)
      expect(state.ships.alive[fleet.flagship]).toBe(1)
      expect(state.ships.shipClass[fleet.flagship]).toBe(0)
      expect(state.ships.command[fleet.flagship]).toBe(2)
    }
    for (let index = 0; index < state.divisions.length; index++) {
      const division = state.divisions[index]
      if (!division || division.roster === 0) continue
      expect(division.flagship).toBeGreaterThanOrEqual(0)
      expect(state.ships.division[division.flagship]).toBe(index)
      expect(state.ships.alive[division.flagship]).toBe(1)
    }
    const features = featurize(observe(state, 0))
    const slot = 11
    expect(features[2 * slot + 10]).toBe(1)
    expect(features[10]).toBe(0.5)
    expect(features[5 * slot + 2 * slot + 10]).toBe(1)
  })

  it('stacks the two command bonuses only partway, and only inside the radius', () => {
    const state = createSim({ shipCount: 100, brains: ['rule', 'rule'] })
    const fleet = state.fleets[0]
    const wing = state.divisions[0]
    if (!fleet || !wing) throw new Error('missing fleet')
    const ship = divisionMate(state, wing.flagship)
    const flag = fleet.flagship
    state.ships.division[ship] = 0
    state.ships.x[wing.flagship] = 0
    state.ships.y[wing.flagship] = 0
    state.ships.x[ship] = 10
    state.ships.y[ship] = 0
    state.ships.x[flag] = 20
    state.ships.y[flag] = 0
    expect(commandMods(state, ship).hit).toBeCloseTo(FLAGSHIP.hitStack)
    expect(FLAGSHIP.hitStack).toBeLessThan(FLAGSHIP.hitFleet + FLAGSHIP.hitDivision)
    state.ships.x[flag] = 5000
    expect(commandMods(state, ship).hit).toBeCloseTo(FLAGSHIP.hitDivision)
    state.ships.x[ship] = FLAGSHIP.divisionRadius + 40
    expect(commandMods(state, ship).hit).toBe(0)
  })

  it('drops the bonus, penalizes maneuver, then hands command to the next battleship', () => {
    const state = createSim({ shipCount: 100, brains: ['rule', 'rule'] })
    const fleet = state.fleets[0]
    const flag = fleet?.flagship ?? -1
    const division = state.divisions[state.ships.division[flag] ?? 0]
    if (!fleet || !division) throw new Error('missing flagship')
    const mate = divisionMate(state, flag)
    state.ships.alive[flag] = 0
    noteFlagshipLoss(state, flag)
    expect(fleet.flagship).toBe(-1)
    expect(division.flagship).toBe(-1)
    const broken = commandMods(state, mate)
    expect(broken.hit).toBeCloseTo(FLAGSHIP.disruptHit)
    expect(broken.turn).toBeCloseTo(FLAGSHIP.disruptTurn)
    expect(broken.response).toBeCloseTo(FLAGSHIP.disruptResponse)
    state.time = FLAGSHIP.divisionDelay
    appointFlagships(state)
    expect(fleet.flagship).toBe(-1)
    expect(division.flagship).not.toBe(flag)
    expect(state.ships.shipClass[division.flagship]).toBe(0)
    state.time = FLAGSHIP.fleetDelay
    appointFlagships(state)
    expect(fleet.flagship).toBeGreaterThanOrEqual(0)
    expect(fleet.flagship).not.toBe(flag)
    expect(state.ships.alive[fleet.flagship]).toBe(1)
    expect(state.ships.command[fleet.flagship]).toBe(2)
    const restored = commandMods(state, fleet.flagship)
    expect(restored.hit).toBeGreaterThan(0)
    expect(restored.turn).toBeGreaterThan(1)
  })

  it('holds the flagship division and hunts an exposed enemy flagship', () => {
    let state = createSim({ shipCount: 100, commanders: ['fierce', 'guard'], brains: ['rule', 'rule'] })
    state = dispatch(state, { type: 'start' })
    const enemy = state.fleets[1]
    const wing = 5
    const ship = state.divisions[wing]?.flagship ?? -1
    if (!enemy || ship < 0) throw new Error('missing enemy flagship')
    const previous = enemy.flagship
    if (previous >= 0 && previous !== ship) state.ships.command[previous] = 1
    enemy.flagship = ship
    state.ships.command[ship] = 2
    expect(exposedFlagship(state, ship)).toBe(true)
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    expect(state.fleets[0]?.prey).toBe(wing)
    expect(state.divisions[0]?.hunt).toBe(wing)
    const own = state.divisions[state.ships.division[state.fleets[0]?.flagship ?? 0] ?? 0]
    expect(own?.standoff).toBe(true)
    expect(own?.tacticId).not.toBe('charge')
  })
})

function divisionMate(state: ReturnType<typeof createSim>, flag: number): number {
  const division = state.ships.division[flag] ?? 0
  for (let index = 0; index < state.ships.count; index++) {
    if (index !== flag && state.ships.alive[index] === 1 && state.ships.division[index] === division) return index
  }
  throw new Error('no mate')
}
