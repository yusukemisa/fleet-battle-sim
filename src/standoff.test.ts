import { describe, expect, it } from 'vitest'
import { createSim, dispatch } from './sim.ts'

describe('gunnery standoff', () => {
  it('backs a large battleship block away when the enemy front is inside gun range', () => {
    let state = createSim({ shipCount: 1000, commanders: ['manual', 'manual'], brains: ['rule', 'rule'] })
    const own = state.divisions[2]
    const enemy = state.divisions[7]
    if (!own || !enemy) throw new Error('divisions')
    own.roster = 100
    enemy.roster = 100
    own.tacticId = 'charge'
    enemy.tacticId = 'charge'
    own.ax = 0
    own.ay = 0
    enemy.ax = 200
    enemy.ay = 0
    const ships = state.ships
    let moved = 0
    for (let i = 0; i < ships.count && moved < 12; i++) {
      if (ships.division[i] !== 2 || ships.alive[i] !== 1) continue
      ships.x[i] = 40
      ships.y[i] = (moved - 6) * 30
      ships.vx[i] = 20
      moved += 1
    }
    moved = 0
    for (let i = 0; i < ships.count && moved < 12; i++) {
      if (ships.division[i] !== 7 || ships.alive[i] !== 1) continue
      ships.x[i] = 160
      ships.y[i] = (moved - 6) * 30
      ships.vx[i] = -20
      moved += 1
    }
    const start = Math.hypot(own.ax - enemy.ax, own.ay - enemy.ay)
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    for (let step = 0; step < 30; step++) state = dispatch(state, { type: 'tick', dt: 0.05 })
    const gap = Math.hypot((state.divisions[2]?.ax ?? 0) - (state.divisions[7]?.ax ?? 0), (state.divisions[2]?.ay ?? 0) - (state.divisions[7]?.ay ?? 0))
    expect(gap).toBeGreaterThan(start + 80)
  })
})
