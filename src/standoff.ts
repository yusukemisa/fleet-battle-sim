import type { SimState } from './types.ts'

/**
 * Bow-on hold for a large division, BB / CL / DD.
 * Each hold sits inside that class's bow reach (900 / ~774 / ~468) with margin,
 * and each inner band sits above the bow's minimum (280 / ~241 / ~146) so a
 * front that has stopped can still shoot.
 */
export const GUN_HOLD = [680, 560, 360] as const
export const BACK_OFF = [400, 320, 220] as const
/** Closer than this counts as ramming distance for the learned penalty. */
export const RAM_PRESS = 96
const LARGE = 40

let idleUntil = -1
let gap = new Float32Array(0)
let ax = new Float32Array(0)
let ay = new Float32Array(0)
let pressed = new Int32Array(0)
let samples = new Int32Array(0)
let aimX = new Float32Array(0)
let aimY = new Float32Array(0)
let foeX = new Float32Array(0)
let foeY = new Float32Array(0)
let frontShip = new Int32Array(0)
let frontProj = new Float32Array(0)
let nearShip = new Int32Array(0)
let nearDist = new Float32Array(0)

function scratch(divisions: number): void {
  if (gap.length >= divisions) return
  gap = new Float32Array(divisions)
  ax = new Float32Array(divisions)
  ay = new Float32Array(divisions)
  pressed = new Int32Array(divisions)
  samples = new Int32Array(divisions)
  aimX = new Float32Array(divisions)
  aimY = new Float32Array(divisions)
  foeX = new Float32Array(divisions)
  foeY = new Float32Array(divisions)
  nearShip = new Int32Array(divisions)
  nearDist = new Float32Array(divisions)
  frontShip = new Int32Array(divisions * 3)
  frontProj = new Float32Array(divisions * 3)
}

function classIndex(id: string): number {
  if (id === 'cruiser') return 1
  if (id === 'destroyer') return 2
  return 0
}

export function gunHold(index: number): number {
  return GUN_HOLD[index] ?? GUN_HOLD[0]
}

export function backOff(index: number): number {
  return BACK_OFF[index] ?? BACK_OFF[0]
}

export function holdVectors(): readonly [Float32Array, Float32Array, Float32Array] {
  return [gap, ax, ay]
}

export function divisionGap(index: number): number {
  return gap[index] ?? 1e6
}

export function divisionAwayX(index: number): number {
  return ax[index] ?? 0
}

export function divisionAwayY(index: number): number {
  return ay[index] ?? 0
}

/** Sample the enemy front and hold large divisions there. Small fleets are unchanged. */
export function holdFronts(state: SimState): void {
  const ships = state.ships
  const n = ships.count
  const divisions = state.divisions
  if (state.frame === 0) idleUntil = -1
  if (state.frame > 0 && state.frame < idleUntil) return
  scratch(divisions.length)
  for (const division of divisions) division.press = 0
  gap.fill(1e6)
  pressed.fill(0)
  samples.fill(0)
  nearDist.fill(1e12)
  frontProj.fill(-1e9)
  frontShip.fill(-1)
  let any = false
  for (let a = 0; a < divisions.length; a++) {
    const division = divisions[a]
    if (!division || division.roster < LARGE || division.alive === 0) continue
    let best = 1e6
    for (const other of divisions) {
      if (!other || other.side === division.side || other.alive === 0) continue
      const dx = other.ax - division.ax
      const dy = other.ay - division.ay
      const dist = Math.hypot(dx, dy) || 1
      if (dist < best) {
        best = dist
        aimX[a] = dx / dist
        aimY[a] = dy / dist
        foeX[a] = other.ax
        foeY[a] = other.ay
        any = true
      }
    }
  }
  if (!any) {
    idleUntil = state.frame + 8
    return
  }
  const top = 2
  const picked = frontShip
  const projBuf = frontProj
  const closest = nearShip
  const closestDist = nearDist
  for (let i = 0; i < n; i++) {
    if (ships.alive[i] !== 1) continue
    const own = ships.division[i] ?? 0
    const division = divisions[own]
    if (!division || division.roster < LARGE) continue
    const x = ships.x[i] ?? 0
    const y = ships.y[i] ?? 0
    const proj = (x - division.ax) * (aimX[own] ?? 0) + (y - division.ay) * (aimY[own] ?? 0)
    let slot = 0
    for (let k = 1; k < top; k++) if ((projBuf[own * top + k] ?? 0) < (projBuf[own * top + slot] ?? 0)) slot = k
    if (proj > (projBuf[own * top + slot] ?? -1e9)) {
      projBuf[own * top + slot] = proj
      picked[own * top + slot] = i
    }
    const dx = x - (foeX[own] ?? 0)
    const dy = y - (foeY[own] ?? 0)
    const distSq = dx * dx + dy * dy
    if (distSq < (closestDist[own] ?? 1e12)) {
      closestDist[own] = distSq
      closest[own] = i
    }
  }
  const stride = n >= 8000 ? 32 : 1
  for (let own = 0; own < divisions.length; own++) {
    const division = divisions[own]
    if (!division || division.roster < LARGE) continue
    for (let s = 0; s <= top; s++) {
      const i = s < top ? (picked[own * top + s] ?? -1) : (closest[own] ?? -1)
      if (i < 0 || ships.alive[i] !== 1) continue
      const x = ships.x[i] ?? 0
      const y = ships.y[i] ?? 0
      const side = ships.side[i]
      samples[own] = (samples[own] ?? 0) + 1
      for (let j = own % stride; j < n; j += stride) {
        if (ships.alive[j] !== 1 || ships.side[j] === side) continue
        const dx = x - (ships.x[j] ?? 0)
        const dy = y - (ships.y[j] ?? 0)
        const distSq = dx * dx + dy * dy
        const best = gap[own] ?? 1e6
        if (distSq >= best * best && distSq >= RAM_PRESS * RAM_PRESS) continue
        const dist = Math.sqrt(distSq)
        if (dist < RAM_PRESS) pressed[own] = (pressed[own] ?? 0) + 1
        if (dist < best) {
          gap[own] = dist
          const len = dist || 1
          ax[own] = dx / len
          ay[own] = dy / len
        }
      }
    }
  }
  for (let index = 0; index < divisions.length; index++) {
    const division = divisions[index]
    const count = samples[index] ?? 0
    if (division && count > 0) division.press = (pressed[index] ?? 0) / count
  }
  let nearest = 1e6
  for (let index = 0; index < divisions.length; index++) {
    const division = divisions[index]
    if (!division || division.roster < LARGE) continue
    const front = gap[index] ?? 1e6
    nearest = Math.min(nearest, front)
    const hold = gunHold(classIndex(division.classId))
    const ux = aimX[index] ?? 0
    const uy = aimY[index] ?? 0
    if (ux === 0 && uy === 0) continue
    if (front >= hold) continue
    const closing = division.vx * ux + division.vy * uy
    if (closing > 0) {
      division.vx -= ux * closing
      division.vy -= uy * closing
    }
    if (front < backOff(classIndex(division.classId))) {
      division.vx -= ux * 14
      division.vy -= uy * 14
    }
  }
  idleUntil = nearest > 800 ? state.frame + 8 : -1
}
