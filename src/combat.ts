import type { ShipStats } from './balance.ts'

export function wrapAngle(delta: number): number {
  let turn = delta
  while (turn > Math.PI) turn -= Math.PI * 2
  while (turn < -Math.PI) turn += Math.PI * 2
  return turn
}

export function inFiringArc(
  heading: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  arc: number,
): boolean {
  const aim = Math.atan2(toY - fromY, toX - fromX)
  return Math.abs(wrapAngle(aim - heading)) <= arc
}

export function armorMultiplier(
  heading: number,
  targetX: number,
  targetY: number,
  shooterX: number,
  shooterY: number,
  stats: ShipStats,
): number {
  const incoming = Math.atan2(shooterY - targetY, shooterX - targetX)
  const diff = Math.abs(wrapAngle(incoming - heading))
  if (diff <= stats.armorBow) return stats.armorFront
  if (diff >= Math.PI - stats.armorStern) return stats.armorRear
  return stats.armorSide
}
