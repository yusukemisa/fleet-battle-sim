import { describe, expect, it } from 'vitest'
import { createSim, dispatch } from './sim.ts'
import type { CommanderId, FormationId, ShipCount } from './types.ts'

function battle(
  count: ShipCount,
  formations: readonly [FormationId, FormationId],
  commanders: readonly [CommanderId, CommanderId],
) {
  let state = createSim({ shipCount: count, formations, commanders, brains: ['rule', 'rule'] })
  state = dispatch(state, { type: 'set-speed', speed: 4 })
  state = dispatch(state, { type: 'start' })
  let mid = 0
  while (state.phase.kind === 'running' && state.time < 40) {
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    if (mid === 0 && state.time >= 20) mid = (state.dealt[0] ?? 0) + (state.dealt[1] ?? 0)
  }
  const dealt = (state.dealt[0] ?? 0) + (state.dealt[1] ?? 0)
  const losses = (state.lost[0] ?? 0) + (state.lost[1] ?? 0)
  const crashed = (state.collisionDeaths[0] ?? 0) + (state.collisionDeaths[1] ?? 0)
  return { shots: state.tally.shots, dealt, mid, losses, crashed }
}

describe('large fleets engage', () => {
  it('deals gun damage within 40s while collision deaths stay rare', () => {
    const pairs: { formations: readonly [FormationId, FormationId]; commanders: readonly [CommanderId, CommanderId] }[] = [
      { formations: ['engetsu', 'kakuyoku'], commanders: ['balanced', 'cunning'] },
      { formations: ['oujin', 'kakuyoku'], commanders: ['guard', 'fierce'] },
      { formations: ['gyorin', 'hoshi'], commanders: ['balanced', 'fierce'] },
    ]
    for (const count of [10000, 20000] as const) {
      for (const pair of pairs) {
        const label = `${count} ${pair.formations.join(' vs ')} ${pair.commanders.join(' vs ')}`
        const result = battle(count, pair.formations, pair.commanders)
        expect(result.shots, label).toBeGreaterThan(40)
        expect(result.dealt, label).toBeGreaterThan(250)
        expect(result.dealt, label).toBeGreaterThan(result.mid)
        const share = result.losses === 0 ? 0 : result.crashed / result.losses
        expect(share, label).toBeLessThan(0.2)
      }
    }
  }, 300_000)
})
