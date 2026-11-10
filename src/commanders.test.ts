import { describe, expect, it } from 'vitest'
import { chooseTactic, COMMANDERS, employClass, type BattleFacts, type DivisionFact } from './commanders.ts'
import { createSim, dispatch } from './sim.ts'

const quietEnemy: DivisionFact = { alive: 100, tacticId: 'charge', phase: 0, ax: 400, ay: 0, fx: -1, fy: 0 }

function facts(patch: Partial<BattleFacts> = {}): BattleFacts {
  return {
    ownAlive: 500,
    enemyAlive: 500,
    ownLost: 0,
    enemyLost: 0,
    enemyFormation: 'kakuyoku',
    ownX: -200,
    ownY: 0,
    ax: -200,
    ay: 0,
    fx: 1,
    fy: 0,
    slot: 2,
    enemy: [quietEnemy],
    enemyOnUs: 'front',
    usOnEnemy: 'front',
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

  it('puts fast divisions on the flank and battleships on the line', () => {
    expect(employClass(COMMANDERS.fierce, 'destroyer', 'charge', facts({ slot: 0 }))).toBe('rear')
    expect(employClass(COMMANDERS.fierce, 'cruiser', 'charge', facts({ slot: 1 }))).toBe('broadside')
    expect(employClass(COMMANDERS.fierce, 'battleship', 'flank', facts({ slot: 2 }))).toBe('breakthrough')
    expect(employClass(COMMANDERS.cunning, 'destroyer', 'charge', facts({ slot: 0 }))).toBe('rear')
    expect(employClass(COMMANDERS.cunning, 'cruiser', 'charge', facts({ slot: 1 }))).toBe('broadside')
    expect(employClass(COMMANDERS.cunning, 'battleship', 'rear', facts({ slot: 2 }))).toBe('pin')
    expect(employClass(COMMANDERS.guard, 'destroyer', 'hold', facts({ slot: 0 }))).toBe('flank')
    expect(employClass(COMMANDERS.guard, 'destroyer', 'hold', facts({ slot: 0, enemyOnUs: 'side' }))).toBe('broadside')
    expect(employClass(COMMANDERS.guard, 'battleship', 'rear', facts({ slot: 2 }))).toBe('hold')
    expect(employClass(COMMANDERS.balanced, 'destroyer', 'charge', facts({ slot: 0, usOnEnemy: 'side' }))).toBe('rear')
    expect(employClass(COMMANDERS.balanced, 'cruiser', 'charge', facts({ slot: 1 }))).toBe('flank')
    expect(employClass(COMMANDERS.balanced, 'battleship', 'encircle', facts({ slot: 2 }))).toBe('charge')
  })

  it('lets 智将 pin the center and hook the wings onto the side and rear', () => {
    expect(chooseTactic(COMMANDERS.cunning, facts({ slot: 2 }))).toBe('pin')
    expect(chooseTactic(COMMANDERS.cunning, facts({ slot: 1 }))).toBe('broadside')
    expect(chooseTactic(COMMANDERS.cunning, facts({ slot: 3 }))).toBe('broadside')
    expect(chooseTactic(COMMANDERS.cunning, facts({ slot: 0 }))).toBe('rear')
    expect(chooseTactic(COMMANDERS.cunning, facts({ slot: 4 }))).toBe('rear')
  })

  it('lets 智将 send an inner division onto an enemy that is facing away', () => {
    const turned: DivisionFact = { alive: 80, tacticId: 'charge', phase: 0, ax: 200, ay: 80, fx: 1, fy: 0 }
    expect(chooseTactic(COMMANDERS.cunning, facts({ slot: 1, ax: -180, ay: 80, enemy: [turned] }))).toBe('rear')
    expect(chooseTactic(COMMANDERS.cunning, facts({ slot: 0, ax: -180, ay: 160, enemy: [turned] }))).toBe('rear')
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
    const flanking: DivisionFact = { alive: 80, tacticId: 'encircle', phase: 0, ax: 0, ay: -240, fx: -1, fy: 0 }
    expect(chooseTactic(COMMANDERS.balanced, facts({ enemy: [flanking] }))).toBe('encircle')
  })

  it('values a flank or rear and protects its own', () => {
    expect(chooseTactic(COMMANDERS.fierce, facts({ usOnEnemy: 'rear', slot: 1 }))).toBe('breakthrough')
    expect(chooseTactic(COMMANDERS.cunning, facts({ usOnEnemy: 'side', slot: 1 }))).toBe('broadside')
    expect(chooseTactic(COMMANDERS.cunning, facts({ usOnEnemy: 'rear', slot: 0 }))).toBe('rear')
    expect(chooseTactic(COMMANDERS.guard, facts({ enemyOnUs: 'side' }))).toBe('focus')
    expect(chooseTactic(COMMANDERS.balanced, facts({ enemyOnUs: 'rear' }))).toBe('focus')
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
    let cunning = createSim({ shipCount: 100, commanders: ['cunning', 'manual'] })
    cunning = dispatch(cunning, { type: 'start' })
    cunning = dispatch(cunning, { type: 'tick', dt: 0.05 })
    expect(cunning.divisions[2]?.tacticId).toBe('pin')
    expect(cunning.divisions[0]?.tacticId).toBe('rear')
    expect(cunning.divisions[1]?.tacticId).toBe('broadside')
    expect(cunning.log).toContain('青軍 中軍: 釘付けに切替')
    expect(cunning.log).toContain('青軍 左翼: 背後襲撃に切替')
    expect(cunning.log).toContain('青軍 左衛: 側面攻撃に切替')
    state = dispatch(state, { type: 'set-commander', side: 0, commanderId: 'guard' })
    expect(state.fleets[0].commanderId).toBe('fierce')
  })
})
