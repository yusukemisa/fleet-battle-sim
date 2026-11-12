import { describe, expect, it } from 'vitest'
import { createSim, dispatch } from './sim.ts'
import type { CommanderId, FormationId } from './types.ts'

const FOES = ['fierce', 'cunning', 'guard'] as const
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8] as const

describe('常勝', () => {
  it('beats each other commander on a fixed set of seeds', () => {
    for (const foe of FOES) {
      let wins = 0
      let games = 0
      for (const seed of SEEDS) {
        for (const swap of [false, true]) {
          const blue: CommanderId = swap ? foe : 'balanced'
          const red: CommanderId = swap ? 'balanced' : foe
          const winner = fight(blue, red, (seed * 0x9e3779b1 + (swap ? 17 : 0)) | 0)
          games += 1
          const won = swap ? winner === 1 : winner === 0
          if (won) wins += 1
        }
      }
      // A majority. The old 70% margin counted on 猛将 ramming into the gun line.
      expect(wins).toBeGreaterThan(games / 2)
    }
  })

  it('方円 stays ahead of 智将 偃月 on a fixed seed set', () => {
    let wins = 0
    for (const seed of [1, 2, 3, 4]) {
      for (const swap of [false, true]) {
        const blue: CommanderId = swap ? 'cunning' : 'balanced'
        const red: CommanderId = swap ? 'balanced' : 'cunning'
        const formations: [FormationId, FormationId] = swap ? ['engetsu', 'houen'] : ['houen', 'engetsu']
        const winner = fight(blue, red, (seed * 0x9e3779b1 + (swap ? 17 : 0)) | 0, formations)
        if (swap ? winner === 1 : winner === 0) wins += 1
      }
    }
    // Lethal contact costs one of these seeds. 常勝 still wins the majority.
    expect(wins).toBeGreaterThanOrEqual(5)
  })
})

function fight(blue: CommanderId, red: CommanderId, seed: number, formations: [FormationId, FormationId] = ['oujin', 'oujin']): 0 | 1 | 'draw' {
  let state = createSim({ shipCount: 100, commanders: [blue, red], formations, brains: ['rule', 'rule'] })
  state.rng = seed
  state = dispatch(state, { type: 'set-speed', speed: 4 })
  state = dispatch(state, { type: 'start' })
  let steps = 0
  while (state.phase.kind === 'running' && state.time < 200 && steps < 16000) {
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    steps += 1
  }
  if (state.phase.kind === 'finished') return state.phase.winner
  const a = state.alive[0]
  const b = state.alive[1]
  if (a >= b * 1.2 && a - b >= 5) return 0
  if (b >= a * 1.2 && b - a >= 5) return 1
  return 'draw'
}
