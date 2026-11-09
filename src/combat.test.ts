import { describe, expect, it } from 'vitest'
import { SHIP_STATS } from './balance.ts'
import { armorMultiplier, inFiringArc } from './combat.ts'
import { createSim, dispatch } from './sim.ts'
import type { SideId, SimState, Speed } from './types.ts'

describe('directional combat', () => {
  it('cannot hit a target behind the bow', () => {
    expect(inFiringArc(0, 0, 0, 30, 0, SHIP_STATS.arc)).toBe(true)
    expect(inFiringArc(0, 0, 0, -30, 0, SHIP_STATS.arc)).toBe(false)
    const state = createSim({ shipCount: 100, commanders: ['manual', 'manual'] })
    state.stats.hitChance = 1
    const ships = state.ships
    for (let i = 0; i < ships.count; i++) ships.cooldown[i] = 5
    ships.x[0] = 0
    ships.y[0] = 0
    ships.heading[0] = 0
    ships.cooldown[0] = 0
    ships.target[0] = 50
    ships.x[50] = -90
    ships.y[50] = 0
    ships.heading[50] = 0
    const hp = ships.hp[50] ?? 0
    let next = dispatch(state, { type: 'start' })
    next = dispatch(next, { type: 'tick', dt: 0.05 })
    expect(next.ships.hp[50]).toBe(hp)
  })

  it('deals more damage into the rear than into the bow', () => {
    const rear = armorMultiplier(0, 0, 0, -20, 0, SHIP_STATS)
    const front = armorMultiplier(0, 0, 0, 20, 0, SHIP_STATS)
    expect(rear).toBeGreaterThan(front)
    expect(front).toBe(SHIP_STATS.armorFront)
    expect(rear).toBe(SHIP_STATS.armorRear)
    const fromFront = damageFrom(0, 400)
    const fromRear = damageFrom(0, -400)
    expect(fromRear).toBeGreaterThan(fromFront)
  })

  it('fires once per 2s of sim time, at any frame step or speed', () => {
    expect(SHIP_STATS.cooldown).toBe(2)
    const cases: ReadonlyArray<readonly [number, Speed]> = [
      [1 / 60, 1],
      [1 / 30, 1],
      [0.05, 1],
      [0.01, 1],
      [0.05, 2],
      [0.05, 4],
    ]
    for (const [dt, speed] of cases) {
      const times = shotTimes(dt, speed, SHIP_STATS.cooldown * 4 + 0.05)
      expect(times).toHaveLength(4)
      for (let window = 0; window < 4; window++) {
        const start = SHIP_STATS.cooldown * window
        const end = start + SHIP_STATS.cooldown
        const hits = times.filter((time) => time > start + 1e-3 && time <= end + 1e-3)
        expect(hits).toHaveLength(1)
        expect(hits[0]).toBeCloseTo(end, 3)
      }
    }
  })

  it('wins from the flank more often than from the front', () => {
    let flankWins = 0
    let frontWins = 0
    const flankMargins: number[] = []
    const frontMargins: number[] = []
    for (let seed = 1; seed <= 7; seed++) {
      const flank = margin(runDuel('flank', seed))
      const front = margin(runDuel('front', seed))
      flankMargins.push(flank)
      frontMargins.push(front)
      if (flank > 0) flankWins += 1
      if (front > 0) frontWins += 1
    }
    expect(flankWins).toBeGreaterThan(frontWins)
    expect(flankWins).toBeGreaterThan(3)
    expect(average(flankMargins)).toBeGreaterThan(average(frontMargins))
  })
})

function damageFrom(targetHeading: number, shooterX: number): number {
  const state = createSim({ shipCount: 100, commanders: ['manual', 'manual'] })
  state.stats.hitChance = 1
  const ships = state.ships
  for (let i = 0; i < ships.count; i++) ships.cooldown[i] = 5
  ships.x[0] = shooterX
  ships.y[0] = 0
  ships.heading[0] = Math.atan2(0, -shooterX)
  ships.cooldown[0] = 0
  ships.target[0] = 50
  ships.x[50] = 0
  ships.y[50] = 0
  ships.heading[50] = targetHeading
  pin(state, 0)
  pin(state, 50)
  const before = ships.hp[50] ?? 0
  let next = dispatch(state, { type: 'start' })
  next = dispatch(next, { type: 'tick', dt: 0.05 })
  return before - (next.ships.hp[50] ?? 0)
}

function pin(state: SimState, index: number): void {
  const ships = state.ships
  const division = state.divisions[ships.division[index] ?? 0]
  if (!division) return
  division.ax = ships.x[index] ?? 0
  division.ay = ships.y[index] ?? 0
  division.fx = Math.cos(ships.heading[index] ?? 0)
  division.fy = Math.sin(ships.heading[index] ?? 0)
  division.rx = division.fy
  division.ry = -division.fx
  division.tacticId = 'hold'
  division.holdArmed = true
  division.holdX = division.ax
  division.holdY = division.ay
  ships.slotX[index] = 0
  ships.slotY[index] = 0
}

function runDuel(mode: 'front' | 'flank', seed: number): SimState {
  const state = createSim({ shipCount: 100, commanders: ['manual', 'manual'], hp: 32, damage: [6, 6] })
  state.rng = seed * 0x9e3779b1
  state.stats.hitChance = 1
  if (mode === 'front') {
    station(state, 0, -180, 0, 0)
    station(state, 1, 180, 0, Math.PI)
  } else {
    station(state, 0, 0, 400, -Math.PI / 2)
    station(state, 1, 0, 0, 0)
  }
  let next = dispatch(state, { type: 'start' })
  const dt = 1 / 20
  const steps = Math.round(17 / dt)
  for (let step = 0; step < steps; step++) next = dispatch(next, { type: 'tick', dt })
  return next
}

function shotTimes(frameDt: number, speed: Speed, seconds: number): number[] {
  let state = aimingShip(speed)
  const times: number[] = []
  let seen = state.beams.head
  let guard = 0
  while (state.time < seconds) {
    state = dispatch(state, { type: 'tick', dt: frameDt })
    if (state.beams.head !== seen) {
      times.push(state.time)
      seen = state.beams.head
    }
    guard += 1
    if (guard > 100000) throw new Error('sim time did not advance')
  }
  return times
}

function aimingShip(speed: Speed): SimState {
  const state = createSim({ shipCount: 100, commanders: ['manual', 'manual'] })
  const ships = state.ships
  for (let i = 0; i < ships.count; i++) {
    ships.cooldown[i] = 100
    if (i !== 0 && i !== 50) ships.alive[i] = 0
  }
  ships.x[0] = 0
  ships.y[0] = 0
  ships.heading[0] = 0
  ships.cooldown[0] = state.stats.cooldown
  ships.target[0] = 50
  ships.x[50] = 420
  ships.y[50] = 0
  ships.heading[50] = Math.PI
  ships.hp[50] = 500
  pin(state, 0)
  pin(state, 50)
  let next = dispatch(state, { type: 'set-speed', speed })
  next = dispatch(next, { type: 'start' })
  return next
}

function station(state: SimState, side: SideId, originX: number, originY: number, heading: number): void {
  const ships = state.ships
  const half = state.shipCount / 2
  const offset = side * half
  const fx = Math.cos(heading)
  const fy = Math.sin(heading)
  const rx = fy
  const ry = -fx
  for (let i = 0; i < half; i++) {
    const at = offset + i
    const col = i % 10
    const row = Math.floor(i / 10)
    ships.x[at] = originX + rx * (col - 4.5) * 8 + fx * (row - 2) * 8
    ships.y[at] = originY + ry * (col - 4.5) * 8 + fy * (row - 2) * 8
    ships.heading[at] = heading
    ships.vx[at] = 0
    ships.vy[at] = 0
    ships.hp[at] = state.stats.hp
    ships.alive[at] = 1
    ships.side[at] = side
    ships.cooldown[at] = (i % 7) * 0.04
    ships.target[at] = -1
    ships.division[at] = side * 5 + (i % 5)
  }
  for (let slot = 0; slot < 5; slot++) {
    const division = state.divisions[side * 5 + slot]
    if (!division) continue
    let sx = 0
    let sy = 0
    let n = 0
    for (let i = 0; i < half; i++) {
      const at = offset + i
      if (ships.division[at] !== division.side * 5 + slot) continue
      sx += ships.x[at] ?? 0
      sy += ships.y[at] ?? 0
      n += 1
    }
    division.ax = n > 0 ? sx / n : originX
    division.ay = n > 0 ? sy / n : originY
    division.fx = fx
    division.fy = fy
    division.rx = rx
    division.ry = ry
    division.tacticId = 'hold'
    division.holdArmed = true
    division.holdX = division.ax
    division.holdY = division.ay
    division.alive = n
    division.phase = 0
    division.phaseT = 0
    division.vx = 0
    division.vy = 0
  }
  for (let i = 0; i < half; i++) {
    const at = offset + i
    const division = state.divisions[ships.division[at] ?? 0]
    if (!division) continue
    const dx = (ships.x[at] ?? 0) - division.ax
    const dy = (ships.y[at] ?? 0) - division.ay
    ships.slotX[at] = dx * division.rx + dy * division.ry
    ships.slotY[at] = dx * division.fx + dy * division.fy
  }
  state.alive[side] = half
  state.lost[side] = 0
}

function margin(state: SimState): number {
  return state.alive[0] - state.alive[1]
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
