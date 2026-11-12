import { RAM, hullRadius } from './balance.ts'
import { fillSpatialHash, collectNear } from './spatial.ts'
import type { SimState } from './types.ts'

const MAX_RADIUS = 7.1
let ramBudget = new Float32Array(0)

/** Push overlapping hulls apart. One pass, heavier ships give less ground. */
export function separateShips(state: SimState, dt = 0.1): void {
  const ships = state.ships
  const hash = state.scratch.collide
  if (ramBudget.length < ships.count) ramBudget = new Float32Array(ships.count)
  else ramBudget.fill(0, 0, ships.count)
  const limit = RAM.cap * dt
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
      const distSq = dx * dx + dy * dy
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
      const closing = Math.max(0, ((ships.vx[i] ?? 0) - (ships.vx[j] ?? 0)) * nx + ((ships.vy[i] ?? 0) - (ships.vy[j] ?? 0)) * ny - RAM.closing)
      const energy = RAM.power * closing * (overlap / min) * dt
      if (energy > 0.01) {
        const massI = ri * ri
        const massJ = rj * rj
        const mass = massI + massJ
        const roomI = Math.max(0, limit - (ramBudget[i] ?? 0))
        const roomJ = Math.max(0, limit - (ramBudget[j] ?? 0))
        const lossI = Math.min(roomI, (energy * massJ) / mass)
        const lossJ = Math.min(roomJ, (energy * massI) / mass)
        ramBudget[i] = (ramBudget[i] ?? 0) + lossI
        ramBudget[j] = (ramBudget[j] ?? 0) + lossJ
        state.ram += hurt(ships, i, lossI)
        state.ram += hurt(ships, j, lossJ)
      }
      ships.x[i] = (ships.x[i] ?? 0) - nx * overlap * shareI
      ships.y[i] = (ships.y[i] ?? 0) - ny * overlap * shareI
      ships.x[j] = (ships.x[j] ?? 0) + nx * overlap * shareJ
      ships.y[j] = (ships.y[j] ?? 0) + ny * overlap * shareJ
    }
  }
}

function hurt(ships: SimState['ships'], index: number, amount: number): number {
  const before = ships.hp[index] ?? 0
  if (before <= 0 || ships.alive[index] === 0) return 0
  const dealt = Math.min(before, amount)
  ships.hp[index] = before - dealt
  ships.flash[index] = 1
  return dealt
}
