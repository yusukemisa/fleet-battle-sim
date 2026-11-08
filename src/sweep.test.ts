import { describe, expect, it } from 'vitest'
import { SHIP_STATS, SWEEP } from './balance.ts'
import { createSim, dispatch } from './sim.ts'
import type { SimState } from './types.ts'

describe('close-range wheel', () => {
  it('keeps speed and turns clockwise after the fleets meet', () => {
    let state = createSim({
      shipCount: 100,
      formations: ['oujin', 'oujin'],
      commanders: ['manual', 'manual'],
    })
    state.rng = 0x51ed
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    const samples: { speed: number; dist: number; spread: number }[] = []
    let contact = -1
    let prev = 0
    let turned = 0
    for (let step = 0; step < 4000 && state.phase.kind === 'running'; step++) {
      state = dispatch(state, { type: 'tick', dt: 0.05 })
      const dx = state.centroidX[0] - state.centroidX[1]
      const dy = state.centroidY[0] - state.centroidY[1]
      const dist = Math.hypot(dx, dy)
      const angle = Math.atan2(dy, dx)
      if (contact < 0 && dist < SWEEP.engage) {
        contact = state.time
        prev = angle
      }
      if (contact < 0 || state.time > contact + 12) continue
      let delta = angle - prev
      while (delta > Math.PI) delta -= Math.PI * 2
      while (delta < -Math.PI) delta += Math.PI * 2
      turned += delta
      prev = angle
      samples.push({ speed: meanSpeed(state), dist, spread: meanSpread(state) })
      if (state.time >= contact + 12) break
    }
    expect(contact).toBeGreaterThan(0)
    expect(samples.length).toBeGreaterThan(20)
    const speed = average(samples.map((sample) => sample.speed))
    const dist = average(samples.map((sample) => sample.dist))
    const spread = average(samples.map((sample) => sample.spread))
    expect(speed).toBeGreaterThan(SHIP_STATS.maxSpeed * 0.4)
    expect(turned).toBeLessThan(-0.8)
    expect(dist).toBeGreaterThan(280)
    expect(spread).toBeGreaterThan(50)
  })

  it('lets 定点射撃 stay put inside engagement range', () => {
    let state = createSim({ shipCount: 100, commanders: ['manual', 'manual'] })
    for (let index = 0; index < 10; index++) {
      state = dispatch(state, { type: 'set-tactic', division: index, tacticId: 'hold' })
    }
    shiftSide(state, 0, -350 - state.centroidX[0])
    shiftSide(state, 1, 350 - state.centroidX[1])
    const startX = state.centroidX[0]
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    let speed = 0
    let n = 0
    for (let step = 0; step < 80; step++) {
      state = dispatch(state, { type: 'tick', dt: 0.05 })
      speed += meanSpeed(state)
      n += 1
    }
    expect(speed / n).toBeLessThan(SHIP_STATS.maxSpeed * 0.15)
    expect(Math.abs(state.centroidX[0] - startX)).toBeLessThan(40)
    expect(state.divisions.every((division) => division.tacticId === 'hold' && !division.sweeping)).toBe(true)
  })
})

function meanSpeed(state: SimState): number {
  const ships = state.ships
  let sum = 0
  let n = 0
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] === 0) continue
    sum += Math.hypot(ships.vx[i] ?? 0, ships.vy[i] ?? 0)
    n += 1
  }
  return n === 0 ? 0 : sum / n
}

function meanSpread(state: SimState): number {
  let sum = 0
  let n = 0
  for (const division of state.divisions) {
    if (division.alive === 0) continue
    sum += Math.hypot(division.ax - state.centroidX[division.side], division.ay - state.centroidY[division.side])
    n += 1
  }
  return n === 0 ? 0 : sum / n
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function shiftSide(state: SimState, side: 0 | 1, dx: number): void {
  const half = state.shipCount / 2
  const offset = side * half
  for (let i = 0; i < half; i++) state.ships.x[offset + i] = (state.ships.x[offset + i] ?? 0) + dx
  for (let slot = 0; slot < 5; slot++) {
    const division = state.divisions[side * 5 + slot]
    if (!division) continue
    division.ax += dx
    division.holdX += dx
    division.markX += dx
  }
  state.centroidX[side] += dx
  state.fleets[side].centerX += dx
}
