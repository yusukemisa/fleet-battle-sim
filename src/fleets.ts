import { FIELD, FLEET_GAP, FLEET_SEPARATION, MAX_SHIPS } from './balance.ts'
import type { Fleet, FleetSetup, SideId, SimState } from './types.ts'

export const FLEET_NAMES: readonly [readonly string[], readonly string[]] = [
  ['青軍', '青軍二', '青軍三'],
  ['赤軍', '赤軍二', '赤軍三'],
]

/** 0 and 1 stay the original fleets. Later fleets alternate by side: 2 blue, 3 red, 4 blue, 5 red. */
export function fleetIndex(side: SideId, ordinal: number): number {
  return ordinal * 2 + side
}

export function fleetAnchor(side: SideId, ordinal: number): { x: number; y: number } {
  const sign = side === 0 ? -1 : 1
  const y = ordinal === 1 ? FLEET_GAP : ordinal === 2 ? -FLEET_GAP : 0
  const back = ordinal === 0 ? 0 : 160
  return { x: sign * (FIELD.fleetCenter + back), y }
}

export function clampGroups(groups: readonly FleetSetup[]): FleetSetup[] {
  const next: FleetSetup[] = []
  let used = 0
  const seen: [number, number] = [0, 0]
  for (const group of groups) {
    if (seen[group.side] >= 3) continue
    const room = MAX_SHIPS - used
    const ships = Math.max(0, Math.min(Math.round(group.ships), room))
    if (ships < 20) continue
    next.push({ ...group, ships })
    used += ships
    seen[group.side] += 1
  }
  return next
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
        if (dist >= FLEET_SEPARATION) continue
        const push = ((FLEET_SEPARATION - dist) * 0.22) / dist
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
