import { describe, expect, it } from 'vitest'
import { BLAST, SHIP_STATS, STRAY } from './balance.ts'
import { COMMANDERS } from './commanders.ts'
import { armorMultiplier, armorZone } from './combat.ts'
import { blastDamage, crossfireScale, strayChance } from './gunnery.ts'
import { createSim, dispatch, explode } from './sim.ts'
import { fillSpatialHash } from './spatial.ts'
import type { SimState } from './types.ts'

describe('fire control', () => {
  it('pays for a second bearing, and a crowd is more likely to catch a stray than an empty sea', () => {
    expect(crossfireScale(99, 0)).toBe(1)
    expect(crossfireScale(0, 1.2)).toBeGreaterThan(1)
    expect(crossfireScale(0, 0.2)).toBe(1)
    expect(strayChance(0)).toBe(0)
    expect(strayChance(2)).toBeCloseTo(STRAY.perShip * 2)
    expect(strayChance(40)).toBe(STRAY.cap)
    expect(blastDamage(7.1, 0)).toBeGreaterThan(blastDamage(2.3, 0))
    expect(blastDamage(7.1, 7.1 * BLAST.reach + 1)).toBe(0)
  })

  it('lets a battleship explosion reach a nearby hull and stop short of a distant one', () => {
    const state = createSim({ shipCount: 100, commanders: ['manual', 'manual'] })
    const ships = state.ships
    ships.alive.fill(0)
    ships.alive[0] = 1
    ships.alive[1] = 1
    ships.alive[2] = 1
    ships.shipClass[0] = 0
    ships.shipClass[1] = 2
    ships.shipClass[2] = 2
    ships.hp[0] = 54
    ships.hp[1] = 18
    ships.hp[2] = 18
    ships.x[0] = 0
    ships.y[0] = 0
    ships.x[1] = 24
    ships.y[1] = 0
    ships.x[2] = 400
    ships.y[2] = 0
    fillSpatialHash(state.scratch.hash, ships.x, ships.y, ships.alive, ships.count)
    explode(state, 0)
    expect(ships.hp[1]).toBeLessThan(18)
    expect(ships.hp[1]).toBeGreaterThan(0)
    expect(ships.hp[2]).toBe(18)
  })

  it('matches the bow and stern armor zones', () => {
    expect(armorZone(0, 0, 0, 20, 0, SHIP_STATS)).toBe('front')
    expect(armorZone(0, 0, 0, -20, 0, SHIP_STATS)).toBe('rear')
    expect(armorZone(0, 0, 0, 0, 20, SHIP_STATS)).toBe('side')
    let mismatches = 0
    for (let h = 0; h < 12; h++) {
      for (let a = 0; a < 24; a++) {
        const heading = (h / 12) * Math.PI * 2
        const incoming = (a / 24) * Math.PI * 2
        const diff = Math.abs(wrap(incoming - heading))
        const oracle = diff <= SHIP_STATS.armorBow ? 'front' : diff >= Math.PI - SHIP_STATS.armorStern ? 'rear' : 'side'
        const got = armorZone(heading, 0, 0, Math.cos(incoming), Math.sin(incoming), SHIP_STATS)
        if (got !== oracle) mismatches += 1
      }
    }
    expect(mismatches).toBe(0)
    expect(armorMultiplier(0, 0, 0, -20, 0, SHIP_STATS)).toBe(SHIP_STATS.armorRear)
  })

  it('spreads a salvo once a hull is already covered', () => {
    const state = scene()
    const ships = state.ships
    ships.hp[50] = 8
    ships.x[50] = 420
    ships.y[50] = 0
    ships.x[51] = 420
    ships.y[51] = 36
    const next = dispatch(dispatch(state, { type: 'start' }), { type: 'tick', dt: 0.05 })
    expect(next.ships.hp[51]).toBeLessThan(SHIP_STATS.hp - 1)
    expect(next.ships.hp[50] ?? 0).toBeLessThanOrEqual(0)
    expect(next.tally.overkill).toBe(0)
  })

  it('picks the exposed rear over a closer bow', () => {
    const state = scene()
    const ships = state.ships
    ships.alive[1] = 0
    ships.alive[2] = 0
    ships.alive[3] = 0
    ships.alive[4] = 0
    ships.alive[5] = 0
    ships.x[50] = 480
    ships.y[50] = 0
    ships.heading[50] = 0
    ships.hp[50] = SHIP_STATS.hp
    ships.x[51] = 400
    ships.y[51] = 36
    ships.heading[51] = Math.PI
    ships.hp[51] = SHIP_STATS.hp
    const beforeRear = ships.hp[50] ?? 0
    const beforeFront = ships.hp[51] ?? 0
    const next = dispatch(dispatch(state, { type: 'start' }), { type: 'tick', dt: 0.05 })
    expect(beforeRear - (next.ships.hp[50] ?? 0)).toBeGreaterThan(0)
    expect(next.ships.hp[51]).toBe(beforeFront)
  })
})

describe('withdrawal', () => {
  it('is conservative for 守将, 常勝, and 智将, and slight for 猛将', () => {
    expect(COMMANDERS.guard.withdraw.hp).toBeGreaterThan(COMMANDERS.fierce.withdraw.hp)
    expect(COMMANDERS.balanced.withdraw.hp).toBeGreaterThan(COMMANDERS.fierce.withdraw.hp)
    expect(COMMANDERS.cunning.withdraw.hp).toBeGreaterThan(COMMANDERS.fierce.withdraw.hp)
    expect(COMMANDERS.fierce.withdraw.reengage).toBeGreaterThan(COMMANDERS.guard.withdraw.reengage)
    expect(COMMANDERS.fierce.withdraw.depth).toBeLessThan(COMMANDERS.guard.withdraw.depth)
    expect(COMMANDERS.manual.withdraw.hp).toBe(0)
  })

  it('rotates a wounded ship behind healthy ships in the same division', () => {
    let state = createSim({
      shipCount: 100,
      commanders: ['guard', 'manual'],
      brains: ['rule', 'rule'],
      withdraw: [true, false],
    })
    const ships = state.ships
    const wounded = woundedShip(state)
    ships.hp[wounded] = 4
    state = dispatch(state, { type: 'start' })
    for (let step = 0; step < 30; step++) state = dispatch(state, { type: 'tick', dt: 0.05 })
    expect(ships.falling[wounded]).toBe(1)
    let ahead = 0
    let behind = 0
    const division = ships.division[wounded] ?? 0
    for (let i = 0; i < ships.count; i++) {
      if (ships.alive[i] === 0 || ships.division[i] !== division || i === wounded) continue
      if ((ships.slotY[i] ?? 0) > (ships.slotY[wounded] ?? 0)) ahead += 1
      else behind += 1
    }
    expect(ahead).toBeGreaterThan(behind)
    expect(ahead).toBeGreaterThan(0)
  })
})

function wrap(delta: number): number {
  let turn = delta
  while (turn > Math.PI) turn -= Math.PI * 2
  while (turn < -Math.PI) turn += Math.PI * 2
  return turn
}

function scene(): SimState {
  const state = createSim({
    shipCount: 100,
    commanders: ['manual', 'manual'],
    gunnery: 'aimed',
    withdraw: [false, false],
  })
  state.stats.hitChance = 1
  const ships = state.ships
  for (let i = 0; i < ships.count; i++) {
    ships.alive[i] = 0
    ships.cooldown[i] = 100
    ships.hp[i] = 0
  }
  for (let i = 0; i < 6; i++) {
    ships.alive[i] = 1
    ships.side[i] = 0
    ships.shipClass[i] = 0
    ships.hp[i] = SHIP_STATS.hp
    ships.cooldown[i] = 0
    ships.x[i] = 0
    ships.y[i] = (i - 2.5) * 6
    ships.heading[i] = 0
    ships.target[i] = -1
    ships.vx[i] = 0
    ships.vy[i] = 0
  }
  for (const at of [50, 51]) {
    ships.alive[at] = 1
    ships.side[at] = 1
    ships.shipClass[at] = 0
    ships.hp[at] = SHIP_STATS.hp
    ships.cooldown[at] = 100
    ships.heading[at] = Math.PI
    ships.target[at] = -1
  }
  const division = state.divisions[0]
  if (division) {
    division.ax = 0
    division.ay = 0
    division.fx = 1
    division.fy = 0
    division.rx = 0
    division.ry = -1
    division.tacticId = 'hold'
    division.holdArmed = true
    division.holdX = 0
    division.holdY = 0
  }
  for (let i = 0; i < 6; i++) {
    ships.slotX[i] = ships.y[i] ?? 0
    ships.slotY[i] = 0
    ships.division[i] = 0
  }
  return state
}

function woundedShip(state: SimState): number {
  const ships = state.ships
  for (let i = 0; i < ships.count; i++) {
    if (ships.side[i] === 0 && ships.division[i] === 2) return i
  }
  return 0
}
