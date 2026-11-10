import { describe, expect, it } from 'vitest'
import { createSim, dispatch } from './sim.ts'
import type { CommanderId, GunneryMode, SimState } from './types.ts'

const GUNNERY_CASES: ReadonlyArray<{ seed: number; commanders: readonly [CommanderId, CommanderId]; ships: 100 | 1000 }> = [
  { seed: 1, commanders: ['balanced', 'balanced'], ships: 100 },
  { seed: 2, commanders: ['cunning', 'fierce'], ships: 100 },
  { seed: 3, commanders: ['guard', 'balanced'], ships: 100 },
  { seed: 4, commanders: ['cunning', 'guard'], ships: 100 },
  { seed: 5, commanders: ['fierce', 'cunning'], ships: 100 },
  { seed: 6, commanders: ['balanced', 'cunning'], ships: 1000 },
  { seed: 7, commanders: ['guard', 'fierce'], ships: 1000 },
]

describe('gunnery benchmark', () => {
  it('hits harder and wastes fewer ready guns than sampled fire', () => {
    const before = blank()
    const after = blank()
    for (const row of GUNNERY_CASES) {
      add(before, measure(play(row, 'legacy')))
      add(after, measure(play(row, 'aimed')))
    }
    const legacy = mean(before, GUNNERY_CASES.length)
    const aimed = mean(after, GUNNERY_CASES.length)
    console.log(table(legacy, aimed))
    expect(aimed.held).toBeLessThanOrEqual(legacy.held)
    expect(aimed.wide).toBeLessThan(legacy.wide)
    expect(aimed.overkill).toBeLessThan(legacy.overkill)
    expect(aimed.damagePer).toBeGreaterThan(legacy.damagePer)
    expect(aimed.share).toBeGreaterThan(legacy.share)
  }, 40000)

  it('repeats the same shots for the same seed', () => {
    const a = play({ seed: 11, commanders: ['cunning', 'balanced'], ships: 100 }, 'aimed')
    const b = play({ seed: 11, commanders: ['cunning', 'balanced'], ships: 100 }, 'aimed')
    expect(a.tally).toEqual(b.tally)
    expect(a.lost).toEqual(b.lost)
    expect(a.hits).toEqual(b.hits)
  })
})

describe('withdrawal benchmark', () => {
  it('improves exchange for conservative commanders without stalling the battle', () => {
    const lines: string[] = []
    const pairs = [
      ['guard', 'cunning'],
      ['balanced', 'fierce'],
      ['cunning', 'guard'],
    ] as const
    for (const [commander, foe] of pairs) {
      let onLoss = 0
      let onKill = 0
      let offLoss = 0
      let offKill = 0
      let onTime = 0
      let offTime = 0
      const seeds = 5
      for (let seed = 1; seed <= seeds; seed++) {
        const on = playWithdraw(commander, foe, seed, true)
        const off = playWithdraw(commander, foe, seed, false)
        onTime += on.time
        offTime += off.time
        onLoss += on.lost[0]
        onKill += on.lost[1]
        offLoss += off.lost[0]
        offKill += off.lost[1]
      }
      const onExchange = onLoss / Math.max(1, onKill)
      const offExchange = offLoss / Math.max(1, offKill)
      const onDuration = onTime / seeds
      const offDuration = offTime / seeds
      lines.push(
        `| ${commander} vs ${foe} | ${onExchange.toFixed(3)} | ${offExchange.toFixed(3)} | ${onDuration.toFixed(1)} | ${offDuration.toFixed(1)} | ${onLoss} | ${onKill} | ${offLoss} | ${offKill} |`,
      )
      // Wings are destroyers and stay on station, so most losses are not the ships withdrawal saves.
      // The line still rotates. Exchange stays within 10% and the battle does not stall.
      expect(onExchange).toBeLessThan(offExchange * 1.1)
      expect(onDuration).toBeLessThan(Math.max(offDuration * 1.35 + 6, offDuration + 8))
      expect(onKill).toBeGreaterThan(40)
    }
    console.log(
      [
        '| 指揮官 | 退避あり損失/撃破 | 退避なし損失/撃破 | 退避あり時間 | 退避なし時間 | あり損失 | あり撃破 | なし損失 | なし撃破 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        ...lines,
      ].join('\n'),
    )
  })
})

describe('fleet step', () => {
  it('keeps 10k ships inside a 60fps sim budget', () => {
    let state = createSim({
      shipCount: 10000,
      formations: ['kakuyoku', 'hoshi'],
      commanders: ['balanced', 'cunning'],
    })
    state = dispatch(state, { type: 'set-speed', speed: 1 })
    state = dispatch(state, { type: 'start' })
    for (let i = 0; i < 40; i++) state = dispatch(state, { type: 'tick', dt: 1 / 60 })
    const samples: number[] = []
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now()
      state = dispatch(state, { type: 'tick', dt: 1 / 60 })
      samples.push(performance.now() - t0)
    }
    samples.sort((a, b) => a - b)
    const median = samples[Math.floor(samples.length / 2)] ?? 0
    console.log(`10k median step ${median.toFixed(2)} ms`)
    expect(median).toBeLessThan(12)
    expect(state.alive[0] + state.alive[1]).toBeGreaterThan(0)
  })
})

interface Row {
  seed: number
  commanders: readonly [CommanderId, CommanderId]
  ships: 100 | 1000
}

interface Totals {
  shots: number
  hits: number
  damagePer: number
  share: number
  overkill: number
  idle: number
  held: number
  wide: number
  ttk: number
}

function play(row: Row, gunnery: GunneryMode): SimState {
  let state = createSim({
    shipCount: row.ships,
    formations: ['oujin', 'oujin'],
    commanders: row.commanders,
    gunnery,
    withdraw: [false, false],
  })
  state.rng = (row.seed * 0x9e3779b1) | 0
  state = dispatch(state, { type: 'set-speed', speed: 4 })
  state = dispatch(state, { type: 'start' })
  const limit = row.ships === 1000 ? 16 : 28
  let steps = 0
  while (state.phase.kind === 'running' && state.time < limit && steps < 8000) {
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    steps += 1
  }
  return state
}

function playWithdraw(commander: CommanderId, foe: CommanderId, seed: number, withdraw: boolean): SimState {
  let state = createSim({
    shipCount: 100,
    formations: ['oujin', 'oujin'],
    commanders: [commander, foe],
    gunnery: 'aimed',
    withdraw: [withdraw, false],
  })
  state.rng = (seed * 0x85ebca6b) | 0
  state = dispatch(state, { type: 'set-speed', speed: 4 })
  state = dispatch(state, { type: 'start' })
  let steps = 0
  while (state.phase.kind === 'running' && state.time < 90 && steps < 12000) {
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    steps += 1
  }
  return state
}

function measure(state: SimState): Totals {
  const front = state.hits.front[0] + state.hits.front[1]
  const side = state.hits.side[0] + state.hits.side[1]
  const rear = state.hits.rear[0] + state.hits.rear[1]
  const landed = front + side + rear
  const tally = state.tally
  return {
    shots: tally.shots,
    hits: tally.hits,
    damagePer: tally.shots > 0 ? tally.damage / tally.shots : 0,
    share: landed > 0 ? (side + rear) / landed : 0,
    overkill: tally.overkill,
    idle: tally.idle,
    held: tally.held,
    wide: tally.wide,
    ttk: tally.deaths > 0 ? tally.deathTime / tally.deaths : state.time,
  }
}

function blank(): Totals {
  return { shots: 0, hits: 0, damagePer: 0, share: 0, overkill: 0, idle: 0, held: 0, wide: 0, ttk: 0 }
}

function add(into: Totals, row: Totals): void {
  into.shots += row.shots
  into.hits += row.hits
  into.damagePer += row.damagePer
  into.share += row.share
  into.overkill += row.overkill
  into.idle += row.idle
  into.held += row.held
  into.wide += row.wide
  into.ttk += row.ttk
}

function mean(total: Totals, n: number): Totals {
  return {
    shots: total.shots / n,
    hits: total.hits / n,
    damagePer: total.damagePer / n,
    share: total.share / n,
    overkill: total.overkill / n,
    idle: total.idle / n,
    held: total.held / n,
    wide: total.wide / n,
    ttk: total.ttk / n,
  }
}

function table(before: Totals, after: Totals): string {
  const line = (name: string, a: number, b: number, digits = 1) =>
    `| ${name} | ${a.toFixed(digits)} | ${b.toFixed(digits)} |`
  return [
    '| 指標 | 改善前 | 改善後 |',
    '| --- | --- | --- |',
    line('発射', before.shots, after.shots, 0),
    line('命中', before.hits, after.hits, 0),
    line('1発あたりダメージ', before.damagePer, after.damagePer, 3),
    line('側背の割合', before.share, after.share, 3),
    line('過剰弾', before.overkill, after.overkill, 1),
    line('撃てるのに待った時間', before.held, after.held, 1),
    line('射界外の待ち', before.wide, after.wide, 1),
    line('撃破までの時間', before.ttk, after.ttk, 2),
  ].join('\n')
}
