import { describe, expect, it } from 'vitest'
import { createSim, dispatch } from './sim.ts'
import type { CommanderId, SimState } from './types.ts'

const FOES = ['fierce', 'guard', 'balanced'] as const
const SEEDS = 8

describe('智将 against the other commanders', () => {
  it('still loses to at least one commander after the battery change', () => {
    const rows = FOES.map((foe) => measure(foe))
    const worst = Math.min(...rows.map((row) => row.rate))
    const guard = rows.find((row) => row.foe === 'guard')
    expect(guard).toBeDefined()
    if (!guard) return
    expect(worst).toBeLessThanOrEqual(0.35)
  })
})

function measure(foe: (typeof FOES)[number]) {
  let wins = 0
  let games = 0
  let cunningShare = 0
  let foeShare = 0
  for (let seed = 1; seed <= SEEDS; seed++) {
    const asBlue = battle('cunning', foe, seed * 0x9e3779b1)
    const asRed = battle(foe, 'cunning', seed * 0x85ebca6b)
    for (const row of [asBlue, asRed]) {
      games += 1
      if (row.cunningWon) wins += 1
      cunningShare += row.cunningShare
      foeShare += row.foeShare
    }
  }
  return {
    foe,
    rate: wins / games,
    cunningShare: cunningShare / games,
    foeShare: foeShare / games,
  }
}

function battle(blue: CommanderId, red: CommanderId, seed: number) {
  let state = createSim({
    shipCount: 100,
    formations: ['oujin', 'oujin'],
    commanders: [blue, red],
  })
  state.rng = seed | 0
  state = dispatch(state, { type: 'set-speed', speed: 4 })
  state = dispatch(state, { type: 'start' })
  let steps = 0
  while (state.phase.kind === 'running' && state.time < 200 && steps < 25000) {
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    steps += 1
  }
  const winner =
    state.phase.kind === 'finished'
      ? state.phase.winner
      : state.alive[0] === state.alive[1]
        ? 'draw'
        : state.alive[0] > state.alive[1]
          ? 0
          : 1
  const cunningSide = blue === 'cunning' ? 0 : 1
  const foeSide = cunningSide === 0 ? 1 : 0
  return {
    cunningWon: winner === cunningSide,
    cunningShare: share(state, cunningSide),
    foeShare: share(state, foeSide),
  }
}

function share(state: SimState, side: 0 | 1): number {
  const front = state.hits.front[side]
  const sideHits = state.hits.side[side]
  const rear = state.hits.rear[side]
  const total = front + sideHits + rear
  return total === 0 ? 0 : (sideHits + rear) / total
}
