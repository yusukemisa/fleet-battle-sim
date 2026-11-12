import { CLASS_STATS, classIndex, lineRange, SHIP_STATS } from './balance.ts'
import { inBattery, wrapAngle } from './combat.ts'
import type { Division, SideId, SimState } from './types.ts'

export interface ThreatRead {
  weight: number
  x: number
  y: number
  /** A deliberate broadside pays: no enemy bow bears, and a flank is inside our side guns. */
  broadside: boolean
}

function statsOf(division: Division) {
  return CLASS_STATS[classIndex(division.classId)] ?? SHIP_STATS
}

/** Which enemy divisions can reach this one, and whether a broadside trade is worth the turn. */
export function assessDivision(state: SimState, division: Division): ThreatRead {
  const enemy: SideId = division.side === 0 ? 1 : 0
  const ours = statsOf(division)
  const sideMax = ours.batteries[1]?.maxRange ?? 420
  let weight = 0
  let sx = 0
  let sy = 0
  let bowThreat = false
  let flankShot = false
  for (const other of state.divisions) {
    if (other.side !== enemy || other.alive === 0) continue
    const dx = division.ax - other.ax
    const dy = division.ay - other.ay
    const dist = Math.hypot(dx, dy)
    const guns = statsOf(other)
    let local = 0
    let bow = false
    for (const battery of guns.batteries) {
      if (!inBattery(other.fx, other.fy, other.ax, other.ay, division.ax, division.ay, battery)) continue
      const bowGun = battery.id === 'bow'
      local += battery.guns * battery.power * (bowGun ? 1.7 : 0.65)
      if (bowGun) bow = true
    }
    if (local > 0) {
      weight += local
      sx += other.ax * local
      sy += other.ay * local
      if (bow) bowThreat = true
    }
    const along = dist < 1e-4 ? 1 : (dx * other.fx + dy * other.fy) / dist
    if (!bow && dist < sideMax && dist > 40 && along < 0.4) flankShot = true
  }
  if (weight <= 0) return { weight: 0, x: division.ax, y: division.ay, broadside: false }
  return { weight, x: sx / weight, y: sy / weight, broadside: flankShot && !bowThreat }
}

/**
 * Inside a threat, keep the bow toward it. A broadside turn is allowed only when the trade pays,
 * and a light threat still lets the division turn away to escape.
 */
export function aimUnderThreat(div: Division, tx: number, ty: number): { x: number; y: number } {
  if (div.yielding || div.guard <= 0 || div.broadsideOk) return { x: tx, y: ty }
  const dx = tx - div.ax
  const dy = ty - div.ay
  const dl = Math.hypot(dx, dy) || 1
  const px = div.guardX - div.ax
  const py = div.guardY - div.ay
  const pl = Math.hypot(px, py) || 1
  const dot = (dx / dl) * (px / pl) + (dy / dl) * (py / pl)
  if (dot >= 0.62) return { x: tx, y: ty }
  if (dot < -0.2 && div.guard < 14) return { x: tx, y: ty }
  return {
    x: div.ax + (px / pl) * 0.82 + (dx / dl) * 0.18,
    y: div.ay + (py / pl) * 0.82 + (dy / dl) * 0.18,
  }
}

export interface FlankGoal {
  x: number
  y: number
  angle: number
  range: number
  goalRange: number
  inFront: boolean
  pocket: boolean
}

/** Approach outside the prey's bow reach, then close only once the bow arc is cleared. */
export function wideFlankGoal(div: Division, prey: Division, mode: 'side' | 'rear'): FlankGoal {
  const bow = statsOf(prey).batteries[0]
  const bowHalf = bow?.half ?? 0.7
  const bowMax = bow?.maxRange ?? 900
  const safeRange = bowMax + 80
  const preferred = div.flankSign === 0 ? 1 : div.flankSign
  const relX = div.ax - prey.ax
  const relY = div.ay - prey.ay
  const along = relX * prey.fx + relY * prey.fy
  const cross = relX * prey.rx + relY * prey.ry
  const side = Math.abs(cross) > 40 ? Math.sign(cross) || preferred : preferred
  const range = Math.hypot(relX, relY) || 1
  const angle = Math.atan2(side * cross, along)
  const ownBow = statsOf(div).batteries[0]?.maxRange ?? 900
  const wantAngle = mode === 'rear' ? (130 * Math.PI) / 180 : div.screen ? (78 * Math.PI) / 180 : (100 * Math.PI) / 180
  const opened = lineRange(div.classId, div.alive)
  const wantRange = mode === 'rear' ? Math.max(opened, Math.min(ownBow * 0.85, opened + 40)) : opened
  const inFront = angle < bowHalf + 0.15
  const pocket = angle > wantAngle - 0.35 && range < wantRange + 140
  let goalAngle = wantAngle
  let goalRange = wantRange
  if (!pocket) {
    if (inFront) {
      goalAngle = angle + 0.42
      goalRange = Math.max(range + 30, safeRange)
    } else if (div.rush && angle > bowHalf + 0.2) {
      goalAngle = Math.min(wantAngle, Math.max(angle, bowHalf + 0.25))
      goalRange = wantRange
    } else {
      goalAngle = Math.min(wantAngle, Math.max(angle, bowHalf + 0.25))
      const span = Math.max(0.25, wantAngle - bowHalf)
      const t = Math.min(1, Math.max(0, (goalAngle - bowHalf) / span))
      goalRange = safeRange + (wantRange - safeRange) * t
    }
  }
  const c = Math.cos(goalAngle)
  const s = Math.sin(goalAngle)
  return {
    x: prey.ax + (prey.fx * c + prey.rx * side * s) * goalRange,
    y: prey.ay + (prey.fy * c + prey.ry * side * s) * goalRange,
    angle,
    range,
    goalRange,
    inFront,
    pocket,
  }
}

/** True when a straight order runs through an enemy bow circle. */
export function pathCrossesBow(state: SimState, side: SideId, x1: number, y1: number, x2: number, y2: number): boolean {
  const enemy: SideId = side === 0 ? 1 : 0
  for (let sample = 0; sample <= 6; sample++) {
    const t = sample / 6
    const x = x1 + (x2 - x1) * t
    const y = y1 + (y2 - y1) * t
    for (const division of state.divisions) {
      if (division.side !== enemy || division.alive === 0) continue
      const reach = statsOf(division).batteries[0]?.maxRange ?? 900
      const dx = x - division.ax
      const dy = y - division.ay
      if (dx * dx + dy * dy < reach * reach) return true
    }
  }
  return false
}

export function threatenedHeading(div: Division, desired: number, x: number, y: number): number {
  if (div.yielding || div.guard <= 0 || div.broadsideOk) return desired
  const threat = Math.atan2(div.guardY - y, div.guardX - x)
  if (Math.abs(wrapAngle(desired - threat)) <= 0.85) return desired
  return threat
}
