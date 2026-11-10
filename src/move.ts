import { CLASS_STATS, classIndex } from './balance.ts'
import { wrapAngle } from './combat.ts'
import type { Division } from './types.ts'

/** Close enough to spin onto the ordered heading instead of chasing the point. */
const ARRIVE = 36

export interface OrderAnchor {
  ax: number
  ay: number
}

/** Keep each division's offset from the group's centroid, so a multi-select moves as a block. */
export function orderPoints(
  anchors: readonly OrderAnchor[],
  indexes: readonly number[],
  x: number,
  y: number,
): { index: number; x: number; y: number }[] {
  let cx = 0
  let cy = 0
  let n = 0
  for (const index of indexes) {
    const div = anchors[index]
    if (!div) continue
    cx += div.ax
    cy += div.ay
    n += 1
  }
  if (n === 0) return []
  cx /= n
  cy /= n
  const points: { index: number; x: number; y: number }[] = []
  for (const index of indexes) {
    const div = anchors[index]
    if (!div) continue
    points.push({ index, x: x + (div.ax - cx), y: y + (div.ay - cy) })
  }
  return points
}

/**
 * Turn toward the destination, sail forward, then yaw onto the ordered heading.
 * Translation is only along the bow, with a creep in reverse when the point sits just behind.
 */
export function stepMoveOrder(div: Division, dt: number): void {
  if (!div.ordered || dt <= 0) return
  const stats = CLASS_STATS[classIndex(div.classId)]
  const turnRate = stats?.turnRate ?? 1.5
  const maxSpeed = stats?.maxSpeed ?? 70
  const reverse = stats?.reverse ?? 0.22
  const current = Math.atan2(div.fy, div.fx)
  const dx = div.orderX - div.ax
  const dy = div.orderY - div.ay
  const dist = Math.hypot(dx, dy)
  const travel = dist > 1e-4 ? Math.atan2(dy, dx) : div.orderH
  const settling = dist <= 12
  const desired = settling ? div.orderH : travel
  const yaw = Math.max(-turnRate * dt, Math.min(turnRate * dt, wrapAngle(desired - current)))
  const next = current + yaw
  const fx = Math.cos(next)
  const fy = Math.sin(next)
  div.fx = fx
  div.fy = fy
  div.rx = fy
  div.ry = -fx
  const forward = dx * fx + dy * fy
  const faceErr = Math.abs(wrapAngle(desired - next))
  let speed = 0
  if (settling) {
    speed = faceErr > 0.25 ? 0 : Math.max(-maxSpeed * reverse * 0.35, Math.min(maxSpeed * 0.2, forward))
  } else {
    const align = Math.cos(faceErr)
    speed = maxSpeed * (dist < ARRIVE ? 0.28 : 0.82) * Math.max(0, align)
    if (faceErr > 0.7) speed = Math.min(speed, maxSpeed * 0.12)
  }
  div.vx = fx * speed
  div.vy = fy * speed
  div.ax += div.vx * dt
  div.ay += div.vy * dt
  div.markX = div.orderX
  div.markY = div.orderY
  div.shaped = true
  div.focus = false
  div.sweeping = false
  div.sweepLocked = false
}
