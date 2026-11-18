import { describe, expect, it } from 'vitest'
import { featurize, INPUT_SIZE } from './brain/features.ts'
import { observe } from './brain/observe.ts'
import {
  FLAGSHIP,
  appointFlagships,
  commandMods,
  divisionCommandRadius,
  exposedFlagship,
  fleetCommandRadius,
  noteFlagshipLoss,
} from './flagship.ts'
import { createSim, dispatch } from './sim.ts'

describe('flagships', () => {
  it('appoints a battleship fleet flagship and a flagship in every division', () => {
    const state = createSim({ shipCount: 100, commanders: ['guard', 'fierce'], brains: ['rule', 'rule'] })
    expect(INPUT_SIZE).toBe(129)
    for (const fleet of state.fleets) {
      expect(fleet.flagship).toBeGreaterThanOrEqual(0)
      expect(state.ships.alive[fleet.flagship]).toBe(1)
      expect(state.ships.shipClass[fleet.flagship]).toBe(0)
      expect(state.ships.command[fleet.flagship]).toBe(2)
    }
    for (let index = 0; index < state.divisions.length; index++) {
      const division = state.divisions[index]
      if (!division || division.roster === 0) continue
      expect(division.flagship).toBeGreaterThanOrEqual(0)
      expect(state.ships.division[division.flagship]).toBe(index)
      expect(state.ships.alive[division.flagship]).toBe(1)
    }
    const features = featurize(observe(state, 0))
    const slot = 11
    expect(features[2 * slot + 10]).toBe(1)
    expect(features[10]).toBe(0.5)
    expect(features[5 * slot + 2 * slot + 10]).toBe(1)
  })

  it('stacks the two command bonuses only partway, and only inside the radius', () => {
    const state = createSim({ shipCount: 100, brains: ['rule', 'rule'] })
    const fleet = state.fleets[0]
    const wing = state.divisions[0]
    if (!fleet || !wing) throw new Error('missing fleet')
    const ship = divisionMate(state, wing.flagship)
    const flag = fleet.flagship
    state.ships.division[ship] = 0
    state.ships.x[wing.flagship] = 0
    state.ships.y[wing.flagship] = 0
    state.ships.x[ship] = 10
    state.ships.y[ship] = 0
    state.ships.x[flag] = 20
    state.ships.y[flag] = 0
    expect(commandMods(state, ship).hit).toBeCloseTo(FLAGSHIP.hitStack)
    expect(FLAGSHIP.hitStack).toBeLessThan(FLAGSHIP.hitFleet + FLAGSHIP.hitDivision)
    state.ships.x[flag] = 5000
    expect(commandMods(state, ship).hit).toBeCloseTo(FLAGSHIP.hitDivision)
    state.ships.x[ship] = FLAGSHIP.divisionRadius + 40
    expect(commandMods(state, ship).hit).toBe(0)
  })

  it('drops the bonus, penalizes maneuver, then hands command to the next battleship', () => {
    const state = createSim({ shipCount: 100, brains: ['rule', 'rule'] })
    const fleet = state.fleets[0]
    const flag = fleet?.flagship ?? -1
    const division = state.divisions[state.ships.division[flag] ?? 0]
    if (!fleet || !division) throw new Error('missing flagship')
    const mate = divisionMate(state, flag)
    state.ships.alive[flag] = 0
    noteFlagshipLoss(state, flag)
    expect(fleet.flagship).toBe(-1)
    expect(division.flagship).toBe(-1)
    const broken = commandMods(state, mate)
    expect(broken.hit).toBeCloseTo(FLAGSHIP.disruptHit)
    expect(broken.turn).toBeCloseTo(FLAGSHIP.disruptTurn)
    expect(broken.response).toBeCloseTo(FLAGSHIP.disruptResponse)
    state.time = FLAGSHIP.divisionDelay
    appointFlagships(state)
    expect(fleet.flagship).toBe(-1)
    expect(division.flagship).not.toBe(flag)
    expect(state.ships.shipClass[division.flagship]).toBe(0)
    state.time = FLAGSHIP.fleetDelay
    appointFlagships(state)
    expect(fleet.flagship).toBeGreaterThanOrEqual(0)
    expect(fleet.flagship).not.toBe(flag)
    expect(state.ships.alive[fleet.flagship]).toBe(1)
    expect(state.ships.command[fleet.flagship]).toBe(2)
    const restored = commandMods(state, fleet.flagship)
    expect(restored.hit).toBeGreaterThan(0)
    expect(restored.turn).toBeGreaterThan(1)
  })

  it('keeps small fleets on the old radii and covers the middle of a 10,000-ship line', () => {
    expect(fleetCommandRadius(50)).toBe(FLAGSHIP.fleetRadius)
    expect(fleetCommandRadius(500)).toBe(FLAGSHIP.fleetRadius)
    expect(divisionCommandRadius(10)).toBe(FLAGSHIP.divisionRadius)
    expect(divisionCommandRadius(100)).toBe(FLAGSHIP.divisionRadius)
    const state = createSim({ shipCount: 20000, formations: ['oujin', 'oujin'], brains: ['rule', 'rule'] })
    const ships = state.ships
    const fleet = state.fleets[0]
    if (!fleet) throw new Error('missing fleet')
    const radius = fleetCommandRadius(fleet.ships)
    expect(radius).toBeGreaterThan(1000)
    expect(radius).toBeLessThan(1300)
    const fx = ships.x[fleet.flagship] ?? 0
    const fy = ships.y[fleet.flagship] ?? 0
    let alive = 0
    let inside = 0
    for (let i = 0; i < ships.count / 2; i++) {
      if (ships.alive[i] !== 1) continue
      alive += 1
      const dx = (ships.x[i] ?? 0) - fx
      const dy = (ships.y[i] ?? 0) - fy
      if (dx * dx + dy * dy <= radius * radius) inside += 1
    }
    const share = inside / alive
    // The circle is unchanged. A 10,000-ship side is now a shallow line, so the same circle covers its middle, not half the line.
    expect(share).toBeGreaterThan(0.08)
    expect(share).toBeLessThan(0.2)
    for (const division of state.divisions) {
      if (division.side !== 0 || division.roster === 0) continue
      const at = division.flagship
      const reach = divisionCommandRadius(division.roster)
      const x = ships.x[at] ?? 0
      const y = ships.y[at] ?? 0
      let n = 0
      let hit = 0
      const index = state.divisions.indexOf(division)
      for (let i = 0; i < ships.count / 2; i++) {
        if (ships.alive[i] !== 1 || ships.division[i] !== index) continue
        n += 1
        const dx = (ships.x[i] ?? 0) - x
        const dy = (ships.y[i] ?? 0) - y
        if (dx * dx + dy * dy <= reach * reach) hit += 1
      }
      // Each block is a shallow line wider than this circle. The circle still covers its middle.
      expect(hit / n).toBeGreaterThan(0.25)
      expect(hit / n).toBeLessThan(0.75)
    }
  })

  it('holds the flagship division and hunts an exposed enemy flagship', () => {
    let state = createSim({ shipCount: 100, commanders: ['fierce', 'guard'], brains: ['rule', 'rule'] })
    state = dispatch(state, { type: 'start' })
    const enemy = state.fleets[1]
    const wing = 5
    const ship = state.divisions[wing]?.flagship ?? -1
    if (!enemy || ship < 0) throw new Error('missing enemy flagship')
    const previous = enemy.flagship
    if (previous >= 0 && previous !== ship) state.ships.command[previous] = 1
    enemy.flagship = ship
    state.ships.command[ship] = 2
    expect(exposedFlagship(state, ship)).toBe(true)
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    expect(state.fleets[0]?.prey).toBe(wing)
    expect(state.divisions[0]?.hunt).toBe(wing)
    const own = state.divisions[state.ships.division[state.fleets[0]?.flagship ?? 0] ?? 0]
    expect(own?.standoff).toBe(true)
    expect(own?.tacticId).not.toBe('charge')
  })

  it('starts on the rear rank and does not sail the flagship back', () => {
    let state = createSim({ shipCount: 1000, commanders: ['balanced', 'cunning'], brains: ['rule', 'rule'] })
    for (const fleet of state.fleets) {
      expect(state.ships.shipClass[fleet.flagship]).toBe(0)
      expect(rearMost(state, fleet.flagship, fleet.index)).toBe(true)
    }
    for (let index = 0; index < state.divisions.length; index++) {
      const division = state.divisions[index]
      if (!division || division.roster === 0) continue
      expect(rearMost(state, division.flagship, division.fleet, index)).toBe(true)
    }
    const watched = state.divisions.map((division) => division.flagship)
    const slots = watched.map((at) => [state.ships.slotX[at] ?? 0, state.ships.slotY[at] ?? 0] as const)
    const flagDivision = [0, 1].map((side) => state.ships.division[state.fleets[side]?.flagship ?? -1] ?? 0)
    const gapAt = (side: 0 | 1) => {
      const flag = state.divisions[flagDivision[side] ?? 0]
      if (!flag) return 0
      const others = state.divisions.filter((division) => division.side === side && division !== flag && division.alive > 0)
      const mean = others.reduce((sum, division) => sum + alongDivision(state, division, side), 0) / Math.max(1, others.length)
      return alongDivision(state, flag, side) - mean
    }
    const startGap = [0, 1].map((side) => gapAt(side as 0 | 1))
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    let checkedSlots = false
    while (state.phase.kind === 'running' && state.time < 6) {
      state = dispatch(state, { type: 'tick', dt: 0.05 })
      if (!checkedSlots && state.time >= 0.4) {
        checkedSlots = true
        for (let index = 0; index < watched.length; index++) {
          const at = watched[index] ?? -1
          if (state.ships.alive[at] !== 1) continue
          const sx = state.ships.slotX[at] ?? 0
          const sy = state.ships.slotY[at] ?? 0
          const home = slots[index]
          expect(Math.hypot(sx - (home?.[0] ?? 0), sy - (home?.[1] ?? 0))).toBeLessThan(1)
        }
      }
    }
    expect(checkedSlots).toBe(true)
    for (const side of [0, 1] as const) {
      const drop = (startGap[side] ?? 0) - gapAt(side)
      // 90 was measured when the fleets started 1160 apart, so six seconds could not finish the wing step.
      // The nose gap is now 1271. The flagship division still advances and its station does not move. The wings finish their step: balanced drops 107, the one-wing cunning side drops 127.
      expect(drop).toBeLessThan(140)
    }
  })

  it('keeps bows on the enemy after the fleet flagship is lost in range', () => {
    let state = createSim({ shipCount: 1000, commanders: ['balanced', 'cunning'], brains: ['rule', 'rule'] })
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    while (state.phase.kind === 'running' && state.time < 36) {
      state = dispatch(state, { type: 'tick', dt: 0.05 })
    }
    const flag = state.fleets[0]?.flagship ?? -1
    const start = new Map<number, number>()
    for (let i = 0; i < state.ships.count; i++) {
      if (state.ships.alive[i] === 1 && state.ships.side[i] === 0) start.set(i, state.ships.heading[i] ?? 0)
    }
    state.ships.hp[flag] = 0
    const t0 = state.time
    while (state.phase.kind === 'running' && state.time < t0 + 8) {
      state = dispatch(state, { type: 'tick', dt: 0.05 })
    }
    let swing = 0
    let n = 0
    let on = 0
    let inRange = 0
    for (const [i, before] of start) {
      if (state.ships.alive[i] !== 1) continue
      n += 1
      const after = state.ships.heading[i] ?? 0
      const turn = Math.abs(Math.atan2(Math.sin(after - before), Math.cos(after - before)))
      if (turn > 0.7) swing += 1
      const bow = bowOn(state, i)
      if (bow !== null) {
        inRange += 1
        if (bow > 0.5) on += 1
      }
    }
    expect(n).toBeGreaterThan(100)
    expect(inRange).toBeGreaterThan(50)
    expect(on / inRange).toBeGreaterThan(0.9)
    // The held hammer slides the line, so more ships turn than under the older movement.
    expect(swing / n).toBeLessThan(0.35)
  }, 20_000)
})

function axisOf(state: ReturnType<typeof createSim>, fleetIndex: number): { fx: number; fy: number; ox: number; oy: number } {
  const fleet = state.fleets[fleetIndex]
  const enemy = state.fleets[fleet?.enemyFleet ?? 0]
  if (!fleet || !enemy) throw new Error('missing fleet')
  const ox = fleet.meanX
  const oy = fleet.meanY
  const dx = enemy.meanX - ox
  const dy = enemy.meanY - oy
  const len = Math.hypot(dx, dy) || 1
  return { fx: dx / len, fy: dy / len, ox, oy }
}

function alongOf(state: ReturnType<typeof createSim>, index: number, axis: { fx: number; fy: number; ox: number; oy: number }): number {
  const x = (state.ships.x[index] ?? 0) - axis.ox
  const y = (state.ships.y[index] ?? 0) - axis.oy
  return x * axis.fx + y * axis.fy
}

function acrossOf(state: ReturnType<typeof createSim>, index: number, axis: { fx: number; fy: number; ox: number; oy: number }): number {
  const x = (state.ships.x[index] ?? 0) - axis.ox
  const y = (state.ships.y[index] ?? 0) - axis.oy
  return Math.abs(x * -axis.fy + y * axis.fx)
}

/** True when this ship is on the rearmost rank of its class and nearest the fleet axis. */
function rearMost(state: ReturnType<typeof createSim>, index: number, fleetIndex: number, division?: number): boolean {
  const axis = axisOf(state, fleetIndex)
  const ships = state.ships
  const rank = ships.shipClass[index] ?? 0
  let rear = Infinity
  let bestAcross = Infinity
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] !== 1 || (ships.shipClass[i] ?? 0) !== rank) continue
    if (state.divisions[ships.division[i] ?? -1]?.fleet !== fleetIndex) continue
    if (division !== undefined && ships.division[i] !== division) continue
    rear = Math.min(rear, alongOf(state, i, axis))
  }
  const mine = alongOf(state, index, axis)
  if (mine > rear + 14) return false
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] !== 1 || (ships.shipClass[i] ?? 0) !== rank) continue
    if (state.divisions[ships.division[i] ?? -1]?.fleet !== fleetIndex) continue
    if (division !== undefined && ships.division[i] !== division) continue
    if (alongOf(state, i, axis) > rear + 14) continue
    bestAcross = Math.min(bestAcross, acrossOf(state, i, axis))
  }
  return acrossOf(state, index, axis) <= bestAcross + 1
}

function alongDivision(state: ReturnType<typeof createSim>, division: { ax: number; ay: number }, side: 0 | 1): number {
  const enemy = side === 0 ? 1 : 0
  const ox = state.centroidX[side] ?? 0
  const oy = state.centroidY[side] ?? 0
  const dx = (state.centroidX[enemy] ?? 0) - ox
  const dy = (state.centroidY[enemy] ?? 0) - oy
  const len = Math.hypot(dx, dy) || 1
  const x = division.ax - ox
  const y = division.ay - oy
  return x * (dx / len) + y * (dy / len)
}

function bowOn(state: ReturnType<typeof createSim>, index: number): number | null {
  const ships = state.ships
  let best = Infinity
  let dx = 0
  let dy = 0
  for (let j = 0; j < ships.count; j++) {
    if (ships.alive[j] !== 1 || ships.side[j] === ships.side[index]) continue
    const x = (ships.x[j] ?? 0) - (ships.x[index] ?? 0)
    const y = (ships.y[j] ?? 0) - (ships.y[index] ?? 0)
    const dist = x * x + y * y
    if (dist < best) {
      best = dist
      dx = x
      dy = y
    }
  }
  if (best > 900 * 900) return null
  const len = Math.hypot(dx, dy) || 1
  return Math.cos(ships.heading[index] ?? 0) * (dx / len) + Math.sin(ships.heading[index] ?? 0) * (dy / len)
}

function divisionMate(state: ReturnType<typeof createSim>, flag: number): number {
  const division = state.ships.division[flag] ?? 0
  for (let index = 0; index < state.ships.count; index++) {
    if (index !== flag && state.ships.alive[index] === 1 && state.ships.division[index] === division) return index
  }
  throw new Error('no mate')
}
