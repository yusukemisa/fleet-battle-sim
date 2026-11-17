import { afterEach, describe, expect, it } from 'vitest'
import { createSim, dispatch } from './sim.ts'
import { operationMarks, parseTacticVariant, resetTacticVariants, setTacticVariant } from './operation.ts'

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

  it('leaves a battle unmarked until a side opts in', () => {
    let state = createSim({ shipCount: 1000, commanders: ['balanced', 'cunning'], brains: ['rule', 'rule'] })
    state.rng = 3
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    for (let i = 0; i < 20; i++) state = dispatch(state, { type: 'tick', dt: 0.05 })
    expect(operationMarks(state)).toBeNull()
  })

  it('labels the anvil and hammer once the fixed table is on', () => {
    setTacticVariant(0, 'table')
    let state = createSim({ shipCount: 1000, commanders: ['fierce', 'cunning'], brains: ['rule', 'rule'] })
    state.rng = 3
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    const plan = operationMarks(state)
    expect(plan).not.toBeNull()
    const words = plan?.marks.map((mark) => mark.text) ?? []
    expect(words).toContain('金床')
    expect(words).toContain('槌')
    expect(plan?.marks.every((mark) => mark.side === 0)).toBe(true)
  })
})
