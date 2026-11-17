import { afterEach, describe, expect, it } from 'vitest'
import { createSim, dispatch } from './sim.ts'
import { parseTacticVariant, resetTacticVariants, setTacticVariant, tacticVariants } from './operation.ts'

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

  it('seats a division into lines of ten', () => {
    setTacticVariant(0, 'u8a')
    let state = createSim({ shipCount: 1000, commanders: ['balanced', 'cunning'], brains: ['rule', 'rule'] })
    state.rng = 3
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    const division = state.divisions.findIndex((item) => item.side === 0 && item.slot === 2)
    const slots: number[] = []
    for (let i = 0; i < state.ships.count; i++) {
      if (state.ships.alive[i] !== 1 || state.ships.division[i] !== division) continue
      slots.push(state.ships.slotX[i] ?? 0)
    }
    slots.sort((a, b) => a - b)
    const gaps = new Set<number>()
    for (let i = 1; i < slots.length; i++) {
      const gap = Math.round((slots[i] ?? 0) - (slots[i - 1] ?? 0))
      if (gap > 0 && gap < 80) gaps.add(gap)
    }
    expect(gaps.has(36)).toBe(true)
  })
})
