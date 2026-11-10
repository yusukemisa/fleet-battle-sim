import { describe, expect, it } from 'vitest'
import { SIM_TIME_SCALE } from './balance.ts'
import { createSim, dispatch } from './sim.ts'
import { parseFormationId, parseShipCount, parseTacticId } from './parse.ts'

function run(seconds: number, shipCount: 100 | 1000 | 10000 = 100, damage?: readonly [number, number]) {
  let state = createSim({
    shipCount,
    formations: ['kakuyoku', 'hoshi'],
    ...(damage ? { damage, hp: 24 } : {}),
  })
  state = dispatch(state, { type: 'start' })
  const steps = Math.round(seconds / (1 / 30))
  for (let i = 0; i < steps; i++) state = dispatch(state, { type: 'tick', dt: 1 / 30 })
  return state
}

describe('battle', () => {
  it('starts in 横陣 for both fleets and keeps the two sides apart', () => {
    const state = createSim({ shipCount: 1000 })
    expect(state.phase.kind).toBe('setup')
    expect(state.fleets[0].formationId).toBe('oujin')
    expect(state.fleets[1].formationId).toBe('oujin')
    expect(state.fleets[0].name).toBe('青軍')
    expect(state.fleets[1].name).toBe('赤軍')
    let blueMax = -Infinity
    let redMin = Infinity
    for (let i = 0; i < state.ships.count; i++) {
      const x = state.ships.x[i] ?? 0
      if (state.ships.side[i] === 0) blueMax = Math.max(blueMax, x)
      else redMin = Math.min(redMin, x)
    }
    expect(blueMax).toBeLessThan(redMin)
    expect(meanY(state, 0, 0)).toBeGreaterThan(meanY(state, 0, 4))
    expect(meanY(state, 1, 0)).toBeLessThan(meanY(state, 1, 4))
    for (let i = 0; i < state.ships.count; i++) {
      const heading = state.ships.heading[i] ?? 0
      const forward = state.ships.side[i] === 0 ? 1 : -1
      expect(Math.cos(heading) * forward).toBeGreaterThan(0.99)
    }
  })

  it('points 鶴翼 wings at the enemy and 鋒矢 at the enemy', () => {
    const state = createSim({ shipCount: 1000, formations: ['kakuyoku', 'hoshi'] })
    const blue = wingForward(state, 0)
    expect(blue.wingX).toBeGreaterThan(blue.centerX + 40)
    const red = arrowTip(state)
    expect(red.tipSpan).toBeLessThan(red.baseSpan * 0.7)
    expect(red.tipX).toBeLessThan(red.baseX)
  })

  it('refuses a formation change after the battle starts', () => {
    let state = createSim({ shipCount: 100 })
    state = dispatch(state, { type: 'start' })
    state = dispatch(state, { type: 'set-formation', side: 1, formationId: 'houen' })
    expect(state.fleets[1].formationId).toBe('oujin')
    expect(state.phase.kind).toBe('running')
  })

  it('keeps ship counts consistent and lets a stronger side win', () => {
    const state = run(25, 100, [28, 1])
    expect(state.alive[0] + state.lost[0]).toBe(50)
    expect(state.alive[1] + state.lost[1]).toBe(50)
    expect(state.lost[1]).toBeGreaterThan(state.lost[0])
    expect(state.alive[0]).toBeGreaterThan(state.alive[1])
    expect(state.phase.kind === 'finished' || state.alive[1] < 50).toBe(true)
  })

  it('pauses, resumes, and returns to setup', () => {
    let state = createSim({ shipCount: 100 })
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    expect(state.phase).toEqual({ kind: 'running', speed: 4 })
    state = dispatch(state, { type: 'tick', dt: 1 / 30 })
    const moved = state.time
    expect(moved).toBeGreaterThan(0)
    expect(moved).toBeCloseTo((1 / 30) * 4 * SIM_TIME_SCALE)
    state = dispatch(state, { type: 'pause' })
    state = dispatch(state, { type: 'tick', dt: 1 })
    expect(state.time).toBe(moved)
    expect(state.phase.kind).toBe('paused')
    state = dispatch(state, { type: 'resume' })
    expect(state.phase.kind).toBe('running')
    state = dispatch(state, { type: 'reset' })
    expect(state.phase).toEqual({ kind: 'setup', speed: 1 })
    expect(state.alive).toEqual([50, 50])
    expect(state.lost).toEqual([0, 0])
  })
})

describe('parse', () => {
  it('accepts only the ship counts, formations, and tactics on the controls', () => {
    expect(parseShipCount('100')).toBe(100)
    expect(parseShipCount('1000')).toBe(1000)
    expect(parseShipCount('10000')).toBe(10000)
    expect(parseShipCount('20000')).toBe(20000)
    expect(parseShipCount('500')).toBeNull()
    expect(parseFormationId('oujin')).toBe('oujin')
    expect(parseFormationId('kakuyoku')).toBe('kakuyoku')
    expect(parseFormationId('line')).toBeNull()
    expect(parseTacticId('focus')).toBe('focus')
    expect(parseTacticId('retreat')).toBeNull()
  })
})

function meanY(state: ReturnType<typeof createSim>, side: 0 | 1, slot: number): number {
  const ships = state.ships
  let sum = 0
  let n = 0
  const division = side * 5 + slot
  for (let i = 0; i < ships.count; i++) {
    if (ships.side[i] !== side || ships.division[i] !== division) continue
    sum += ships.y[i] ?? 0
    n += 1
  }
  return sum / n
}

function wingForward(state: ReturnType<typeof createSim>, side: 0 | 1) {
  const ships = state.ships
  const half = state.shipCount / 2
  const offset = side * half
  const abs: number[] = []
  for (let i = 0; i < half; i++) abs.push(Math.abs(ships.y[offset + i] ?? 0))
  abs.sort((a, b) => a - b)
  const low = abs[Math.floor(half * 0.2)] ?? 0
  const high = abs[Math.floor(half * 0.75)] ?? 0
  let wingX = 0
  let wingN = 0
  let centerX = 0
  let centerN = 0
  for (let i = 0; i < half; i++) {
    const y = Math.abs(ships.y[offset + i] ?? 0)
    const x = ships.x[offset + i] ?? 0
    if (y >= high) {
      wingX += x
      wingN += 1
    } else if (y <= low) {
      centerX += x
      centerN += 1
    }
  }
  return { wingX: wingX / wingN, centerX: centerX / centerN }
}

function arrowTip(state: ReturnType<typeof createSim>) {
  const ships = state.ships
  const half = state.shipCount / 2
  const xs: number[] = []
  for (let i = half; i < ships.count; i++) xs.push(ships.x[i] ?? 0)
  xs.sort((a, b) => a - b)
  const tipCut = xs[Math.floor(half * 0.12)] ?? 0
  const baseCut = xs[Math.floor(half * 0.88)] ?? 0
  let tipMin = Infinity
  let tipMax = -Infinity
  let baseMin = Infinity
  let baseMax = -Infinity
  let tipX = 0
  let tipN = 0
  let baseX = 0
  let baseN = 0
  for (let i = half; i < ships.count; i++) {
    const x = ships.x[i] ?? 0
    const y = ships.y[i] ?? 0
    if (x <= tipCut) {
      tipMin = Math.min(tipMin, y)
      tipMax = Math.max(tipMax, y)
      tipX += x
      tipN += 1
    } else if (x >= baseCut) {
      baseMin = Math.min(baseMin, y)
      baseMax = Math.max(baseMax, y)
      baseX += x
      baseN += 1
    }
  }
  return {
    tipSpan: tipMax - tipMin,
    baseSpan: baseMax - baseMin,
    tipX: tipX / tipN,
    baseX: baseX / baseN,
  }
}
