import { CLASS_MODS } from './balance.ts'
import type { CommanderId, Division, SideId, SimState } from './types.ts'

/**
 * Firepower density outranks holding the starting formation once a fleet is large.
 * The weights live in `OBJECTIVE` (src/brain/fitness.ts). This module is the rule
 * side of that objective: a wider fleet closes into a U, a compact or enveloped
 * fleet forms a spindle and shoots through one point, and a shredded line contracts.
 */
export const DENSITY = {
  /** Per side. Smaller fleets keep the existing orders so the 100-ship bars stay put. */
  minShips: 400,
  cruise: 22,
  fan: 16,
  /** How far the spindle stacks back from the point it is breaking. */
  column: 210,
  /** Wings of a U sit this far forward of the enemy centre. */
  wingReach: 160,
} as const

export type DensityShape = 'pincer' | 'spindle' | 'contract'

/**
 * 常勝 and 智将 read the geometry. 猛将 breaks through even when wider.
 * 守将 closes and holds, and only forms a spindle when already enveloped.
 */
export function chooseShape(commander: CommanderId, wider: boolean, enveloped: boolean, thin: boolean): DensityShape {
  if (commander === 'manual') return 'contract'
  if (commander === 'fierce') return 'spindle'
  if (commander === 'guard') return enveloped ? 'spindle' : thin && !wider ? 'contract' : 'pincer'
  if (wider && !enveloped) return 'pincer'
  if (thin && !enveloped) return 'contract'
  return 'spindle'
}

interface Frame {
  fx: number
  fy: number
  lx: number
  ly: number
}

function hypot(x: number, y: number): number {
  return Math.hypot(x, y)
}

function frame(ownX: number, ownY: number, enemyX: number, enemyY: number): Frame {
  const dx = enemyX - ownX
  const dy = enemyY - ownY
  const dist = hypot(dx, dy) || 1
  const fx = dx / dist
  const fy = dy / dist
  return { fx, fy, lx: -fy, ly: fx }
}

function lateral(div: Division, ox: number, oy: number, basis: Frame): number {
  return (div.ax - ox) * basis.lx + (div.ay - oy) * basis.ly
}

function forward(div: Division, ox: number, oy: number, basis: Frame): number {
  return (div.ax - ox) * basis.fx + (div.ay - oy) * basis.fy
}

function spanOf(list: readonly Division[], ox: number, oy: number, basis: Frame): number {
  let min = Infinity
  let max = -Infinity
  for (const div of list) {
    const across = lateral(div, ox, oy, basis)
    if (across < min) min = across
    if (across > max) max = across
  }
  if (!Number.isFinite(min)) return 0
  return max - min
}

function steer(div: Division, gx: number, gy: number, faceX: number, faceY: number, speed: number, dt: number): void {
  const dx = gx - div.ax
  const dy = gy - div.ay
  const len = hypot(dx, dy)
  const paced = speed * (CLASS_MODS[div.classId].speed || 1)
  let tvx = 0
  let tvy = 0
  if (len > 12 && paced > 0) {
    tvx = (dx / len) * Math.min(paced, len)
    tvy = (dy / len) * Math.min(paced, len)
  }
  const a = 1 - Math.exp(-1.7 * dt)
  div.vx += (tvx - div.vx) * a
  div.vy += (tvy - div.vy) * a
  div.ax += div.vx * dt
  div.ay += div.vy * dt
  div.shaped = true
  let fx = faceX - div.ax
  let fy = faceY - div.ay
  const fl = hypot(fx, fy)
  if (fl < 1e-4) return
  fx /= fl
  fy /= fl
  const turn = 1 - Math.exp(-2.2 * CLASS_MODS[div.classId].turn * dt)
  div.fx += (fx - div.fx) * turn
  div.fy += (fy - div.fy) * turn
  const norm = hypot(div.fx, div.fy) || 1
  div.fx /= norm
  div.fy /= norm
  div.rx = div.fy
  div.ry = -div.fx
}

/** 1 when the enemy fleet flagship is inside our longest bow range. */
export function flagThreat(state: SimState, side: SideId): number {
  const enemySide: SideId = side === 0 ? 1 : 0
  const fleet = state.fleets[enemySide]
  const flag = fleet?.flagship ?? -1
  if (flag < 0 || state.ships.alive[flag] !== 1) return 0
  const x = state.ships.x[flag] ?? 0
  const y = state.ships.y[flag] ?? 0
  for (const div of living(state, side)) {
    if (hypot(div.ax - x, div.ay - y) < 980) return 1
  }
  return 0
}

function living(state: SimState, side: SideId): Division[] {
  const found: Division[] = []
  for (const div of state.divisions) {
    if (div.side === side && div.alive > 0) found.push(div)
  }
  return found
}

function nearestGap(div: Division, enemy: readonly Division[]): number {
  let best = Infinity
  for (const other of enemy) {
    const dist = hypot(div.ax - other.ax, div.ay - other.ay)
    if (dist < best) best = dist
  }
  return best
}

function cruiseSpeed(gap: number): number {
  if (gap > 1500) return 30
  if (gap > 900) return 20
  return 12
}

function sameSideTarget(div: Division, enemy: readonly Division[], axis: Frame, ownX: number, ownY: number): Division {
  const mine = (div.ax - ownX) * axis.lx + (div.ay - ownY) * axis.ly
  let best = enemy[0]!
  let score = Infinity
  for (const other of enemy) {
    const across = (other.ax - ownX) * axis.lx + (other.ay - ownY) * axis.ly
    const crossed = mine * across < 0 ? 5000 : 0
    const dist = hypot(div.ax - other.ax, div.ay - other.ay) + crossed
    if (dist < score) {
      score = dist
      best = other
    }
  }
  return best
}
function weakest(enemy: readonly Division[], ox: number, oy: number, basis: Frame): Division | null {
  let best: Division | null = null
  let score = Infinity
  for (const div of enemy) {
    const across = Math.abs(lateral(div, ox, oy, basis))
    const value = div.alive + across * 0.015
    if (value < score) {
      score = value
      best = div
    }
  }
  return best
}

/** Share of this side's divisions whose bow is on an enemy division inside gun range. */
export function bearingShare(state: SimState, side: SideId): number {
  const own = living(state, side)
  const enemy = living(state, side === 0 ? 1 : 0)
  if (own.length === 0 || enemy.length === 0) return 0
  let bearing = 0
  for (const div of own) {
    let nearest = Infinity
    let nx = 0
    let ny = 0
    for (const other of enemy) {
      const dx = other.ax - div.ax
      const dy = other.ay - div.ay
      const dist = hypot(dx, dy)
      if (dist < nearest) {
        nearest = dist
        nx = dx
        ny = dy
      }
    }
    if (nearest > 980) continue
    const len = nearest || 1
    const dot = div.fx * (nx / len) + div.fy * (ny / len)
    if (dot > 0.72) bearing += 1
  }
  return bearing / own.length
}

/** Fraction of eight arcs around the enemy centre that contain one of our divisions. */
export function encirclement(state: SimState, side: SideId): number {
  const enemySide: SideId = side === 0 ? 1 : 0
  const own = living(state, side)
  const enemy = living(state, enemySide)
  if (own.length === 0 || enemy.length === 0) return 0
  let ex = 0
  let ey = 0
  let n = 0
  for (const div of enemy) {
    ex += div.ax
    ey += div.ay
    n += 1
  }
  ex /= n
  ey /= n
  const bins = new Uint8Array(8)
  for (const div of own) {
    const dx = div.ax - ex
    const dy = div.ay - ey
    if (hypot(dx, dy) > 1600) continue
    const arc = Math.atan2(dy, dx)
    const bin = Math.floor(((arc + Math.PI) / (Math.PI * 2)) * 8) % 8
    bins[bin] = 1
  }
  let filled = 0
  for (const bit of bins) filled += bit
  return filled / 8
}

/** 1 when a division has crossed the enemy centre along the approach. */
export function breakthrough(state: SimState, side: SideId): number {
  const enemySide: SideId = side === 0 ? 1 : 0
  const ownX = state.centroidX[side] ?? 0
  const ownY = state.centroidY[side] ?? 0
  const enemyX = state.centroidX[enemySide] ?? 0
  const enemyY = state.centroidY[enemySide] ?? 0
  const basis = frame(ownX, ownY, enemyX, enemyY)
  const line = hypot(enemyX - ownX, enemyY - ownY)
  for (const div of living(state, side)) {
    const along = forward(div, ownX, ownY, basis)
    if (along > line + 80) return 1
  }
  return 0
}

const committed = new WeakMap<SimState, { until: number; shape: [DensityShape, DensityShape]; written: number; basis: [Frame, Frame] }>()

function committedShape(state: SimState, side: SideId, next: DensityShape, basis: Frame): { shape: DensityShape; basis: Frame } {
  let row = committed.get(state)
  const bit = 1 << side
  if (!row || state.time >= row.until) {
    row = { until: state.time + 36, shape: [next, next], written: bit, basis: [basis, basis] }
    row.shape[side] = next
    row.basis[side] = basis
    committed.set(state, row)
    return { shape: next, basis }
  }
  if ((row.written & bit) === 0) {
    row.shape[side] = next
    row.basis[side] = basis
    row.written |= bit
  }
  return { shape: row.shape[side], basis: row.basis[side] }
}
function applyFleet(state: SimState, side: SideId, dt: number): void {
  const fleet = state.fleets[side]
  if (!fleet || fleet.commanderId === 'manual' || fleet.ships < DENSITY.minShips) return
  const enemySide: SideId = side === 0 ? 1 : 0
  const own = living(state, side)
  const enemy = living(state, enemySide)
  if (own.length === 0 || enemy.length === 0) return
  const ownX = state.centroidX[side] ?? 0
  const ownY = state.centroidY[side] ?? 0
  const enemyX = state.centroidX[enemySide] ?? 0
  const enemyY = state.centroidY[enemySide] ?? 0
  const basis = frame(ownX, ownY, enemyX, enemyY)
  const ownSpan = spanOf(own, ownX, ownY, basis)
  const enemySpan = spanOf(enemy, enemyX, enemyY, basis)
  const wider = ownSpan > enemySpan * 1.12
  let depth = 0
  for (const div of own) depth = Math.max(depth, Math.abs(forward(div, ownX, ownY, basis)))
  const thin = ownSpan > Math.max(400, depth) * 4.2
  let left = 0
  let right = 0
  for (const div of enemy) {
    const across = lateral(div, ownX, ownY, basis)
    const along = forward(div, ownX, ownY, basis)
    if (along < hypot(enemyX - ownX, enemyY - ownY) * 0.45) continue
    if (across < -80) left += 1
    else if (across > 80) right += 1
  }
  const enveloped = left >= 2 && right >= 2 && enemySpan > ownSpan * 0.9
  const plan = committedShape(state, side, chooseShape(fleet.commanderId, wider, enveloped, thin), basis)
  const shape = plan.shape
  const axis = plan.basis
  const strongest = own.reduce((best, div) => (div.alive > best.alive ? div : best), own[0]!)
  if (shape === 'spindle') {
    const target = weakest(enemy, enemyX, enemyY, basis)
    if (!target) return
    const ordered = [...own].sort((a, b) => hypot(a.ax - target.ax, a.ay - target.ay) - hypot(b.ax - target.ax, b.ay - target.ay))
    ordered.forEach((div, index) => {
      if (div.alive < div.roster * 0.15 && div !== strongest) {
        steer(div, strongest.ax, strongest.ay, enemyX, enemyY, cruiseSpeed(nearestGap(div, enemy)), dt)
        return
      }
      const past = (div.ax - target.ax) * axis.fx + (div.ay - target.ay) * axis.fy > 90
      const hole = target.alive < Math.max(8, target.roster * 0.4)
      if (past || hole) {
        const fan = (div.slot - 2) * (past ? 170 : 40)
        const beyond = past ? 280 : 60
        steer(
          div,
          target.ax + axis.fx * beyond + axis.lx * fan,
          target.ay + axis.fy * beyond + axis.ly * fan,
          target.ax,
          target.ay,
          DENSITY.fan,
          dt,
        )
        return
      }
      const back = index * DENSITY.column
      const nudge = (index % 2 === 0 ? -1 : 1) * 28
      const gx = target.ax - axis.fx * back + axis.lx * nudge
      const gy = target.ay - axis.fy * back + axis.ly * nudge
      const toGoal = hypot(div.ax - gx, div.ay - gy)
      const paced = toGoal > 800 ? 30 : toGoal > 280 ? 18 : 12
      steer(div, gx, gy, target.ax, target.ay, paced, dt)
    })
    return
  }
  if (shape === 'contract') {
    for (const div of own) {
      if (div.alive < div.roster * 0.15 && div !== strongest) {
        steer(div, strongest.ax, strongest.ay, enemyX, enemyY, DENSITY.cruise, dt)
        continue
      }
      const across = lateral(div, ownX, ownY, basis) * 0.62
      const along = forward(div, ownX, ownY, basis)
      steer(div, ownX + basis.fx * (along + 30) + basis.lx * across, ownY + basis.fy * (along + 30) + basis.ly * across, enemyX, enemyY, DENSITY.cruise, dt)
    }
    return
  }
  for (const div of own) {
    if (div.alive < div.roster * 0.15 && div !== strongest) {
      steer(div, strongest.ax, strongest.ay, enemyX, enemyY, DENSITY.cruise, dt)
      continue
    }
    const now = (div.ax - ownX) * axis.lx + (div.ay - ownY) * axis.ly
    const target = sameSideTarget(div, enemy, axis, ownX, ownY)
    const arm = Math.abs(div.slot - 2)
    const standoff = arm >= 2 ? 420 : arm === 1 ? 520 : 680
    const curl = now * (arm === 0 ? 0 : 0.22)
    const paced = cruiseSpeed(nearestGap(div, enemy))
    steer(
      div,
      target.ax - axis.fx * standoff - axis.lx * curl,
      target.ay - axis.fy * standoff - axis.ly * curl,
      target.ax,
      target.ay,
      paced,
      dt,
    )
  }
}

/** Reshape large fleets. Small fleets, including the win-rate suite, are unchanged. */
export function applyDensity(state: SimState, dt: number): void {
  if (state.maneuver !== 'shaped' || state.fleets.length > 2) return
  if ((state.alive[0] ?? 0) >= DENSITY.minShips) applyFleet(state, 0, dt)
  if ((state.alive[1] ?? 0) >= DENSITY.minShips) applyFleet(state, 1, dt)
}
