import { describe, expect, it } from 'vitest'
import { observe } from './observe.ts'
import { parseBrainDecision } from './orders.ts'
import { scoreBattle, scoreSuite, type BattleReport } from './fitness.ts'
import { decidePolicy, loadPolicy, pack, paramCount, unpack, useFleetPolicy, clearFleetPolicies, usePolicy, applyInitialBias } from './policy.ts'
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
  it('keeps 智将 and 常勝 on the rule path', () => {
    let plain = createSim({ shipCount: 100, commanders: ['balanced', 'cunning'], formations: ['oujin', 'oujin'] })
    plain.rng = 0x9e3779b1
    plain = dispatch(plain, { type: 'set-speed', speed: 4 })
    plain = dispatch(plain, { type: 'start' })
    let marked = createSim({ shipCount: 100, commanders: ['balanced', 'cunning'], formations: ['oujin', 'oujin'], brains: ['rule', 'rule'] })
    marked.rng = 0x9e3779b1
    marked = dispatch(marked, { type: 'set-speed', speed: 4 })
    marked = dispatch(marked, { type: 'start' })
    for (let step = 0; step < 40; step++) {
      plain = dispatch(plain, { type: 'tick', dt: 0.05 })
      marked = dispatch(marked, { type: 'tick', dt: 0.05 })
    }
    expect(fingerprint(marked)).toBe(fingerprint(plain))
    expect(plain.fleets[0]?.brain).toBe('rule')
    expect(plain.fleets[1]?.brain).toBe('rule')
  })

  it('starts 猛将 and 守将 on AI, and returns to that default when the commander changes', () => {
    let state = createSim({ shipCount: 100, commanders: ['fierce', 'guard'] })
    expect(state.fleets[0]?.brain).toBe('ai')
    expect(state.fleets[1]?.brain).toBe('ai')
    state = dispatch(state, { type: 'set-fleet-brain', fleet: 0, brain: 'rule' })
    state = dispatch(state, { type: 'set-ship-count', count: 1000 })
    expect(state.fleets[0]?.commanderId).toBe('fierce')
    expect(state.fleets[0]?.brain).toBe('rule')
    state = dispatch(state, { type: 'set-commander', side: 0, commanderId: 'cunning' })
    expect(state.fleets[0]?.brain).toBe('rule')
    state = dispatch(state, { type: 'set-fleet-brain', fleet: 0, brain: 'ai' })
    state = dispatch(state, { type: 'set-commander', side: 0, commanderId: 'balanced' })
    expect(state.fleets[0]?.brain).toBe('rule')
    state = dispatch(state, { type: 'set-fleet-commander', fleet: 1, commanderId: 'fierce' })
    expect(state.fleets[1]?.brain).toBe('ai')
    state = dispatch(state, { type: 'set-fleet-brain', fleet: 1, brain: 'rule' })
    state = dispatch(state, { type: 'set-fleet-count', side: 1, count: 2 })
    const added = state.fleets.find((fleet) => fleet.side === 1 && fleet.ordinal === 1)
    expect(added?.commanderId).toBe('fierce')
    expect(added?.brain).toBe('ai')
    expect(state.fleets[1]?.brain).toBe('rule')
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
    const policy = loadPolicy((await import('./weights/balanced.json')).default)
    expect(loadPolicy((await import('./weights/fierce.json')).default)).not.toBeNull()
    expect(loadPolicy((await import('./weights/cunning.json')).default)).not.toBeNull()
    expect(loadPolicy((await import('./weights/guard.json')).default)).not.toBeNull()
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

  it('gives each fleet the weights installed on it', () => {
    const hold = unpack(new Float64Array(paramCount()))
    const charge = unpack(new Float64Array(paramCount()))
    for (let slot = 0; slot < 5; slot++) charge.b2[slot * 8 + 1] = 5
    useFleetPolicy(0, hold)
    useFleetPolicy(1, charge)
    let state = createSim({ shipCount: 100, commanders: ['fierce', 'guard'] })
    state = dispatch(state, { type: 'set-fleet-brain', fleet: 0, brain: 'ai' })
    state = dispatch(state, { type: 'set-fleet-brain', fleet: 1, brain: 'ai' })
    state = dispatch(state, { type: 'start' })
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    clearFleetPolicies()
    expect(state.fleets[0]?.orders?.every((order) => order.tacticId === 'hold')).toBe(true)
    expect(state.fleets[1]?.orders?.every((order) => order.tacticId === 'charge')).toBe(true)
  })

  it('falls back when that commander has no weights', () => {
    let state = createSim({ shipCount: 100, commanders: ['manual', 'fierce'] })
    state = dispatch(state, { type: 'set-fleet-brain', fleet: 0, brain: 'ai' })
    state = dispatch(state, { type: 'start' })
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    expect(state.fleets[0]?.ai.status).toBe('fallback')
    expect(state.fleets[0]?.ai.note).toContain('手動')
  })

  it('scores a loss-tolerant assault above a quiet loss, and pulls 常勝 toward its worst games', () => {
    const empty: BattleReport = {
      won: false,
      alive: 0.2,
      contactTime: 40,
      contact: 0,
      dealt: 0,
      taken: 0,
      exchange: 1,
      flank: 0,
      exposure: 1,
      hitsDealt: 0,
      hitsTaken: 0,
      destroyerDealt: 0,
      assault: 0,
      cohesion: 1,
      time: 40,
    }
    const assault: BattleReport = { ...empty, contact: 1, contactTime: 4, dealt: 80, taken: 20, assault: 1 }
    expect(scoreBattle('fierce', assault)).toBeGreaterThan(scoreBattle('fierce', empty))
    const flat = pack(unpack(new Float64Array(paramCount())))
    applyInitialBias(flat, 'fierce')
    expect(flat[flat.length - 39]).toBeGreaterThan(0)
    expect(scoreSuite('balanced', [1, 1, 1, 0])).toBeLessThan(0.75)
    expect(scoreSuite('guard', [1, 1, 1, 0])).toBeCloseTo(0.75)
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
