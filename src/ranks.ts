import { hullHp } from './balance.ts'
import { COMMANDERS, type Withdrawal } from './commanders.ts'
import { inArc } from './combat.ts'
import { collectNear, fillSpatialHash } from './spatial.ts'
import type { SideId, SimState } from './types.ts'

export function withdrawalFor(state: SimState, side: SideId): Withdrawal | null {
  if (!state.withdrawSides[side]) return null
  const policy = COMMANDERS[state.fleets[side].commanderId].withdraw
  if (policy.hp <= 0) return null
  return policy
}

export function rotateRanks(state: SimState): void {
  const ships = state.ships
  const groups: number[][] = []
  let fallingN = 0
  for (let i = 0; i < ships.count; i++) {
    ships.falling[i] = 0
    if (ships.alive[i] === 0) continue
    const division = ships.division[i] ?? 0
    ;(groups[division] ??= []).push(i)
  }
  for (let d = 0; d < groups.length; d++) {
    const members = groups[d]
    if (!members || members.length === 0) continue
    const division = state.divisions[d]
    if (!division) continue
    const policy = withdrawalFor(state, division.side)
    // A destroyer wing falls apart if it peels after the first hit. The line still rotates.
    if (!policy || division.classId === 'destroyer') continue
    // Against a charge, peeling the battleships opens the line they are trying to break.
    const ownFleet = state.fleets[division.fleet] ?? state.fleets[division.side]
    const foeFleet = state.fleets[ownFleet?.enemyFleet ?? (division.side === 0 ? 1 : 0)] ?? state.fleets[division.side === 0 ? 1 : 0]
    if (division.classId === 'battleship' && ownFleet?.commanderId === 'balanced' && foeFleet?.commanderId === 'fierce') {
      continue
    }
    const limitOf = (ship: number) => hullHp(ships.shipClass[ship] ?? 0, state.stats.hp) * policy.hp
    let hurt = false
    for (const ship of members) {
      if ((ships.hp[ship] ?? 0) < limitOf(ship)) hurt = true
    }
    if (!hurt) {
      for (const ship of members) {
        ships.slotX[ship] = ships.homeX[ship] ?? 0
        ships.slotY[ship] = ships.homeY[ship] ?? 0
      }
      continue
    }
    const ranked = members.slice().sort((a, b) => {
      const delta = (ships.hp[b] ?? 0) - (ships.hp[a] ?? 0)
      return delta !== 0 ? delta : a - b
    })
    const keep = Math.max(1, Math.ceil(ranked.length * policy.reengage))
    const front = ranked.slice(0, keep)
    const back = ranked.slice(keep)
    const homes = members
      .map((ship) => ({ x: ships.homeX[ship] ?? 0, y: ships.homeY[ship] ?? 0 }))
      .sort((a, b) => b.y - a.y || a.x - b.x)
    // Healthiest ships take the forward stations. Wounded ships take the rear ones and drop further back.
    const surge = policy.depth * 0.45
    for (let k = 0; k < front.length; k++) {
      const ship = front[k]
      const slot = homes[k]
      if (ship === undefined || !slot) continue
      ships.slotX[ship] = slot.x
      ships.slotY[ship] = slot.y + surge
    }
    for (let k = 0; k < back.length; k++) {
      const ship = back[k]
      const slot = homes[keep + k]
      if (ship === undefined || !slot) continue
      ships.slotX[ship] = slot.x
      ships.slotY[ship] = slot.y - policy.depth
      if ((ships.hp[ship] ?? 0) < limitOf(ship)) {
        ships.falling[ship] = 1
        fallingN += 1
      }
    }
  }
  state.fallingN = fallingN
}

/** How many enemy guns already cover each withdrawing ship. */
export function refreshCover(state: SimState): void {
  const ships = state.ships
  const scratch = state.scratch
  const range = state.stats.range
  const rangeSq = range * range
  fillSpatialHash(scratch.hash, ships.x, ships.y, ships.alive, ships.count)
  const frame = state.frame
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] === 0 || ships.falling[i] === 0) {
      scratch.exposed[i] = 0
      continue
    }
    if (frame % 4 !== i % 4) continue
    const sx = ships.x[i] ?? 0
    const sy = ships.y[i] ?? 0
    const side = ships.side[i]
    const n = collectNear(scratch.hash, sx, sy, range, ships.x, ships.y)
    const found = scratch.hash.found
    let threats = 0
    for (let k = 0; k < n; k++) {
      const other = found[k] ?? -1
      if (other < 0 || ships.alive[other] === 0 || ships.side[other] === side) continue
      const ox = ships.x[other] ?? 0
      const oy = ships.y[other] ?? 0
      const dx = ox - sx
      const dy = oy - sy
      const d2 = dx * dx + dy * dy
      if (d2 <= rangeSq && inArc(scratch.bowX[other] ?? 1, scratch.bowY[other] ?? 0, ox, oy, sx, sy, scratch.cosArc)) {
        threats += 1
        if (threats > 16) break
      }
    }
    scratch.exposed[i] = threats
  }
}
