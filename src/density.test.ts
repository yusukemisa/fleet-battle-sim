import { describe, expect, it } from 'vitest'
import { createSim, dispatch } from './sim.ts'
import { chooseShape } from './density.ts'
import { scoreObjective, type BattleReport } from './brain/fitness.ts'

describe('firepower density', () => {
  it('picks a U for a wider fleet and a spindle for the side being enveloped', () => {
    expect(chooseShape('balanced', true, false, false)).toBe('pincer')
    expect(chooseShape('cunning', true, false, true)).toBe('pincer')
    expect(chooseShape('balanced', false, false, false)).toBe('spindle')
    expect(chooseShape('cunning', true, true, false)).toBe('spindle')
    expect(chooseShape('fierce', true, false, false)).toBe('spindle')
    expect(chooseShape('guard', true, false, false)).toBe('pincer')
    expect(chooseShape('guard', false, true, false)).toBe('spindle')
    expect(chooseShape('guard', false, false, true)).toBe('contract')
  })

  it('closes a wide crescent and stacks the compact side without ramming', () => {
    let state = createSim({
      shipCount: 1000,
      formations: ['engetsu', 'kakuyoku'],
      commanders: ['balanced', 'cunning'],
      brains: ['rule', 'rule'],
    })
    const blueOpen = wingSpan(state, 0)
    const redOpen = wingSpan(state, 1)
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    let firstKill = -1
    while (state.phase.kind === 'running' && state.time < 24) {
      state = dispatch(state, { type: 'tick', dt: 0.05 })
      const losses = (state.lost[0] ?? 0) + (state.lost[1] ?? 0)
      if (firstKill < 0 && losses > 0) firstKill = state.time
    }
    const losses = (state.lost[0] ?? 0) + (state.lost[1] ?? 0)
    const crashed = (state.collisionDeaths[0] ?? 0) + (state.collisionDeaths[1] ?? 0)
    const blueClose = wingSpan(state, 0)
    const redClose = wingSpan(state, 1)
    expect(state.tally.shots).toBeGreaterThan(0)
    expect(losses === 0 ? 0 : crashed / losses).toBeLessThan(0.2)
    expect(blueClose).toBeLessThan(blueOpen * 0.45)
    expect(blueClose).toBeGreaterThan(300)
    expect(redClose).toBeLessThan(redOpen * 0.75)
    expect(firstKill === -1 || firstKill < 24).toBe(true)
  })
})

describe('objective ablation', () => {
  const base: BattleReport = {
    won: false,
    alive: 0.8,
    contactTime: 20,
    contact: 0.5,
    dealt: 0,
    taken: 0,
    exchange: 1,
    flank: 0,
    exposure: 0,
    hitsDealt: 0,
    hitsTaken: 0,
    destroyerDealt: 0,
    assault: 0,
    cohesion: 1,
    spacing: 1,
    time: 40,
    kills: 0,
    losses: 0,
    bearing: 0,
    encircle: 0,
    breakthrough: 0,
    flagThreat: 0,
  }

  it('ranks a pincer setup above raw damage only when the positional term is on', () => {
    const damage: BattleReport = { ...base, dealt: 900, taken: 200, kills: 12, losses: 4 }
    const setup: BattleReport = { ...base, dealt: 40, kills: 1, bearing: 0.8, encircle: 0.75, breakthrough: 1, flank: 0.6, flagThreat: 1 }
    const ratesDamage = scoreObjective('balanced', damage, 'rates')
    const ratesSetup = scoreObjective('balanced', setup, 'rates')
    const fullDamage = scoreObjective('balanced', damage, 'full')
    const fullSetup = scoreObjective('balanced', setup, 'full')
    expect(ratesDamage).toBeGreaterThan(ratesSetup)
    expect(fullSetup).toBeGreaterThan(fullDamage)
    expect(fullSetup).toBeGreaterThan(ratesSetup)
  })
})

function wingSpan(state: ReturnType<typeof createSim>, side: 0 | 1): number {
  const wings = state.divisions.filter((div) => div.side === side && (div.slot === 0 || div.slot === 4) && div.alive > 0)
  const a = wings[0]
  const b = wings[1]
  if (!a || !b) return 0
  return Math.hypot(a.ax - b.ax, a.ay - b.ay)
}
