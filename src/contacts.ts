import { SENSOR } from './balance.ts'
import type { ContactBook, SideId, SimState } from './types.ts'

/**
 * Detection today is private and uneven.
 * Each ship acquires a target only inside its own sensor range (6400) and, on the
 * legacy path, only inside its own firing arc. Gunnery then searches a spatial hash
 * limited to gun range. Nothing a ship learns is given to its neighbours.
 * Fleet movement does not use sensors at all: divisions and the rule commanders
 * read the live enemy centroids and anchors, so a fleet steers at an enemy it has
 * not seen.
 *
 * The contact book replaces that for movement. A division reports an enemy hull
 * when the hull is within sensor range of that division's bounding box (the ships
 * actually placed, not a guess around the anchor). The sighting is written once,
 * for the whole side: every friendly ship, division, and the fleet's own search
 * read the same last position and the time it was seen. A hull that leaves sensor
 * range keeps that last place until it is seen again.
 */
export function createContacts(count: number): ContactBook {
  const at = new Float32Array(count)
  at.fill(-1)
  return { x: new Float32Array(count), y: new Float32Array(count), at, stamp: new Int32Array(count) }
}

export function updateContacts(state: SimState): void {
  const ships = state.ships
  const nDiv = state.divisions.length
  const minX = new Float64Array(nDiv).fill(Infinity)
  const minY = new Float64Array(nDiv).fill(Infinity)
  const maxX = new Float64Array(nDiv).fill(-Infinity)
  const maxY = new Float64Array(nDiv).fill(-Infinity)
  const has = new Uint8Array(nDiv)
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] !== 1) continue
    const d = ships.division[i] ?? 0
    const x = ships.x[i] ?? 0
    const y = ships.y[i] ?? 0
    if (x < (minX[d] ?? Infinity)) minX[d] = x
    if (y < (minY[d] ?? Infinity)) minY[d] = y
    if (x > (maxX[d] ?? -Infinity)) maxX[d] = x
    if (y > (maxY[d] ?? -Infinity)) maxY[d] = y
    has[d] = 1
  }
  const frame = state.frame
  const time = state.time
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] !== 1) continue
    const side = ships.side[i] === 1 ? 1 : 0
    const spotter: SideId = side === 0 ? 1 : 0
    const x = ships.x[i] ?? 0
    const y = ships.y[i] ?? 0
    for (let d = 0; d < nDiv; d++) {
      const division = state.divisions[d]
      if (!division || division.side !== spotter || has[d] !== 1) continue
      if (boxDistance(x, y, minX[d] ?? 0, minY[d] ?? 0, maxX[d] ?? 0, maxY[d] ?? 0) > SENSOR) continue
      const book = state.contacts[spotter]
      book.x[i] = x
      book.y[i] = y
      book.at[i] = time
      book.stamp[i] = frame
      break
    }
  }
}

/** Seconds since the newest sighting. Infinity when this side has never seen an enemy. */
export function contactAge(state: SimState, side: SideId): number {
  const book = state.contacts[side]
  let newest = -1
  for (let i = 0; i < book.at.length; i++) {
    const at = book.at[i] ?? -1
    if (at > newest) newest = at
  }
  if (newest < 0) return Infinity
  return state.time - newest
}

/** No enemy hull is inside the shared picture right now. Last-seen marks can still exist. */
export function sideBlind(state: SimState, side: SideId): boolean {
  const book = state.contacts[side]
  const frame = state.frame
  for (let i = 0; i < book.stamp.length; i++) {
    if (book.stamp[i] === frame && (state.ships.alive[i] ?? 0) === 1) return false
  }
  return true
}

/** Mean of the sightings this side still trusts. Fresh hulls win; otherwise the newest last-seen. */
export function contactFocus(state: SimState, side: SideId): { x: number; y: number; n: number; fresh: boolean } | null {
  const book = state.contacts[side]
  const frame = state.frame
  let sx = 0
  let sy = 0
  let n = 0
  let newest = -1
  let lx = 0
  let ly = 0
  for (let i = 0; i < book.at.length; i++) {
    const at = book.at[i] ?? -1
    if (at < 0 || state.ships.alive[i] !== 1) continue
    if (book.stamp[i] === frame) {
      sx += book.x[i] ?? 0
      sy += book.y[i] ?? 0
      n += 1
    } else if (at > newest) {
      newest = at
      lx = book.x[i] ?? 0
      ly = book.y[i] ?? 0
    }
  }
  if (n > 0) return { x: sx / n, y: sy / n, n, fresh: true }
  if (newest < 0) return null
  return { x: lx, y: ly, n: 1, fresh: false }
}

/** Push the two sides apart until the nearest hulls are `gap` apart, for a search scenario. */
export function openTheRange(state: SimState, gap: number): void {
  const ships = state.ships
  let max0 = -Infinity
  let min1 = Infinity
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] !== 1) continue
    const x = ships.x[i] ?? 0
    if (ships.side[i] === 1) min1 = Math.min(min1, x)
    else max0 = Math.max(max0, x)
  }
  const extra = gap - (min1 - max0)
  if (!(extra > 0)) return
  const shift = extra / 2
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] !== 1) continue
    ships.x[i] = (ships.x[i] ?? 0) + (ships.side[i] === 1 ? shift : -shift)
  }
  for (const division of state.divisions) {
    division.ax += division.side === 1 ? shift : -shift
  }
  for (const fleet of state.fleets) {
    const sign = fleet.side === 1 ? 1 : -1
    fleet.centerX += sign * shift
    fleet.meanX += sign * shift
  }
  state.centroidX[0] -= shift
  state.centroidX[1] += shift
}

function boxDistance(px: number, py: number, minX: number, minY: number, maxX: number, maxY: number): number {
  const dx = px < minX ? minX - px : px > maxX ? px - maxX : 0
  const dy = py < minY ? minY - py : py > maxY ? py - maxY : 0
  return Math.hypot(dx, dy)
}
