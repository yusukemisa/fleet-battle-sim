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

export type ArmorZone = 'front' | 'side' | 'rear'

export function armorZone(
  heading: number,
  targetX: number,
  targetY: number,
  shooterX: number,
  shooterY: number,
  stats: ShipStats,
): ArmorZone {
  const incoming = Math.atan2(shooterY - targetY, shooterX - targetX)
  const diff = Math.abs(wrapAngle(incoming - heading))
  if (diff <= stats.armorBow) return 'front'
  if (diff >= Math.PI - stats.armorStern) return 'rear'
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
