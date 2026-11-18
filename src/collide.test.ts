import { describe, expect, it } from 'vitest'
import { BLAST, HULL_RADIUS, hullRadius } from './balance.ts'
import { separateShips } from './collide.ts'
import { shipMark } from './draw.ts'
import { shotBlocked } from './gunnery.ts'
import { createSim, dispatch } from './sim.ts'
import { fillSpatialHash } from './spatial.ts'

describe('hulls', () => {
  it('makes battleships larger than cruisers, and cruisers larger than destroyers', () => {
    expect(hullRadius(0)).toBeGreaterThan(hullRadius(1))
    expect(hullRadius(1)).toBeGreaterThan(hullRadius(2))
    expect(HULL_RADIUS[0]).toBeGreaterThan(HULL_RADIUS[2] * 2)
  })

  it('slides overlapping ships apart instead of letting them share a point', () => {
    const state = createSim({ shipCount: 100, commanders: ['manual', 'manual'] })
    state.ships.alive.fill(0)
    state.ships.alive[0] = 1
    state.ships.alive[1] = 1
    state.ships.shipClass[0] = 0
    state.ships.shipClass[1] = 2
    state.ships.x[0] = 0
    state.ships.y[0] = 0
    state.ships.x[1] = 1
    state.ships.y[1] = 0
    state.ships.heading[0] = 0
    state.ships.heading[1] = 0
    state.divisions[0]!.alive = 2
    separateShips(state)
    const gap = Math.hypot((state.ships.x[0] ?? 0) - (state.ships.x[1] ?? 0), (state.ships.y[0] ?? 0) - (state.ships.y[1] ?? 0))
    expect(gap).toBeGreaterThan(HULL_RADIUS[0] + HULL_RADIUS[2] - 0.2)
  })

  it('damages both hulls in a slow overlap, and a repeated overlap can sink the lighter one', () => {
    const state = createSim({ shipCount: 100, commanders: ['manual', 'manual'] })
    const ships = state.ships
    ships.alive.fill(0)
    ships.alive[0] = 1
    ships.alive[1] = 1
    ships.shipClass[0] = 0
    ships.shipClass[1] = 2
    ships.hp[0] = 54
    ships.hp[1] = 18
    ships.x[0] = 0
    ships.y[0] = 0
    ships.x[1] = 4
    ships.y[1] = 0
    ships.vx[0] = 0
    ships.vy[0] = 0
    ships.vx[1] = 0
    ships.vy[1] = 0
    separateShips(state)
    expect(state.collisionDeaths[0] + state.collisionDeaths[1]).toBe(0)
    expect(ships.hp[0] ?? 0).toBeLessThan(54)
    expect(ships.hp[1] ?? 0).toBeLessThan(18)
    expect(ships.hp[1] ?? 0).toBeGreaterThan(0)
    expect(54 - (ships.hp[0] ?? 0)).toBeLessThan(18 - (ships.hp[1] ?? 0))
    let sunk = false
    for (let step = 0; step < 30; step++) {
      ships.x[0] = 0
      ships.y[0] = 0
      ships.x[1] = 4
      ships.y[1] = 0
      ships.vx[0] = 0
      ships.vx[1] = 0
      separateShips(state)
      if ((ships.hp[1] ?? 0) <= 0) {
        sunk = true
        break
      }
    }
    expect(sunk).toBe(true)
    expect(state.collisionDeaths[0] + state.collisionDeaths[1]).toBe(1)
  })

  it('destroys only the lighter hull in a fast ram, and both hulls of equal weight', () => {
    const state = createSim({ shipCount: 100, commanders: ['manual', 'manual'] })
    const ships = state.ships
    ships.alive.fill(0)
    ships.alive[0] = 1
    ships.alive[1] = 1
    ships.shipClass[0] = 0
    ships.shipClass[1] = 2
    ships.hp[0] = 54
    ships.hp[1] = 18
    ships.x[0] = 0
    ships.y[0] = 0
    ships.x[1] = 4
    ships.y[1] = 0
    ships.vx[0] = 40
    ships.vx[1] = -40
    separateShips(state)
    expect(ships.hp[0] ?? 0).toBeLessThan(54)
    expect(ships.hp[0] ?? 0).toBeGreaterThan(0)
    expect(ships.hp[1]).toBe(0)
    expect(state.collisionDeaths.reduce((sum, value) => sum + value, 0)).toBe(1)
    ships.alive[2] = 1
    ships.alive[3] = 1
    ships.shipClass[2] = 0
    ships.shipClass[3] = 0
    ships.hp[2] = 54
    ships.hp[3] = 54
    ships.x[2] = 0
    ships.y[2] = 80
    ships.x[3] = 6
    ships.y[3] = 80
    ships.vx[2] = 50
    ships.vx[3] = -50
    separateShips(state)
    expect(ships.hp[2]).toBe(0)
    expect(ships.hp[3]).toBe(0)
  })

  it('damages every overlapping pair in one step', () => {
    const state = createSim({ shipCount: 1000, commanders: ['manual', 'manual'] })
    const ships = state.ships
    ships.alive.fill(0)
    for (let pair = 0; pair < 80; pair++) {
      const a = pair * 2
      const b = a + 1
      ships.alive[a] = 1
      ships.alive[b] = 1
      ships.shipClass[a] = 0
      ships.shipClass[b] = 0
      ships.hp[a] = 54
      ships.hp[b] = 54
      ships.x[a] = pair * 40
      ships.y[a] = 0
      ships.x[b] = pair * 40 + 4
      ships.y[b] = 0
      ships.vx[a] = 40
      ships.vx[b] = -40
    }
    separateShips(state)
    const dead = state.collisionDeaths[0] + state.collisionDeaths[1]
    expect(dead).toBe(160)
  })

  it('lets a sinking hull wound a friend, and stops the chain at the step limit', () => {
    const state = createSim({ shipCount: 100, commanders: ['manual', 'manual'] })
    const ships = state.ships
    ships.alive.fill(0)
    ships.alive[0] = 1
    ships.alive[1] = 1
    ships.side[0] = 0
    ships.side[1] = 0
    ships.shipClass[0] = 0
    ships.shipClass[1] = 2
    ships.hp[0] = 0
    ships.hp[1] = 18
    ships.x[0] = 0
    ships.y[0] = 0
    ships.x[1] = 16
    ships.y[1] = 0
    ships.division[0] = 0
    ships.division[1] = 0
    const anchor = state.divisions[0]
    if (!anchor) throw new Error('division')
    anchor.ax = 0
    anchor.ay = 0
    let running = dispatch(state, { type: 'set-speed', speed: 1 })
    running = dispatch(running, { type: 'start' })
    running = dispatch(running, { type: 'tick', dt: 0.05 })
    expect(running.ships.alive[0]).toBe(0)
    expect(running.ships.hp[1] ?? 0).toBeLessThan(18)

    const chain = createSim({ shipCount: 1000, commanders: ['manual', 'manual'] })
    const packed = chain.ships
    packed.alive.fill(0)
    const line = chain.divisions[0]
    if (!line) throw new Error('division')
    line.ax = 0
    line.ay = 0
    for (let i = 0; i < 400; i++) {
      packed.alive[i] = 1
      packed.side[i] = 0
      packed.shipClass[i] = 2
      packed.division[i] = 0
      packed.hp[i] = 1
      packed.x[i] = i * 3
      packed.y[i] = 0
      packed.slotX[i] = 0
      packed.slotY[i] = i * 3
    }
    packed.hp[0] = 0
    let stepped = dispatch(chain, { type: 'set-speed', speed: 1 })
    stepped = dispatch(stepped, { type: 'start' })
    stepped = dispatch(stepped, { type: 'tick', dt: 0.05 })
    expect(stepped.scratch.blasts).toBe(BLAST.max)
    let spared = 0
    for (let i = 0; i < 400; i++) if ((stepped.ships.hp[i] ?? 0) > 0) spared += 1
    expect(spared).toBeGreaterThan(0)
  })

  it('draws a hull about as long as its collision diameter', () => {
    const mark = shipMark(1, HULL_RADIUS[0], 1.7, 1.55)
    expect(mark.halfLen * 2).toBeCloseTo(HULL_RADIUS[0] * 2, 5)
    expect(mark.hullW).toBeLessThan(mark.halfLen * 2)
    const far = shipMark(0.01, HULL_RADIUS[0], 1.7, 1.55)
    expect(far.halfLen * 2).toBeGreaterThan(HULL_RADIUS[0] * 2 * 0.01)
  })

  it('does not fire through a hull sitting on the line', () => {
    const state = createSim({ shipCount: 100, commanders: ['manual', 'manual'], gunnery: 'aimed' })
    const ships = state.ships
    for (let i = 0; i < ships.count; i++) ships.alive[i] = 0
    ships.alive[0] = 1
    ships.alive[1] = 1
    ships.alive[50] = 1
    ships.side[0] = 0
    ships.side[1] = 0
    ships.side[50] = 1
    ships.shipClass[0] = 0
    ships.shipClass[1] = 0
    ships.shipClass[50] = 0
    ships.x[0] = 0
    ships.y[0] = 0
    ships.x[1] = 200
    ships.y[1] = 0
    ships.x[50] = 500
    ships.y[50] = 0
    ships.heading[0] = 0
    state.scratch.bowX[0] = 1
    state.scratch.bowY[0] = 0
    fillSpatialHash(state.scratch.hash, ships.x, ships.y, ships.alive, ships.count)
    expect(shotBlocked(state, 0, 50)).toBe(true)
    ships.y[1] = 40
    fillSpatialHash(state.scratch.hash, ships.x, ships.y, ships.alive, ships.count)
    expect(shotBlocked(state, 0, 50)).toBe(false)
  })

  it('does not leave a ship spinning in place after the battle starts', () => {
    let state = createSim({
      shipCount: 100,
      commanders: ['balanced', 'fierce'],
      formations: ['oujin', 'kakuyoku'],
      brains: ['rule', 'rule'],
    })
    for (let a = 0; a < state.ships.count; a++) {
      if (state.ships.alive[a] === 0) continue
      for (let b = a + 1; b < state.ships.count; b++) {
        if (state.ships.alive[b] === 0) continue
        const gap = Math.hypot((state.ships.x[a] ?? 0) - (state.ships.x[b] ?? 0), (state.ships.y[a] ?? 0) - (state.ships.y[b] ?? 0))
        const need = hullRadius(state.ships.shipClass[a] ?? 0) + hullRadius(state.ships.shipClass[b] ?? 0)
        expect(gap).toBeGreaterThanOrEqual(need - 0.05)
      }
    }
    const heading = Float32Array.from(state.ships.heading)
    const x0 = Float32Array.from(state.ships.x)
    const y0 = Float32Array.from(state.ships.y)
    const turned = new Float64Array(state.ships.count)
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    for (let step = 0; step < 80; step++) {
      const before = Float32Array.from(state.ships.heading)
      state = dispatch(state, { type: 'tick', dt: 0.05 })
      for (let i = 0; i < state.ships.count; i++) {
        if (state.ships.alive[i] === 0) continue
        let delta = (state.ships.heading[i] ?? 0) - (before[i] ?? 0)
        while (delta > Math.PI) delta -= Math.PI * 2
        while (delta < -Math.PI) delta += Math.PI * 2
        turned[i] = (turned[i] ?? 0) + Math.abs(delta)
      }
    }
    let stuck = 0
    for (let i = 0; i < state.ships.count; i++) {
      if (state.ships.alive[i] === 0) continue
      const moved = Math.hypot((state.ships.x[i] ?? 0) - (x0[i] ?? 0), (state.ships.y[i] ?? 0) - (y0[i] ?? 0))
      if (moved < 12 && (turned[i] ?? 0) > Math.PI * 1.25) stuck += 1
    }
    expect(stuck).toBe(0)
    expect(heading.length).toBe(state.ships.count)
  })

  it('sends a division that has fallen out of the fight back toward an enemy', () => {
    let state = createSim({ shipCount: 100, commanders: ['guard', 'fierce'], brains: ['rule', 'rule'] })
    const wing = state.divisions[0]
    if (!wing) throw new Error('division')
    wing.ax = -4000
    wing.ay = 0
    wing.tacticId = 'hold'
    const before = wing.ax
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    for (let step = 0; step < 30; step++) state = dispatch(state, { type: 'tick', dt: 0.05 })
    const after = state.divisions[0]?.ax ?? before
    expect(after).toBeGreaterThan(before + 20)
  })
})
