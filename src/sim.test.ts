import { describe, expect, it } from 'vitest'
import { SIM_TIME_SCALE } from './balance.ts'
import { INPUT_SIZE, featurize } from './brain/features.ts'
import { observe } from './brain/observe.ts'
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

describe('visibility', () => {
  it('shows every distant enemy division to the policy features at its true position', () => {
    const state = createSim({ shipCount: 100, commanders: ['balanced', 'cunning'], brains: ['rule', 'rule'] })
    pushApart(state, 20000)
    const observation = observe(state, 0)
    const features = featurize(observation)
    expect(features.length).toBe(INPUT_SIZE)
    for (let slot = 0; slot < 5; slot++) {
      const enemy = observation.divisions.find((division) => division.fleet === observation.enemy.index && division.slot === slot)
      expect(enemy).toBeTruthy()
      expect((enemy?.x ?? 0) - observation.own.x).toBeGreaterThan(15000)
      const at = 5 * 11 + slot * 11
      expect(features[at] ?? 0).toBeGreaterThan(0)
      expect(features[at + 2] ?? 0).toBeCloseTo(((enemy?.x ?? 0) - observation.own.x) / 1500, 1)
    }
    expect(features[INPUT_SIZE - 3] ?? 0).toBeGreaterThan(8)
  })

  it('aims the legacy guns at an enemy beyond the old sensor distance', () => {
    let state = createSim({
      shipCount: 100,
      commanders: ['manual', 'manual'],
      brains: ['rule', 'rule'],
      gunnery: 'legacy',
    })
    pushApart(state, 8000)
    state = dispatch(state, { type: 'start' })
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    let aimed = 0
    const ships = state.ships
    for (let i = 0; i < ships.count; i++) {
      const target = ships.target[i] ?? -1
      if (target < 0 || ships.alive[target] !== 1 || ships.side[target] === ships.side[i]) continue
      const dist = Math.hypot((ships.x[target] ?? 0) - (ships.x[i] ?? 0), (ships.y[target] ?? 0) - (ships.y[i] ?? 0))
      // 6400 was the removed sensor range. A lock past it is the true hull.
      if (dist > 6400) aimed += 1
    }
    expect(aimed).toBeGreaterThan(0)
  })

  it('closes on the true position instead of fanning out to search', () => {
    let state = createSim({ shipCount: 100, commanders: ['balanced', 'balanced'], brains: ['rule', 'rule'] })
    pushApart(state, 20000)
    const before = Math.hypot(state.centroidX[0] - state.centroidX[1], state.centroidY[0] - state.centroidY[1])
    const spreadBefore = lateralSpread(state, 0)
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    while (state.phase.kind === 'running' && state.time < 12) {
      state = dispatch(state, { type: 'tick', dt: 0.05 })
    }
    const after = Math.hypot(state.centroidX[0] - state.centroidX[1], state.centroidY[0] - state.centroidY[1])
    expect(after).toBeLessThan(before - 500)
    expect(lateralSpread(state, 0)).toBeLessThan(spreadBefore + 800)
    expect(state.collisionDeaths[0] + state.collisionDeaths[1]).toBe(0)
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

function pushApart(state: ReturnType<typeof createSim>, gap: number): void {
  const ships = state.ships
  let max0 = -Infinity
  let min1 = Infinity
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] !== 1) continue
    const x = ships.x[i] ?? 0
    if (ships.side[i] === 1) min1 = Math.min(min1, x)
    else max0 = Math.max(max0, x)
  }
  const extra = gap - (min1 - max0)
  if (!(extra > 0)) return
  const shift = extra / 2
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] !== 1) continue
    ships.x[i] = (ships.x[i] ?? 0) + (ships.side[i] === 1 ? shift : -shift)
  }
  for (const division of state.divisions) division.ax += division.side === 1 ? shift : -shift
  for (const fleet of state.fleets) {
    const sign = fleet.side === 1 ? 1 : -1
    fleet.centerX += sign * shift
    fleet.meanX += sign * shift
  }
  state.centroidX[0] -= shift
  state.centroidX[1] += shift
}

function lateralSpread(state: ReturnType<typeof createSim>, side: 0 | 1): number {
  let minY = Infinity
  let maxY = -Infinity
  for (const division of state.divisions) {
    if (division.side !== side || division.alive === 0) continue
    minY = Math.min(minY, division.ay)
    maxY = Math.max(maxY, division.ay)
  }
  return maxY - minY
}

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
