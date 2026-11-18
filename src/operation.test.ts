import { afterEach, describe, expect, it } from 'vitest'
import { createSim, dispatch } from './sim.ts'
import { parseTacticVariant, resetTacticVariants, setTacticVariant, tacticVariants, wideGrid } from './operation.ts'

afterEach(() => {
  resetTacticVariants()
})

describe('tactic variants', () => {
  it('parses the round-7 ids and the older aliases', () => {
    expect(parseTacticVariant('r7a')).toBe('r7a')
    expect(parseTacticVariant('steady')).toBe('r7a')
    expect(parseTacticVariant('r7b')).toBe('r7b')
    expect(parseTacticVariant('rank')).toBe('r7b')
    expect(parseTacticVariant('r7c')).toBe('r7c')
    expect(parseTacticVariant('table')).toBe('table')
    expect(parseTacticVariant('r5')).toBe('table')
    expect(parseTacticVariant('main')).toBe('main')
    expect(parseTacticVariant('nope')).toBeNull()
  })

  it('opens on the held hammer', () => {
    resetTacticVariants()
    expect(tacticVariants()).toEqual(['r7b', 'r7b'])
  })

  it('parses the round-8 unit ids', () => {
    expect(parseTacticVariant('u8a')).toBe('u8a')
    expect(parseTacticVariant('u8d')).toBe('u8d')
    expect(parseTacticVariant('u9a')).toBe('u9a')
    expect(parseTacticVariant('u9b')).toBe('u9b')
    expect(parseTacticVariant('u9c')).toBe('u9c')
    expect(parseTacticVariant('u10a')).toBe('u10a')
    expect(parseTacticVariant('u10b')).toBe('u10b')
    expect(parseTacticVariant('u10c')).toBe('u10c')
  })

  it('does not mark the anvil or the hammer', () => {
    setTacticVariant(0, 'r7b')
    let state = createSim({ shipCount: 1000, commanders: ['balanced', 'cunning'], brains: ['rule', 'rule'] })
    state.rng = 3
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    expect(state.divisions.some((division) => division.side === 0 && division.focus)).toBe(true)
  })

  it('makes a unit one rank and a division a wide front', () => {
    expect(wideGrid(10)).toEqual({ across: 10, depth: 1 })
    const division = wideGrid(100)
    expect(division.across / division.depth).toBeGreaterThanOrEqual(4)
  })

  it('opens in a wide shallow front without walking there', () => {
    setTacticVariant(0, 'u8a')
    let state = createSim({ shipCount: 1000, commanders: ['balanced', 'cunning'], brains: ['rule', 'rule'] })
    state.rng = 3
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    const division = state.divisions.find((item) => item.side === 0 && item.slot === 2)
    if (!division) throw new Error('missing division')
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    let off = 0
    let n = 0
    for (let i = 0; i < state.ships.count; i++) {
      if (state.ships.alive[i] !== 1 || state.ships.division[i] !== state.divisions.indexOf(division)) continue
      const sx = state.ships.slotX[i] ?? 0
      const sy = state.ships.slotY[i] ?? 0
      minX = Math.min(minX, sx)
      maxX = Math.max(maxX, sx)
      minY = Math.min(minY, sy)
      maxY = Math.max(maxY, sy)
      const tx = division.ax + division.rx * sx + division.fx * sy
      const ty = division.ay + division.ry * sx + division.fy * sy
      off = Math.max(off, Math.hypot((state.ships.x[i] ?? 0) - tx, (state.ships.y[i] ?? 0) - ty))
      n += 1
    }
    expect(n).toBeGreaterThan(10)
    expect(maxX - minX).toBeGreaterThan((maxY - minY) * 3)
    expect(off).toBeLessThan(1)
  })

  it('does not march ships out of the opening line', () => {
    for (const variant of ['u9a', 'u9c'] as const) {
      setTacticVariant(0, variant)
      let state = createSim({ shipCount: 1000, commanders: ['balanced', 'cunning'], brains: ['rule', 'rule'] })
      state.rng = 3
      state = dispatch(state, { type: 'set-speed', speed: 4 })
      state = dispatch(state, { type: 'start' })
      state = dispatch(state, { type: 'tick', dt: 0.05 })
      let off = 0
      for (let i = 0; i < state.ships.count; i++) {
        if (state.ships.alive[i] !== 1 || state.ships.side[i] !== 0) continue
        const division = state.divisions[state.ships.division[i] ?? 0]
        if (!division) continue
        const sx = state.ships.slotX[i] ?? 0
        const sy = state.ships.slotY[i] ?? 0
        const tx = division.ax + division.rx * sx + division.fx * sy
        const ty = division.ay + division.ry * sx + division.fy * sy
        off = Math.max(off, Math.hypot((state.ships.x[i] ?? 0) - tx, (state.ships.y[i] ?? 0) - ty))
      }
      expect(off).toBeLessThan(1)
    }
  })

  it('keeps a battleship unit clear of the next hull and the next rank', () => {
    setTacticVariant(0, 'u10b')
    const state = createSim({ shipCount: 1000, commanders: ['balanced', 'cunning'], brains: ['rule', 'rule'] })
    const division = state.divisions.findIndex((item) => item.side === 0 && item.slot === 2)
    const seats: { x: number; y: number }[] = []
    for (let i = 0; i < state.ships.count; i++) {
      if (state.ships.alive[i] !== 1 || state.ships.division[i] !== division) continue
      seats.push({ x: state.ships.slotX[i] ?? 0, y: state.ships.slotY[i] ?? 0 })
    }
    seats.sort((a, b) => b.y - a.y || a.x - b.x)
    const front = seats.filter((seat) => Math.abs(seat.y - (seats[0]?.y ?? 0)) < 1)
    expect(front.length).toBe(10)
    for (let i = 1; i < front.length; i++) {
      const prev = front[i - 1]
      const seat = front[i]
      if (!prev || !seat) continue
      expect(seat.x - prev.x).toBeGreaterThanOrEqual(14.2 + 10 - 0.01)
    }
    const next = seats.find((seat) => (seats[0]?.y ?? 0) - seat.y > 1)
    expect(next).toBeTruthy()
    expect((seats[0]?.y ?? 0) - (next?.y ?? 0)).toBeGreaterThan(7.1 * 5.5)
  })
})
