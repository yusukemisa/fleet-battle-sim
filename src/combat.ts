import type { ShipStats } from './balance.ts'

export function wrapAngle(delta: number): number {
  let turn = delta
  while (turn > Math.PI) turn -= Math.PI * 2
  while (turn < -Math.PI) turn += Math.PI * 2
  return turn
}

/** True when `to` lies inside the bow cone. `cosLimit` is `cos(arc)`. */
export function inArc(
  hx: number,
  hy: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  cosLimit: number,
): boolean {
  const dx = toX - fromX
  const dy = toY - fromY
  const dist = Math.hypot(dx, dy)
  if (dist < 1e-4) return true
  return dx * hx + dy * hy >= dist * cosLimit
}

export function inFiringArc(
  heading: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  arc: number,
): boolean {
  return inArc(Math.cos(heading), Math.sin(heading), fromX, fromY, toX, toY, Math.cos(arc))
}

export function armorFactor(
  hx: number,
  hy: number,
  targetX: number,
  targetY: number,
  shooterX: number,
  shooterY: number,
  stats: ShipStats,
  cosBow: number,
  cosStern: number,
): number {
  const ix = shooterX - targetX
  const iy = shooterY - targetY
  const dist = Math.hypot(ix, iy)
  if (dist < 1e-4) return stats.armorFront
  const dot = ix * hx + iy * hy
  if (dot >= dist * cosBow) return stats.armorFront
  if (dot <= -dist * cosStern) return stats.armorRear
  return stats.armorSide
}

export type ArmorZone = 'front' | 'side' | 'rear'

export function armorZone(
  heading: number,
  targetX: number,
  targetY: number,
  shooterX: number,
  shooterY: number,
  stats: ShipStats,
): ArmorZone {
  const factor = armorFactor(
    Math.cos(heading),
    Math.sin(heading),
    targetX,
    targetY,
    shooterX,
    shooterY,
    stats,
    Math.cos(stats.armorBow),
    Math.cos(stats.armorStern),
  )
  if (factor === stats.armorRear) return 'rear'
  if (factor === stats.armorFront) return 'front'
  return 'side'
}

export function armorMultiplier(
  heading: number,
  targetX: number,
  targetY: number,
  shooterX: number,
  shooterY: number,
  stats: ShipStats,
): number {
  const zone = armorZone(heading, targetX, targetY, shooterX, shooterY, stats)
  if (zone === 'front') return stats.armorFront
  if (zone === 'rear') return stats.armorRear
  return stats.armorSide
}
