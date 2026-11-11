import { describe, expect, it } from 'vitest'
import { decideTransformer, probeLogits, transformerLogits, useDtWeights, type DtWeights } from './dt.ts'
import { createSim, dispatch } from '../sim.ts'
import { observe } from './observe.ts'

describe('decision transformer', () => {
  it('matches the trainer on an empty history', async () => {
    const weights = (await import('./weights/dt.json')).default as DtWeights
    const logits = probeLogits(weights)
    expect(logits).not.toBeNull()
    const probe = weights.probe ?? []
    expect(probe.length).toBe(40)
    for (let i = 0; i < probe.length; i++) {
      expect(logits?.[i] ?? 0).toBeCloseTo(probe[i] ?? 0, 2)
    }
    const past = transformerLogits(new Float64Array(99), [{ obs: new Float64Array(99), act: [0, -1, -1, -1, -1] }], weights.target, weights)
    const expected = weights.probePast ?? []
    expect(expected.length).toBe(40)
    for (let i = 0; i < expected.length; i++) {
      expect(past[i] ?? 0).toBeCloseTo(expected[i] ?? 0, 2)
    }
  })

  it('repeats the same orders and falls back when the weights are unusable', () => {
    let state = createSim({ shipCount: 100, commanders: ['cunning', 'guard'] })
    state = dispatch(state, { type: 'set-fleet-brain', fleet: 0, brain: 'dt' })
    state = dispatch(state, { type: 'start' })
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    const once = state.fleets[0]?.orders
    let again = createSim({ shipCount: 100, commanders: ['cunning', 'guard'] })
    again.rng = state.rng
    again = dispatch(again, { type: 'set-fleet-brain', fleet: 0, brain: 'dt' })
    again = dispatch(again, { type: 'start' })
    again = dispatch(again, { type: 'tick', dt: 0.05 })
    expect(again.fleets[0]?.orders).toEqual(once)
    expect(once?.length).toBeGreaterThan(0)
    useDtWeights({ dModel: 1 } as DtWeights)
    const observation = observe(state, 0)
    expect(decideTransformer(state.fleets[0] ?? {}, observation)).toBeNull()
    useDtWeights(null)
  })

  it('keeps 智将 on the rules until someone picks DT', () => {
    const state = createSim({ shipCount: 100, commanders: ['cunning', 'balanced'] })
    expect(state.fleets[0]?.brain).toBe('rule')
    expect(state.fleets[1]?.brain).toBe('ai')
  })
})
