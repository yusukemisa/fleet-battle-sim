import { COLLISION, hullRadius } from './balance.ts'
import { fillSpatialHash, collectNear } from './spatial.ts'
import type { SimState } from './types.ts'

const MAX_RADIUS = 7.1
const LOOK = 0.7

let avoidX = new Float32Array(0)
let avoidY = new Float32Array(0)
let brake = new Float32Array(0)
let steerHot = false
const NEAR_KEEP = 8
const nearD = new Float32Array(NEAR_KEEP)
const nearJ = new Int32Array(NEAR_KEEP)

function massOf(classIndex: number): number {
  const radius = hullRadius(classIndex)
  return radius * radius
}

function kill(state: SimState, index: number): void {
  const ships = state.ships
  if (ships.alive[index] !== 1 || (ships.hp[index] ?? 0) <= 0) return
  state.ram += ships.hp[index] ?? 0
  ships.hp[index] = 0
  const side = ships.side[index] === 1 ? 1 : 0
  state.collisionDeaths[side] += 1
}

/**
 * Look ahead one short step. A ship that is closing on another hull is pushed
 * sideways, and the division records how many of its ships are in that range.
 * The arrays are reused. A zero vector means this ship has a clear bow.
 */
export function steerClear(state: SimState): void {
  const ships = state.ships
  const n = ships.count
  if (avoidX.length < n) {
    avoidX = new Float32Array(n)
    avoidY = new Float32Array(n)
    brake = new Float32Array(n)
  }
  if (state.frame === 0 && steerHot) {
    avoidX.fill(0)
    avoidY.fill(0)
    brake.fill(0)
    steerHot = false
  }
  const divisions = state.divisions
  let hotCount = 0
  const hot = new Uint8Array(divisions.length)
  for (let a = 0; a < divisions.length; a++) {
    const division = divisions[a]
    if (!division || division.alive === 0) continue
    const reach = Math.max(520, halfBody(division) + 160)
    const reachSq = reach * reach
    for (let b = 0; b < divisions.length; b++) {
      if (a === b) continue
      const other = divisions[b]
      if (!other || other.alive === 0 || other.fleet === division.fleet) continue
      const dx = division.ax - other.ax
      const dy = division.ay - other.ay
      if (dx * dx + dy * dy < reachSq) {
        hot[a] = 1
        hotCount += 1
        break
      }
    }
  }
  if (hotCount === 0) {
    if (steerHot) {
      avoidX.fill(0)
      avoidY.fill(0)
      brake.fill(0)
      steerHot = false
    }
    for (const division of divisions) division.pack = 0
    return
  }
  steerHot = true
  for (const division of divisions) division.pack = 0
  if (n === 0) return
  const hash = state.scratch.collide
  fillSpatialHash(hash, ships.x, ships.y, ships.alive, n)
  const crowdHit = new Int32Array(divisions.length)
  const crowdSeen = new Int32Array(divisions.length)
  // A 10k battle refreshes a quarter of the hulls each frame and keeps the last vector on the rest.
  const stride = n >= 8000 ? 4 : 1
  const start = state.frame % stride
  for (let i = start; i < n; i += stride) {
    avoidX[i] = 0
    avoidY[i] = 0
    brake[i] = 0
    if (ships.alive[i] !== 1) continue
    const divisionIndex = ships.division[i] ?? 0
    if (hot[divisionIndex] !== 1) continue
    const x = ships.x[i] ?? 0
    const y = ships.y[i] ?? 0
    const vx = ships.vx[i] ?? 0
    const vy = ships.vy[i] ?? 0
    const ri = hullRadius(ships.shipClass[i] ?? 0)
    const reach = Math.min(72, Math.hypot(vx, vy) * LOOK + ri + MAX_RADIUS + 14)
    const found = collectNear(hash, x, y, reach, ships.x, ships.y)
    if (divisionIndex < crowdSeen.length) crowdSeen[divisionIndex] = (crowdSeen[divisionIndex] ?? 0) + 1
    let crowded = false
    const keep = NEAR_KEEP
    nearD.fill(Infinity)
    let kept = 0
    for (let k = 0; k < found; k++) {
      const j = hash.found[k] ?? -1
      if (j < 0 || j === i || ships.alive[j] !== 1) continue
      const dx = (ships.x[j] ?? 0) - x
      const dy = (ships.y[j] ?? 0) - y
      const dist = dx * dx + dy * dy
      if (kept < keep) {
        nearD[kept] = dist
        nearJ[kept] = j
        kept += 1
        continue
      }
      let worst = 0
      for (let slot = 1; slot < keep; slot++) if ((nearD[slot] ?? 0) > (nearD[worst] ?? 0)) worst = slot
      if (dist < (nearD[worst] ?? Infinity)) {
        nearD[worst] = dist
        nearJ[worst] = j
      }
    }
    for (let k = 0; k < kept; k++) {
      const j = nearJ[k] ?? -1
      if (j < 0) continue
      const ox = ships.x[j] ?? 0
      const oy = ships.y[j] ?? 0
      const rx = ox - x
      const ry = oy - y
      const approach = (vx - (ships.vx[j] ?? 0)) * rx + (vy - (ships.vy[j] ?? 0)) * ry
      const rj = hullRadius(ships.shipClass[j] ?? 0)
      const now = Math.hypot(rx, ry)
      if (now < (ri + rj) * 1.45) crowded = true
      if (aheadThreat(vx, vy, rx, ry, now, ri + rj)) {
        const urgency = Math.min(1, (ri + rj + 72 - now) / (ri + rj + 72))
        brake[i] = Math.max(brake[i] ?? 0, urgency)
      }
      if (approach <= 0) continue
      const px = x + vx * LOOK
      const py = y + vy * LOOK
      const qx = ox + (ships.vx[j] ?? 0) * LOOK
      const qy = oy + (ships.vy[j] ?? 0) * LOOK
      const dx = qx - px
      const dy = qy - py
      const dist = Math.hypot(dx, dy) || 1
      const need = ri + rj + 16
      if (dist >= need) continue
      const push = (need - dist) / need
      avoidX[i] = (avoidX[i] ?? 0) - (dx / dist) * push
      avoidY[i] = (avoidY[i] ?? 0) - (dy / dist) * push
    }
    if (crowded && divisionIndex < crowdHit.length) crowdHit[divisionIndex] = (crowdHit[divisionIndex] ?? 0) + 1
  }
  for (let index = 0; index < divisions.length; index++) {
    const division = divisions[index]
    const seen = crowdSeen[index] ?? 0
    if (division && seen > 0) division.pack = (crowdHit[index] ?? 0) / seen
  }
}

export function avoidanceX(index: number): number {
  return avoidX[index] ?? 0
}

export function avoidanceY(index: number): number {
  return avoidY[index] ?? 0
}

export function avoidanceBrake(index: number): number {
  return brake[index] ?? 0
}

function halfBody(division: { roster: number; alive: number }): number {
  const ships = Math.max(division.alive, 1)
  return 18 + 3.2 * Math.sqrt(ships)
}

function aheadThreat(vx: number, vy: number, rx: number, ry: number, dist: number, radii: number): boolean {
  const speed = Math.hypot(vx, vy)
  if (speed < 4 || dist >= radii + 72 || dist < 1e-3) return false
  const ahead = (rx * vx + ry * vy) / (dist * speed)
  return ahead > 0.55
}

/** Push overlapping hulls apart. A closing overlap destroys one or both ships. */
export function separateShips(state: SimState, _dt = 0.1): void {
  const ships = state.ships
  const hash = state.scratch.collide
  fillSpatialHash(hash, ships.x, ships.y, ships.alive, ships.count)
  let pairs = 0
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] === 0 || (ships.hp[i] ?? 0) <= 0) continue
    const ri = hullRadius(ships.shipClass[i] ?? 0)
    const n = collectNear(hash, ships.x[i] ?? 0, ships.y[i] ?? 0, ri + MAX_RADIUS, ships.x, ships.y)
    for (let k = 0; k < n; k++) {
      const j = hash.found[k] ?? -1
      if (j <= i || ships.alive[j] === 0 || (ships.hp[j] ?? 0) <= 0) continue
      const rj = hullRadius(ships.shipClass[j] ?? 0)
      let dx = (ships.x[j] ?? 0) - (ships.x[i] ?? 0)
      let dy = (ships.y[j] ?? 0) - (ships.y[i] ?? 0)
      const min = ri + rj
      const distSq = dx * dx + dy * dy
      if (distSq >= min * min) continue
      let dist = Math.sqrt(distSq)
      if (dist < 1e-3) {
        dx = (i & 1) === 0 ? 1 : -1
        dy = (j & 1) === 0 ? 0.5 : -0.5
        dist = Math.hypot(dx, dy)
      }
      const nx = dx / dist
      const ny = dy / dist
      const closing = ((ships.vx[i] ?? 0) - (ships.vx[j] ?? 0)) * nx + ((ships.vy[i] ?? 0) - (ships.vy[j] ?? 0)) * ny
      if (closing > COLLISION.closing && pairs < COLLISION.maxPairs) {
        pairs += 1
        const heavy = massOf(ships.shipClass[i] ?? 0)
        const light = massOf(ships.shipClass[j] ?? 0)
        if (heavy >= light * COLLISION.massRatio) kill(state, j)
        else if (light >= heavy * COLLISION.massRatio) kill(state, i)
        else {
          kill(state, i)
          kill(state, j)
        }
      }
      const overlap = min - dist
      const shareI = rj / (ri + rj)
      const shareJ = ri / (ri + rj)
      ships.x[i] = (ships.x[i] ?? 0) - nx * overlap * shareI
      ships.y[i] = (ships.y[i] ?? 0) - ny * overlap * shareI
      ships.x[j] = (ships.x[j] ?? 0) + nx * overlap * shareJ
      ships.y[j] = (ships.y[j] ?? 0) + ny * overlap * shareJ
    }
  }
}
