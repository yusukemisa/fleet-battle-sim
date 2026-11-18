import { describe, expect, it } from 'vitest'
import { battleSearch, parseBattleQuery } from './query.ts'

describe('battle query', () => {
  it('reads the round-7 link shape', () => {
    const query = parseBattleQuery(new URLSearchParams('blue=r7a&red=main&cmdBlue=猛将&cmdRed=智将&ships=1000&seed=3&form=oujin&speed=4'))
    expect(query.blue).toBe('r7a')
    expect(query.red).toBe('main')
    expect(query.cmdBlue).toBe('fierce')
    expect(query.cmdRed).toBe('cunning')
    expect(query.ships).toBe(1000)
    expect(query.seed).toBe(3)
    expect(query.formBlue).toBe('oujin')
    expect(query.formRed).toBe('oujin')
    expect(query.speed).toBe(4)
  })

  it('round-trips a non-default setup', () => {
    const search = battleSearch({
      blue: 'u8a',
      red: 'table',
      cmdBlue: 'guard',
      cmdRed: 'cunning',
      ships: 1000,
      seed: 7,
      formBlue: 'oujin',
      formRed: 'oujin',
      speed: 4,
      brainBlue: 'rule',
      brainRed: 'rule',
    })
    const query = parseBattleQuery(new URLSearchParams(search.slice(1)))
    expect(query.blue).toBe('u8a')
    expect(query.red).toBe('table')
    expect(query.cmdBlue).toBe('guard')
    expect(query.cmdRed).toBe('cunning')
    expect(query.seed).toBe(7)
    expect(query.speed).toBe(4)
    expect(search.includes('ships=')).toBe(false)
    expect(search.includes('brain')).toBe(false)
  })

  it('keeps a main-side commander on the rule brain when asked', () => {
    const query = parseBattleQuery(new URLSearchParams('red=main&cmdRed=猛将&brainRed=rule'))
    expect(query.cmdRed).toBe('fierce')
    expect(query.brainRed).toBe('rule')
    expect(query.brainBlue).toBeNull()
  })

  it('omits the opening hammer and writes the older movement', () => {
    const search = battleSearch({
      blue: 'r7b',
      red: 'main',
      cmdBlue: 'balanced',
      cmdRed: 'cunning',
      ships: 1000,
      seed: null,
      formBlue: 'oujin',
      formRed: 'oujin',
      speed: 1,
      brainBlue: 'ai',
      brainRed: 'rule',
    })
    expect(search.includes('blue=')).toBe(false)
    expect(search.includes('red=main')).toBe(true)
  })
})
