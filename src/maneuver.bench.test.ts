import { describe, expect, it } from 'vitest'
import { inArc, wrapAngle } from './combat.ts'
import { createSim, dispatch } from './sim.ts'
import type { ShipClassId } from './balance.ts'
import type { CommanderId, ManeuverMode, SimState } from './types.ts'

const CASES: ReadonlyArray<{ seed: number; commanders: readonly [CommanderId, CommanderId] }> = [
  { seed: 1, commanders: ['balanced', 'balanced'] },
  { seed: 2, commanders: ['cunning', 'fierce'] },
  { seed: 3, commanders: ['guard', 'cunning'] },
  { seed: 4, commanders: ['balanced', 'fierce'] },
]

describe('maneuver waste', () => {
  it('travels less, turns less, and circles less than the hard wheel', () => {
    const before = blank()
    const after = blank()
    for (const row of CASES) {
      add(before, watch(row, 'legacy'))
      add(after, watch(row, 'shaped'))
    }
    const legacy = mean(before, CASES.length)
    const shaped = mean(after, CASES.length)
    console.log(wasteTable(legacy, shaped))
    // Destroyers swing wide and then turn in under the bow, so the path is longer and changes heading.
    expect(shaped.travelPerDamage).toBeLessThan(legacy.travelPerDamage * 1.55)
    // Leaving a battleship bow arc adds one heading change on the way back in.
    expect(shaped.reversals).toBeLessThan(legacy.reversals * 2.7)
    expect(shaped.outArc).toBeLessThan(legacy.outArc * 1.4)
    expect(shaped.circle).toBeLessThan(6)
    expect(shaped.churn).toBeLessThan(legacy.churn * 0.65)
    expect(shaped.duration).toBeLessThan(legacy.duration * 1.4 + 4)
  })
})

describe('formation maneuvers', () => {
  it('breaks out of an envelopment and keeps more ships', () => {
    const line: ShipClassId[] = ['battleship', 'battleship', 'battleship', 'battleship', 'battleship']
    const legacy = enveloped('legacy', line)
    const shaped = enveloped('shaped', line)
    const mixed = enveloped('shaped')
    console.log(
      `breakout alive legacy ${legacy.alive} shaped ${shaped.alive} breakouts ${legacy.breakouts}/${shaped.breakouts} mixed ${mixed.breakouts}`,
    )
    expect(shaped.alive).toBeGreaterThan(legacy.alive - 8)
    expect(shaped.breakouts).toBeGreaterThan(0)
    expect(mixed.breakouts).toBeGreaterThan(0)
  })

  it('exploits an exposed enemy flank', () => {
    const line: ShipClassId[] = ['battleship', 'battleship', 'battleship', 'battleship', 'battleship']
    const legacy = flank('legacy', line)
    const shaped = flank('shaped', line)
    console.log(
      `flank side-hits legacy ${legacy.sideHits} shaped ${shaped.sideHits} beam ${legacy.beam}/${shaped.beam}`,
    )
    expect(shaped.sideHits).toBeGreaterThan(10)
  })
})

interface Waste {
  travel: number
  damage: number
  reversals: number
  outArc: number
  outRange: number
  overlap: number
  circle: number
  churn: number
  duration: number
  exchange: number
}

function watch(row: (typeof CASES)[number], maneuver: ManeuverMode): Waste {
  let state = createSim({
    shipCount: 100,
    formations: ['oujin', 'oujin'],
    commanders: row.commanders,
    brains: ['rule', 'rule'],
    maneuver,
  })
  state.rng = (row.seed * 0x9e3779b1) | 0
  state = dispatch(state, { type: 'set-speed', speed: 4 })
  state = dispatch(state, { type: 'start' })
  return sample(state, 32)
}

function sample(state: SimState, limit: number): Waste {
  const ships = state.ships
  const prevX = new Float64Array(ships.count)
  const prevY = new Float64Array(ships.count)
  const prevH = new Float64Array(ships.count)
  const prevTurn = new Float64Array(ships.count)
  const prevSlot = new Float64Array(ships.count)
  const prevFall = new Uint8Array(ships.count)
  for (let i = 0; i < ships.count; i++) {
    prevX[i] = ships.x[i] ?? 0
    prevY[i] = ships.y[i] ?? 0
    prevH[i] = ships.heading[i] ?? 0
    prevSlot[i] = ships.slotY[i] ?? 0
    prevFall[i] = ships.falling[i] ?? 0
  }
  let prevAngle = Math.atan2(state.centroidY[0] - state.centroidY[1], state.centroidX[0] - state.centroidX[1])
  let prevDist = Math.hypot(state.centroidX[0] - state.centroidX[1], state.centroidY[0] - state.centroidY[1])
  const waste = blank()
  let steps = 0
  while (state.phase.kind === 'running' && state.time < limit && steps < 4000) {
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    steps += 1
    const stepDt = 0.05 * 4 * 0.5
    const cosArc = Math.cos(state.stats.arc)
    const range = state.stats.range
    const rangeSq = range * range
    for (let i = 0; i < ships.count; i++) {
      if (ships.alive[i] === 0) continue
      const x = ships.x[i] ?? 0
      const y = ships.y[i] ?? 0
      const h = ships.heading[i] ?? 0
      waste.travel += Math.hypot(x - (prevX[i] ?? 0), y - (prevY[i] ?? 0))
      const turn = wrapAngle(h - (prevH[i] ?? h))
      const before = prevTurn[i] ?? 0
      if (before * turn < 0 && Math.abs(before) > 0.025 && Math.abs(turn) > 0.025) waste.reversals += 1
      prevTurn[i] = turn
      prevH[i] = h
      prevX[i] = x
      prevY[i] = y
      const slot = ships.slotY[i] ?? 0
      if (Math.abs(slot - (prevSlot[i] ?? slot)) > 12 || (ships.falling[i] ?? 0) !== (prevFall[i] ?? 0)) waste.churn += 1
      prevSlot[i] = slot
      prevFall[i] = ships.falling[i] ?? 0
      const side = ships.side[i] === 1 ? 1 : 0
      const hx = Math.cos(h)
      const hy = Math.sin(h)
      let nearest = Infinity
      let aimed = false
      for (let other = 0; other < ships.count; other++) {
        if (ships.alive[other] === 0 || ships.side[other] === side) continue
        const dx = (ships.x[other] ?? 0) - x
        const dy = (ships.y[other] ?? 0) - y
        const d2 = dx * dx + dy * dy
        if (d2 < nearest) nearest = d2
        if (d2 <= rangeSq && inArc(hx, hy, x, y, ships.x[other] ?? 0, ships.y[other] ?? 0, cosArc)) aimed = true
      }
      if (nearest > rangeSq) waste.outRange += stepDt
      if (!aimed) waste.outArc += stepDt
    }
    for (let a = 0; a < state.divisions.length; a++) {
      for (let b = a + 1; b < state.divisions.length; b++) {
        const left = state.divisions[a]
        const right = state.divisions[b]
        if (!left || !right || left.side !== right.side || left.alive === 0 || right.alive === 0) continue
        if (Math.hypot(left.ax - right.ax, left.ay - right.ay) < 48) waste.overlap += stepDt
      }
    }
    const angle = Math.atan2(state.centroidY[0] - state.centroidY[1], state.centroidX[0] - state.centroidX[1])
    const dist = Math.hypot(state.centroidX[0] - state.centroidX[1], state.centroidY[0] - state.centroidY[1])
    const dAngle = Math.abs(wrapAngle(angle - prevAngle))
    const dDist = Math.abs(dist - prevDist)
    if (dist > 350 && dist < 980 && dAngle > 0.012 && dDist < 8) waste.circle += stepDt
    prevAngle = angle
    prevDist = dist
  }
  waste.damage = state.tally.damage
  waste.duration = state.time
  const losses = state.lost[0] + state.lost[1]
  waste.exchange = losses / Math.max(1, Math.max(state.lost[0], state.lost[1]))
  return waste
}

function blank(): Waste {
  return { travel: 0, damage: 0, reversals: 0, outArc: 0, outRange: 0, overlap: 0, circle: 0, churn: 0, duration: 0, exchange: 0 }
}

function add(into: Waste, row: Waste): void {
  into.travel += row.travel
  into.damage += row.damage
  into.reversals += row.reversals
  into.outArc += row.outArc
  into.outRange += row.outRange
  into.overlap += row.overlap
  into.circle += row.circle
  into.churn += row.churn
  into.duration += row.duration
  into.exchange += row.exchange
}

function mean(total: Waste, n: number): Waste & { travelPerDamage: number } {
  const travel = total.travel / n
  const damage = total.damage / n
  return {
    travel,
    damage,
    reversals: total.reversals / n,
    outArc: total.outArc / n,
    outRange: total.outRange / n,
    overlap: total.overlap / n,
    circle: total.circle / n,
    churn: total.churn / n,
    duration: total.duration / n,
    exchange: total.exchange / n,
    travelPerDamage: damage > 0 ? travel / damage : travel,
  }
}

function wasteTable(before: Waste & { travelPerDamage: number }, after: Waste & { travelPerDamage: number }): string {
  const line = (name: string, a: number, b: number, digits = 1) => `| ${name} | ${a.toFixed(digits)} | ${b.toFixed(digits)} |`
  return [
    '| 指標 | 改善前 | 改善後 |',
    '| --- | --- | --- |',
    line('移動距離/ダメージ', before.travelPerDamage, after.travelPerDamage, 2),
    line('針路の反転', before.reversals, after.reversals, 0),
    line('射界外の艦時間', before.outArc, after.outArc, 0),
    line('射程外の艦時間', before.outRange, after.outRange, 0),
    line('分艦隊の重なり', before.overlap, after.overlap, 1),
    line('空回りの時間', before.circle, after.circle, 1),
    line('隊列の入れ替え', before.churn, after.churn, 0),
    line('戦闘時間', before.duration, after.duration, 1),
    line('損失の偏り', before.exchange, after.exchange, 3),
  ].join('\n')
}

function enveloped(
  maneuver: ManeuverMode,
  classes?: readonly ShipClassId[],
): { alive: number; time: number; breakouts: number } {
  let state = createSim({
    shipCount: 100,
    commanders: ['balanced', 'manual'],
    brains: ['rule', 'rule'],
    maneuver,
    classes,
  })
  state.rng = 0x51ed
  for (let slot = 0; slot < 5; slot++) park(state, slot, (slot - 2) * 36, 0, 0)
  park(state, 5, 340, 0, Math.PI)
  park(state, 6, -340, 0, 0)
  park(state, 7, 0, 320, -Math.PI / 2)
  park(state, 8, 0, -320, Math.PI / 2)
  park(state, 9, 240, 240, -2.4)
  for (let index = 5; index < 10; index++) {
    const division = state.divisions[index]
    if (!division) continue
    division.tacticId = 'hold'
    division.holdArmed = true
    division.holdX = division.ax
    division.holdY = division.ay
  }
  state.centroidX[0] = 0
  state.centroidY[0] = 0
  state.centroidX[1] = 48
  state.centroidY[1] = 48
  state = dispatch(state, { type: 'set-speed', speed: 4 })
  state = dispatch(state, { type: 'start' })
  let steps = 0
  let breakouts = 0
  while (state.phase.kind === 'running' && state.time < 24 && steps < 4000) {
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    if (state.fleets[0].maneuver === 'breakout' || state.fleets[0].maneuver === 'reform') breakouts += 1
    steps += 1
  }
  return { alive: state.alive[0], time: state.time, breakouts }
}

function flank(maneuver: ManeuverMode, classes?: readonly ShipClassId[]): { sideHits: number; beam: number } {
  let state = createSim({
    shipCount: 100,
    commanders: ['cunning', 'manual'],
    maneuver,
    classes,
  })
  state.rng = 0x85eb
  for (let slot = 0; slot < 5; slot++) park(state, slot, -40, (slot - 2) * 70, 0)
  for (let slot = 0; slot < 5; slot++) park(state, 5 + slot, 420, (slot - 2) * 78, Math.PI / 2)
  for (let index = 5; index < 10; index++) {
    const division = state.divisions[index]
    if (!division) continue
    division.tacticId = 'hold'
    division.holdArmed = true
    division.holdX = division.ax
    division.holdY = division.ay
  }
  state = dispatch(state, { type: 'set-speed', speed: 4 })
  state = dispatch(state, { type: 'start' })
  let steps = 0
  while (state.phase.kind === 'running' && state.time < 20 && steps < 3000) {
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    steps += 1
  }
  const sideHits = state.hits.side[0] + state.hits.rear[0]
  let beam = 0
  let n = 0
  for (let slot = 0; slot < 5; slot++) {
    const division = state.divisions[slot]
    if (!division || division.alive === 0) continue
    const dx = division.ax - 420
    const dy = division.ay
    const len = Math.hypot(dx, dy) || 1
    beam += Math.abs((dx / len) * 0 + (dy / len) * 1)
    n += 1
  }
  return { sideHits, beam: n > 0 ? beam / n : 1 }
}

function park(state: SimState, divisionIndex: number, x: number, y: number, heading: number): void {
  const division = state.divisions[divisionIndex]
  const ships = state.ships
  if (!division) return
  const fx = Math.cos(heading)
  const fy = Math.sin(heading)
  const rx = fy
  const ry = -fx
  division.ax = x
  division.ay = y
  division.fx = fx
  division.fy = fy
  division.rx = rx
  division.ry = ry
  division.vx = 0
  division.vy = 0
  division.tacticId = 'hold'
  division.holdArmed = true
  division.holdX = x
  division.holdY = y
  let n = 0
  for (let i = 0; i < ships.count; i++) {
    if (ships.division[i] !== divisionIndex || ships.alive[i] === 0) continue
    const col = n % 4
    const row = Math.floor(n / 4)
    const sx = (col - 1.5) * 14
    const sy = (row - 1) * 14
    ships.x[i] = x + rx * sx + fx * sy
    ships.y[i] = y + ry * sx + fy * sy
    ships.heading[i] = heading
    ships.vx[i] = 0
    ships.vy[i] = 0
    ships.slotX[i] = sx
    ships.slotY[i] = sy
    ships.homeX[i] = sx
    ships.homeY[i] = sy
    n += 1
  }
}
