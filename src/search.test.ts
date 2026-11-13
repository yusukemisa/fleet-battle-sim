import { describe, expect, it } from 'vitest'
import { SENSOR } from './balance.ts'
import { contactAge, openTheRange, updateContacts } from './contacts.ts'
import { createSim, dispatch } from './sim.ts'

describe('shared contacts', () => {
  it('gives every friendly ship a sighting that only one of them could make, and keeps the last place', () => {
    const state = createSim({ shipCount: 100, brains: ['rule', 'rule'] })
    openTheRange(state, 20000)
    const blue = shipOn(state, 0)
    const reds = shipsOn(state, 1)
    const near = reds[0] ?? 0
    const far = reds[reds.length - 1] ?? 0
    state.ships.x[near] = (state.ships.x[blue] ?? 0) + 120
    state.ships.y[near] = state.ships.y[blue] ?? 0
    updateContacts(state)
    expect(state.contacts[0].at[near]).toBe(0)
    expect(state.contacts[0].x[near]).toBeCloseTo(state.ships.x[near] ?? 0)
    expect(state.contacts[0].at[far]).toBe(-1)
    state.ships.x[near] = (state.ships.x[blue] ?? 0) + 20000
    state.time = 6
    state.frame = 4
    updateContacts(state)
    expect(state.contacts[0].stamp[near]).not.toBe(4)
    expect(state.contacts[0].at[near]).toBe(0)
    expect(contactAge(state, 0)).toBe(6)
  })

  it('lets scouts find an unseen enemy sooner than the battleship line', () => {
    const gap = 14000
    let scouts = createSim({ shipCount: 100, commanders: ['balanced', 'cunning'], brains: ['rule', 'rule'] })
    openTheRange(scouts, gap)
    scouts = dispatch(scouts, { type: 'set-speed', speed: 4 })
    scouts = dispatch(scouts, { type: 'start' })
    let scoutTime = -1
    let bodyGap = 0
    while (scouts.phase.kind === 'running' && scouts.time < 220) {
      scouts = dispatch(scouts, { type: 'tick', dt: 0.05 })
      if (scoutTime < 0 && contactAge(scouts, 0) < 0.2) {
        scoutTime = scouts.time
        bodyGap = battleshipGap(scouts)
        break
      }
    }
    const bodyTime = (gap - SENSOR) / (12 + 12)
    expect(scoutTime).toBeGreaterThan(0)
    expect(scoutTime).toBeLessThan(bodyTime * 0.75)
    expect(bodyGap).toBeGreaterThan(SENSOR)
    expect(scouts.collisionDeaths[0] + scouts.collisionDeaths[1]).toBe(0)
  })

  it('still finds the enemy when each side has 1,000 ships', () => {
    let state = createSim({ shipCount: 1000, commanders: ['balanced', 'cunning'], brains: ['rule', 'rule'] })
    state = dispatch(state, { type: 'set-formation', side: 1, formationId: 'kakuyoku' })
    openTheRange(state, 14000)
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    let scoutTime = -1
    while (state.phase.kind === 'running' && state.time < 260) {
      state = dispatch(state, { type: 'tick', dt: 0.05 })
      if (contactAge(state, 0) < 0.2) {
        scoutTime = state.time
        break
      }
    }
    expect(scoutTime).toBeGreaterThan(0)
    expect(scoutTime).toBeLessThan(240)
    expect(state.collisionDeaths[0] + state.collisionDeaths[1]).toBe(0)
  })
})

function shipOn(state: ReturnType<typeof createSim>, side: 0 | 1): number {
  for (let i = 0; i < state.ships.count; i++) {
    if (state.ships.alive[i] === 1 && state.ships.side[i] === side) return i
  }
  throw new Error('no ship')
}

function shipsOn(state: ReturnType<typeof createSim>, side: 0 | 1): number[] {
  const found: number[] = []
  for (let i = 0; i < state.ships.count; i++) {
    if (state.ships.alive[i] === 1 && state.ships.side[i] === side) found.push(i)
  }
  return found
}

function battleshipGap(state: ReturnType<typeof createSim>): number {
  let best = Infinity
  const ships = state.ships
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] !== 1 || ships.side[i] !== 0 || ships.shipClass[i] !== 0) continue
    for (let j = 0; j < ships.count; j++) {
      if (ships.alive[j] !== 1 || ships.side[j] !== 1) continue
      const dist = Math.hypot((ships.x[i] ?? 0) - (ships.x[j] ?? 0), (ships.y[i] ?? 0) - (ships.y[j] ?? 0))
      if (dist < best) best = dist
    }
  }
  return best
}
