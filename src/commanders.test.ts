import { describe, expect, it } from 'vitest'
import { chooseTactic, COMMANDERS, type BattleFacts, type DivisionFact } from './commanders.ts'
import { createSim, dispatch } from './sim.ts'

const quietEnemy: DivisionFact = { alive: 100, tacticId: 'charge', phase: 0, ax: 400, ay: 0 }

function facts(patch: Partial<BattleFacts> = {}): BattleFacts {
  return {
    ownAlive: 500,
    enemyAlive: 500,
    ownLost: 0,
    enemyLost: 0,
    enemyFormation: 'kakuyoku',
    ownX: -200,
    ownY: 0,
    slot: 2,
    enemy: [quietEnemy],
    ...patch,
  }
}

describe('commanders', () => {
  it('lets 猛将 break the center and charge from the wing', () => {
    expect(chooseTactic(COMMANDERS.fierce, facts({ slot: 2 }))).toBe('breakthrough')
    expect(chooseTactic(COMMANDERS.fierce, facts({ slot: 0 }))).toBe('charge')
  })

  it('lets 猛将 press a breakthrough when ahead', () => {
    expect(chooseTactic(COMMANDERS.fierce, facts({ slot: 0, ownAlive: 600, enemyAlive: 400 }))).toBe(
      'breakthrough',
    )
  })

  it('lets 智将 encircle a flanking enemy and slip past an arrowhead', () => {
    const flanking: DivisionFact = { alive: 80, tacticId: 'flank', phase: 0, ax: 0, ay: 260 }
    expect(chooseTactic(COMMANDERS.cunning, facts({ enemy: [flanking] }))).toBe('encircle')
    expect(chooseTactic(COMMANDERS.cunning, facts({ enemyFormation: 'hoshi', slot: 2 }))).toBe('flank')
  })

  it('lets 守将 hold, then counterattack after the enemy is worn down', () => {
    expect(chooseTactic(COMMANDERS.guard, facts())).toBe('hold')
    expect(chooseTactic(COMMANDERS.guard, facts({ ownAlive: 420, enemyAlive: 300, enemyLost: 200 }))).toBe(
      'charge',
    )
  })

  it('lets 常勝 attack when ahead, hold when behind, and encircle a flank', () => {
    expect(chooseTactic(COMMANDERS.balanced, facts({ ownAlive: 650, enemyAlive: 400 }))).toBe('breakthrough')
    expect(chooseTactic(COMMANDERS.balanced, facts({ ownAlive: 300, enemyAlive: 500 }))).toBe('hold')
    const flanking: DivisionFact = { alive: 80, tacticId: 'encircle', phase: 0, ax: 0, ay: -240 }
    expect(chooseTactic(COMMANDERS.balanced, facts({ enemy: [flanking] }))).toBe('encircle')
  })

  it('leaves tactics alone for 手動', () => {
    expect(chooseTactic(COMMANDERS.manual, facts())).toBeNull()
  })
})

describe('orders during battle', () => {
  it('accepts a division order and a side order after the start', () => {
    let state = createSim({ shipCount: 100, commanders: ['manual', 'manual'] })
    state = dispatch(state, { type: 'start' })
    state = dispatch(state, { type: 'set-tactic', division: 0, tacticId: 'encircle' })
    expect(state.divisions[0]?.tacticId).toBe('encircle')
    state = dispatch(state, { type: 'set-side-tactic', side: 1, tacticId: 'hold' })
    for (let index = 5; index < 10; index++) expect(state.divisions[index]?.tacticId).toBe('hold')
    state = dispatch(state, { type: 'tick', dt: 0.2 })
    expect(state.divisions[0]?.tacticId).toBe('encircle')
  })

  it('switches the center when 猛将 takes command and records the change', () => {
    let state = createSim({ shipCount: 100, commanders: ['fierce', 'manual'] })
    expect(state.fleets[0].commanderId).toBe('fierce')
    expect(state.fleets[1].commanderId).toBe('manual')
    state = dispatch(state, { type: 'start' })
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    expect(state.divisions[2]?.tacticId).toBe('breakthrough')
    expect(state.log.some((line) => line === '青軍 中軍: 中央突破に切替')).toBe(true)
    state = dispatch(state, { type: 'set-commander', side: 0, commanderId: 'guard' })
    expect(state.fleets[0].commanderId).toBe('fierce')
  })
})
