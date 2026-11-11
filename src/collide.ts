import { hullRadius } from './balance.ts'
import { fillSpatialHash, collectNear } from './spatial.ts'
import type { SimState } from './types.ts'

const MAX_RADIUS = 7.1

/** Push overlapping hulls apart. One pass, heavier ships give less ground. */
export function separateShips(state: SimState): void {
  const ships = state.ships
  const hash = state.scratch.collide
  fillSpatialHash(hash, ships.x, ships.y, ships.alive, ships.count)
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] === 0) continue
    const ri = hullRadius(ships.shipClass[i] ?? 0)
    const n = collectNear(hash, ships.x[i] ?? 0, ships.y[i] ?? 0, ri + MAX_RADIUS, ships.x, ships.y)
    for (let k = 0; k < n; k++) {
      const j = hash.found[k] ?? -1
      if (j <= i || ships.alive[j] === 0) continue
      const rj = hullRadius(ships.shipClass[j] ?? 0)
      let dx = (ships.x[j] ?? 0) - (ships.x[i] ?? 0)
      let dy = (ships.y[j] ?? 0) - (ships.y[i] ?? 0)
      const min = ri + rj
      let distSq = dx * dx + dy * dy
      if (distSq >= min * min) continue
      let dist = Math.sqrt(distSq)
      if (dist < 1e-3) {
        dx = (i & 1) === 0 ? 1 : -1
        dy = (j & 1) === 0 ? 0.5 : -0.5
        dist = Math.hypot(dx, dy)
      }
      const overlap = min - dist
      const shareI = rj / (ri + rj)
      const shareJ = ri / (ri + rj)
      const nx = dx / dist
      const ny = dy / dist
      ships.x[i] = (ships.x[i] ?? 0) - nx * overlap * shareI
      ships.y[i] = (ships.y[i] ?? 0) - ny * overlap * shareI
      ships.x[j] = (ships.x[j] ?? 0) + nx * overlap * shareJ
      ships.y[j] = (ships.y[j] ?? 0) + ny * overlap * shareJ
    }
  }
}
