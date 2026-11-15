import { CLASS_MODS } from './balance.ts'
import { contactAge, contactFocus } from './contacts.ts'
import type { Division, SideId, SimState } from './types.ts'

/**
 * While a side's contact book has no fresh sighting, destroyers and cruisers
 * spread ahead as scouts and the battleships creep toward the last-seen point,
 * or straight ahead when nothing has ever been seen. A new sighting is already
 * in the shared book. The scouts then turn back toward the battleship division
 * and the ordinary engagement (including the U and the spindle) takes over.
 */
export const SEARCH = {
  /** A sighting newer than this keeps the fleet in the fight instead of searching. */
  memory: 2,
  scout: 32,
  body: 12,
  rejoin: 10,
  spread: 1100,
} as const

const hunts = new WeakMap<SimState, { phase: ['hold' | 'search' | 'rejoin', 'hold' | 'search' | 'rejoin'] }>()

function huntOf(state: SimState) {
  let row = hunts.get(state)
  if (!row) {
    row = { phase: ['hold', 'hold'] }
    hunts.set(state, row)
  }
  return row
}

/** Call after the contact book is refreshed and before divisions move. */
export function noteSearch(state: SimState): void {
  if (state.fleets.length > 2) return
  const row = huntOf(state)
  for (const side of [0, 1] as const) {
    const blind = contactAge(state, side) > SEARCH.memory
    if (blind) row.phase[side] = 'search'
    else if (row.phase[side] === 'search') row.phase[side] = 'rejoin'
    else if (row.phase[side] === 'rejoin' && !scoutsOut(state, side)) row.phase[side] = 'hold'
  }
}

/** True only during the sweep. Rejoining scouts do not block the main engagement. */
export function sideSearching(state: SimState, side: SideId): boolean {
  if (state.fleets.length > 2) return false
  return huntOf(state).phase[side] === 'search'
}

/** Search and the trip home both keep ship speed under the collision threshold. */
export function sideCautious(state: SimState, side: SideId): boolean {
  if (state.fleets.length > 2) return false
  const phase = huntOf(state).phase[side]
  return phase === 'search' || phase === 'rejoin'
}

function hypot(x: number, y: number): number {
  return Math.hypot(x, y)
}

function fast(div: Division): boolean {
  return div.classId === 'destroyer' || div.classId === 'cruiser'
}

function steer(div: Division, gx: number, gy: number, faceX: number, faceY: number, speed: number, dt: number): void {
  const dx = gx - div.ax
  const dy = gy - div.ay
  const len = hypot(dx, dy) || 1
  const paced = Math.min(22, speed * (CLASS_MODS[div.classId].speed || 1))
  const tvx = len > 20 ? (dx / len) * Math.min(paced, len) : 0
  const tvy = len > 20 ? (dy / len) * Math.min(paced, len) : 0
  const a = 1 - Math.exp(-1.7 * dt)
  div.vx += (tvx - div.vx) * a
  div.vy += (tvy - div.vy) * a
  div.ax += div.vx * dt
  div.ay += div.vy * dt
  div.shaped = true
  let fx = faceX - div.ax
  let fy = faceY - div.ay
  const fl = hypot(fx, fy)
  if (fl < 1e-4) return
  fx /= fl
  fy /= fl
  const turn = 1 - Math.exp(-2.2 * CLASS_MODS[div.classId].turn * dt)
  div.fx += (fx - div.fx) * turn
  div.fy += (fy - div.fy) * turn
  const norm = hypot(div.fx, div.fy) || 1
  div.fx /= norm
  div.fy /= norm
  div.rx = div.fy
  div.ry = -div.fx
}

function scoutsOut(state: SimState, side: SideId): boolean {
  const body = bodyOf(state, side)
  if (!body) return false
  for (const div of state.divisions) {
    if (div.side !== side || div.alive === 0 || !fast(div)) continue
    if (Math.hypot(div.ax - body.ax, div.ay - body.ay) > 500) return true
  }
  return false
}

function bodyOf(state: SimState, side: SideId): Division | null {
  let best: Division | null = null
  for (const div of state.divisions) {
    if (div.side !== side || div.alive === 0 || div.classId !== 'battleship') continue
    if (!best || div.alive > best.alive) best = div
  }
  return best
}

export function applySearch(state: SimState, dt: number): void {
  if (state.maneuver !== 'shaped' || state.fleets.length > 2) return
  const row = huntOf(state)
  for (const side of [0, 1] as const) {
    if (row.phase[side] === 'rejoin') {
      const body = bodyOf(state, side)
      if (!body) continue
      for (const div of state.divisions) {
        if (div.side !== side || div.alive === 0 || !fast(div)) continue
        steer(div, body.ax, body.ay, body.ax + body.fx * 200, body.ay + body.fy * 200, SEARCH.rejoin, dt)
      }
      continue
    }
    if (row.phase[side] !== 'search') continue
    const focus = contactFocus(state, side)
    const fleet = state.fleets[side]
    if (!fleet) continue
    const fx = fleet.facingX || (side === 0 ? 1 : -1)
    const fy = fleet.facingY || 0
    const lx = -fy
    const ly = fx
    const ox = state.centroidX[side] ?? 0
    const oy = state.centroidY[side] ?? 0
    const aimX = focus && !focus.fresh ? focus.x : ox + fx * 16000
    const aimY = focus && !focus.fresh ? focus.y : oy + fy * 16000
    for (const div of state.divisions) {
      if (div.side !== side || div.alive === 0) continue
      if (fast(div)) {
        const lane = (div.slot - 2) * SEARCH.spread + (side === 0 ? 0 : SEARCH.spread * 0.5)
        const along = Math.sin(state.time * 0.35 + div.slot) * 400
        steer(div, aimX + lx * lane + fx * along, aimY + ly * lane + fy * along, aimX, aimY, SEARCH.scout, dt)
      } else {
        steer(div, aimX, aimY, aimX, aimY, SEARCH.body, dt)
      }
    }
  }
}
