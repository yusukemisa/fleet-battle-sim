import { describe, expect, it } from 'vitest'
import { createSim, dispatch } from './sim.ts'
import type { CommanderId, FormationId, ShipCount } from './types.ts'

async function battle(
  count: ShipCount,
  formations: readonly [FormationId, FormationId],
  commanders: readonly [CommanderId, CommanderId],
) {
  let state = createSim({ shipCount: count, formations, commanders, brains: ['rule', 'rule'] })
  state = dispatch(state, { type: 'set-speed', speed: 4 })
  state = dispatch(state, { type: 'start' })
  let mid = 0
  let ticks = 0
  while (state.phase.kind === 'running' && state.time < 80) {
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    ticks += 1
    // A blocked loop longer than Vitest's 60s RPC window fails the run after the assertion passes.
    if (ticks % 100 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    if (mid === 0 && state.time >= 20) mid = (state.dealt[0] ?? 0) + (state.dealt[1] ?? 0)
  }
  const dealt = (state.dealt[0] ?? 0) + (state.dealt[1] ?? 0)
  const losses = (state.lost[0] ?? 0) + (state.lost[1] ?? 0)
  const crashed = (state.collisionDeaths[0] ?? 0) + (state.collisionDeaths[1] ?? 0)
  return { shots: state.tally.shots, dealt, mid, losses, crashed }
}

describe('large fleets engage', () => {
  it('deals gun damage within 80s while collision deaths stay rare', async () => {
    const pairs: { formations: readonly [FormationId, FormationId]; commanders: readonly [CommanderId, CommanderId] }[] = [
      { formations: ['engetsu', 'kakuyoku'], commanders: ['balanced', 'cunning'] },
      { formations: ['oujin', 'kakuyoku'], commanders: ['guard', 'fierce'] },
      { formations: ['gyorin', 'hoshi'], commanders: ['balanced', 'fierce'] },
    ]
    for (const count of [10000, 20000] as const) {
      for (const pair of pairs) {
        const label = `${count} ${pair.formations.join(' vs ')} ${pair.commanders.join(' vs ')}`
        const result = await battle(count, pair.formations, pair.commanders)
        expect(result.shots, label).toBeGreaterThan(40)
        expect(result.dealt, label).toBeGreaterThan(250)
        expect(result.dealt, label).toBeGreaterThan(result.mid)
        const share = result.losses === 0 ? 0 : result.crashed / result.losses
        expect(share, label).toBeLessThan(0.2)
      }
    }
  }, 300_000)
})
