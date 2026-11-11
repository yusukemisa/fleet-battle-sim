import { describe, expect, it } from 'vitest'
import { observe } from './observe.ts'
import { parseBrainDecision } from './orders.ts'
import { decidePolicy, loadPolicy, usePolicy } from './policy.ts'
import { ruleDecide } from './rule.ts'
import { createSim, dispatch } from '../sim.ts'
import type { SimState } from '../types.ts'

function fingerprint(state: SimState): string {
  return state.divisions
    .map((division) => `${division.tacticId}:${division.alive}:${division.ax.toFixed(2)}:${division.ay.toFixed(2)}`)
    .join('|')
}

function fight(brain: 'rule' | 'ai'): SimState {
  let state = createSim({ shipCount: 100, commanders: ['balanced', 'fierce'], formations: ['oujin', 'oujin'] })
  state.rng = 0x9e3779b1
  if (brain === 'ai') state = dispatch(state, { type: 'set-fleet-brain', fleet: 0, brain: 'ai' })
  state = dispatch(state, { type: 'set-speed', speed: 4 })
  state = dispatch(state, { type: 'start' })
  for (let step = 0; step < 40; step++) state = dispatch(state, { type: 'tick', dt: 0.05 })
  return state
}

describe('commander brain', () => {
  it('keeps the rule brain on the existing battle path', () => {
    const plain = fight('rule')
    let marked = createSim({ shipCount: 100, commanders: ['balanced', 'fierce'], formations: ['oujin', 'oujin'] })
    marked.rng = 0x9e3779b1
    marked = dispatch(marked, { type: 'set-fleet-brain', fleet: 0, brain: 'rule' })
    marked = dispatch(marked, { type: 'set-fleet-brain', fleet: 1, brain: 'rule' })
    marked = dispatch(marked, { type: 'set-speed', speed: 4 })
    marked = dispatch(marked, { type: 'start' })
    for (let step = 0; step < 40; step++) marked = dispatch(marked, { type: 'tick', dt: 0.05 })
    expect(fingerprint(marked)).toBe(fingerprint(plain))
    expect(plain.fleets[0]?.brain).toBe('rule')
  })

  it('turns the rule commanders into orders for every living division', () => {
    let state = createSim({ shipCount: 100, commanders: ['fierce', 'guard'] })
    state = dispatch(state, { type: 'start' })
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    const decision = ruleDecide(observe(state, 0))
    expect(decision.orders.length).toBeGreaterThan(0)
    for (const order of decision.orders) {
      expect(state.divisions[order.division]?.fleet).toBe(0)
    }
  })

  it('rejects an order aimed at a division the fleet does not own', () => {
    let state = createSim({ shipCount: 100, commanders: ['balanced', 'fierce'] })
    state = dispatch(state, { type: 'start' })
    const observation = observe(state, 0)
    const bad = parseBrainDecision(JSON.stringify({ note: 'x', orders: [{ division: 7, tacticId: 'charge' }] }), observation)
    expect(bad).toBeNull()
    const huge = parseBrainDecision(
      JSON.stringify({ note: '  far  ', orders: [{ division: 2, tacticId: 'focus', move: { x: 1e9, y: -1e9, heading: 9 } }] }),
      observation,
    )
    expect(huge?.orders[0]?.move).toEqual({ x: 20000, y: -20000, heading: expect.any(Number) })
    expect(huge?.note).toBe('far')
  })

  it('loads the committed weights and repeats the same orders', async () => {
    expect(loadPolicy({ input: 1 })).toBeNull()
    const policy = loadPolicy((await import('./weights.json')).default)
    expect(policy).not.toBeNull()
    let state = createSim({ shipCount: 100, commanders: ['balanced', 'cunning'], formations: ['kakuyoku', 'oujin'] })
    state = dispatch(state, { type: 'start' })
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    const observation = observe(state, 0)
    usePolicy(policy)
    const first = decidePolicy(observation)
    const second = decidePolicy(observation)
    usePolicy(null)
    expect(first).toEqual(second)
    expect(first?.orders.length).toBeGreaterThan(0)
  })

  it('falls back to the rule commander when the weights are unusable', () => {
    usePolicy({ input: 1, hidden: 1, output: 1, w1: [0], b1: [0], w2: [0], b2: [0] })
    let state = createSim({ shipCount: 100, commanders: ['balanced', 'fierce'] })
    state = dispatch(state, { type: 'set-fleet-brain', fleet: 0, brain: 'ai' })
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    expect(state.fleets[0]?.ai.status).toBe('fallback')
    expect(state.fleets[0]?.ai.fallbacks).toBe(1)
    usePolicy(null)
  })

  it('plays two identical games with the local policy', () => {
    const once = fingerprint(fight('ai'))
    const twice = fingerprint(fight('ai'))
    expect(twice).toBe(once)
  })
})
