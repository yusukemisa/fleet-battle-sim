import { FIELD, FLEET_PAD, FLEET_SEPARATION, FLEET_SHIP_MAX, FLEET_SHIP_MIN, FLEET_SHIP_STEP, FLEET_STANDOFF, MAX_SHIPS } from './balance.ts'
import type { Fleet, FleetSetup, SideId, SimState } from './types.ts'

export const FLEET_NAMES: readonly [readonly string[], readonly string[]] = [
  ['青軍', '青軍二', '青軍三'],
  ['赤軍', '赤軍二', '赤軍三'],
]

/** 0 and 1 stay the original fleets. Later fleets alternate by side: 2 blue, 3 red, 4 blue, 5 red. */
export function fleetIndex(side: SideId, ordinal: number): number {
  return ordinal * 2 + side
}

/** Snap a requested fleet size onto the slider step, inside the per-fleet range. */
export function snapFleetShips(value: number): number {
  if (!Number.isFinite(value)) return FLEET_SHIP_MIN
  const clamped = Math.min(FLEET_SHIP_MAX, Math.max(FLEET_SHIP_MIN, value))
  const steps = Math.round((clamped - FLEET_SHIP_MIN) / FLEET_SHIP_STEP)
  return Math.min(FLEET_SHIP_MAX, FLEET_SHIP_MIN + steps * FLEET_SHIP_STEP)
}

/** Keep at most three fleets a side and snap each count. Does not apply the battle cap. */
export function normalizeGroups(groups: readonly FleetSetup[]): FleetSetup[] {
  const next: FleetSetup[] = []
  const seen: [number, number] = [0, 0]
  for (const group of groups) {
    if (group.side !== 0 && group.side !== 1) continue
    if (seen[group.side] >= 3) continue
    next.push({ ...group, ships: snapFleetShips(group.ships) })
    seen[group.side] += 1
  }
  return next
}

/**
 * Fit fleets into {@link MAX_SHIPS}. Over-cap requests are scaled by the same
 * ratio and reported; counts are never cut without a notice.
 */
export function fitGroups(groups: readonly FleetSetup[]): { requested: FleetSetup[]; groups: FleetSetup[]; notice: string | null } {
  const requested = normalizeGroups(groups)
  const asked = requested.reduce((sum, group) => sum + group.ships, 0)
  if (requested.length === 0 || asked <= MAX_SHIPS) {
    return { requested, groups: requested.map((group) => ({ ...group })), notice: null }
  }
  const scaled = scaleToCap(requested, MAX_SHIPS)
  const placed = scaled.reduce((sum, group) => sum + group.ships, 0)
  const notice = `要求 ${formatCount(asked)} 隻は上限 ${formatCount(MAX_SHIPS)} を超えるため、各艦隊を同じ割合で ${formatCount(placed)} 隻に収めました。`
  return { requested, groups: scaled, notice }
}

export interface AnchorInput {
  ordinal: number
  /** Lateral half-extent (world Y). */
  halfY: number
  /** How far the nose reaches toward the enemy (local +Y). */
  forward: number
}

/** Stack a side's fleets so their footprints do not overlap. */
export function anchorFleets(side: SideId, items: readonly AnchorInput[]): { x: number; y: number }[] {
  const center = items.find((item) => item.ordinal === 0) ?? items[0]
  const centerHalf = center?.halfY ?? 0
  const sign = side === 0 ? -1 : 1
  return items.map((item) => {
    const dir = item.ordinal === 1 ? 1 : item.ordinal === 2 ? -1 : 0
    const edge = centerHalf + item.halfY + FLEET_PAD
    const y = dir * Math.max(edge, dir === 0 ? 0 : FLEET_SEPARATION)
    const back = item.ordinal === 0 ? 0 : 80
    const x = sign * Math.max(FIELD.fleetCenter + back, item.forward + FLEET_STANDOFF)
    return { x, y }
  })
}

export function fleetAlive(state: SimState, fleet: Fleet): number {
  let alive = 0
  for (const division of state.divisions) {
    if (division.fleet === fleet.index) alive += division.alive
  }
  return alive
}

export function assignTargets(state: SimState): void {
  if (state.fleets.length <= 2) return
  for (const side of [0, 1] as const) {
    const ours = state.fleets.filter((fleet) => fleet.side === side && fleet.ships > 0 && fleetAlive(state, fleet) > 0)
    const enemies = state.fleets.filter((fleet) => fleet.side !== side && fleet.ships > 0 && fleetAlive(state, fleet) > 0)
    if (ours.length === 0 || enemies.length === 0) continue
    const leader = ours.find((fleet) => fleet.commanderId === 'balanced')
    const claimed = new Set<number>()
    const ordered = leader ? [leader, ...ours.filter((fleet) => fleet !== leader)] : ours
    for (const fleet of ordered) {
      const current = state.fleets[fleet.enemyFleet]
      const currentOk = current !== undefined && current.side !== side && fleetAlive(state, current) > 0
      let choice = enemies[0]
      if (!choice) continue
      if (fleet.commanderId === 'balanced') {
        choice = weakest(state, enemies)
      } else if (leader && currentOk === false) {
        const prey = state.fleets[leader.enemyFleet]
        const preyShips = prey?.ships ?? 1
        if (prey && prey.side !== side && fleetAlive(state, prey) > 0 && fleetAlive(state, prey) / preyShips < 0.4) {
          choice = prey
        } else {
          choice = freeOrNearest(fleet, enemies, claimed)
        }
      } else {
        choice = freeOrNearest(fleet, enemies, claimed)
        if (currentOk && current && choice.index !== current.index) {
          const stay = centroidDistance(fleet, current)
          const leave = centroidDistance(fleet, choice)
          if (stay < leave * 1.35) choice = current
        }
      }
      fleet.enemyFleet = choice.index
      claimed.add(choice.index)
    }
  }
}

export function separateFleets(state: SimState): void {
  if (state.fleets.length <= 2) return
  for (const side of [0, 1] as const) {
    const ours = state.fleets.filter((fleet) => fleet.side === side && fleet.ships > 0 && fleetAlive(state, fleet) > 0)
    for (let i = 0; i < ours.length; i++) {
      for (let j = i + 1; j < ours.length; j++) {
        const a = ours[i]
        const b = ours[j]
        if (!a || !b) continue
        const dx = b.meanX - a.meanX
        const dy = b.meanY - a.meanY
        const dist = Math.hypot(dx, dy) || 1
        const need = Math.max(FLEET_SEPARATION, a.reach + b.reach + FLEET_PAD)
        if (dist >= need) continue
        const push = ((need - dist) * 0.22) / dist
        nudge(state, a.index, -dx * push, -dy * push)
        nudge(state, b.index, dx * push, dy * push)
      }
    }
  }
}

function weakest(state: SimState, fleets: readonly Fleet[]): Fleet {
  let best = fleets[0]
  let bestRatio = Infinity
  for (const fleet of fleets) {
    const ratio = fleetAlive(state, fleet) / Math.max(1, fleet.ships)
    if (ratio < bestRatio) {
      bestRatio = ratio
      best = fleet
    }
  }
  return best ?? fleets[0]!
}

function freeOrNearest(fleet: Fleet, enemies: readonly Fleet[], claimed: ReadonlySet<number>): Fleet {
  let best: Fleet | undefined
  let bestDist = Infinity
  for (const enemy of enemies) {
    if (claimed.has(enemy.index)) continue
    const dist = centroidDistance(fleet, enemy)
    if (dist < bestDist) {
      bestDist = dist
      best = enemy
    }
  }
  if (best) return best
  let near = enemies[0]!
  let nearDist = Infinity
  for (const enemy of enemies) {
    const dist = centroidDistance(fleet, enemy)
    if (dist < nearDist) {
      nearDist = dist
      near = enemy
    }
  }
  return near
}

function scaleToCap(groups: readonly FleetSetup[], cap: number): FleetSetup[] {
  const minEach = groups.length * FLEET_SHIP_MIN <= cap ? FLEET_SHIP_MIN : 0
  const counts = new Array<number>(groups.length).fill(minEach)
  const budget = cap - minEach * groups.length
  const weights = groups.map((group) => Math.max(0, group.ships - minEach))
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0)
  if (budget > 0 && weightSum > 0) {
    const exact = weights.map((weight) => (weight * budget) / weightSum)
    const extra = exact.map((value) => Math.floor(value / FLEET_SHIP_STEP) * FLEET_SHIP_STEP)
    let usedExtra = 0
    for (let i = 0; i < counts.length; i++) {
      const add = Math.min(extra[i] ?? 0, Math.max(0, FLEET_SHIP_MAX - (counts[i] ?? 0)))
      counts[i] = (counts[i] ?? 0) + add
      usedExtra += add
    }
    const order = exact
      .map((value, index) => ({ index, rem: value - (extra[index] ?? 0) }))
      .sort((a, b) => b.rem - a.rem || a.index - b.index)
    let cursor = 0
    let stuck = 0
    while (usedExtra + FLEET_SHIP_STEP <= budget && order.length > 0 && stuck < order.length) {
      const item = order[cursor % order.length]
      cursor += 1
      if (!item) break
      const count = counts[item.index] ?? 0
      if (count + FLEET_SHIP_STEP > FLEET_SHIP_MAX) {
        stuck += 1
        continue
      }
      counts[item.index] = count + FLEET_SHIP_STEP
      usedExtra += FLEET_SHIP_STEP
      stuck = 0
    }
  }
  return groups.map((group, index) => ({ ...group, ships: counts[index] ?? minEach }))
}

function formatCount(value: number): string {
  return value.toLocaleString('ja-JP')
}

function centroidDistance(a: Fleet, b: Fleet): number {
  return Math.hypot(a.meanX - b.meanX, a.meanY - b.meanY)
}

function nudge(state: SimState, fleetIndex: number, dx: number, dy: number): void {
  for (const division of state.divisions) {
    if (division.fleet !== fleetIndex || division.alive === 0) continue
    division.ax += dx
    division.ay += dy
  }
}
