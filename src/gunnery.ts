import { CLASS_STATS, GUNNERY, hullHp, type BatterySpec } from './balance.ts'
import { armorFactor, inArc, inBattery } from './combat.ts'
import { withdrawalFor } from './ranks.ts'
import { collectNear } from './spatial.ts'
import type { GunneryTally, SimState } from './types.ts'

export function emptyTally(): GunneryTally {
  return { shots: 0, hits: 0, damage: 0, overkill: 0, idle: 0, held: 0, wide: 0, deaths: 0, deathTime: 0 }
}

export function cacheSpread(state: SimState): void {
  const ships = state.ships
  let blue = 0
  let red = 0
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] === 0) continue
    const side = ships.side[i] === 1 ? 1 : 0
    const dx = (ships.x[i] ?? 0) - (state.centroidX[side] ?? 0)
    const dy = (ships.y[i] ?? 0) - (state.centroidY[side] ?? 0)
    const dist = Math.hypot(dx, dy)
    if (side === 0) blue = Math.max(blue, dist)
    else red = Math.max(red, dist)
  }
  state.scratch.spread[0] = blue
  state.scratch.spread[1] = red
}

function outOfReach(state: SimState, index: number): boolean {
  const ships = state.ships
  const side = ships.side[index] === 1 ? 1 : 0
  const enemy = side === 0 ? 1 : 0
  const dx = (state.centroidX[enemy] ?? 0) - (ships.x[index] ?? 0)
  const dy = (state.centroidY[enemy] ?? 0) - (ships.y[index] ?? 0)
  const reach = CLASS_STATS[ships.shipClass[index] ?? 0]?.range ?? state.stats.range
  const need = reach + (state.scratch.spread[enemy] ?? 0)
  return dx * dx + dy * dy > need * need
}

export function cacheBows(state: SimState): void {
  const ships = state.ships
  const scratch = state.scratch
  scratch.cosArc = Math.cos(state.stats.arc)
  scratch.cosBow = Math.cos(state.stats.armorBow)
  scratch.cosStern = Math.cos(state.stats.armorStern)
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] === 0) continue
    const heading = ships.heading[i] ?? 0
    scratch.bowX[i] = Math.cos(heading)
    scratch.bowY[i] = Math.sin(heading)
  }
}

function rangeScale(dist: number, range: number): number {
  if (GUNNERY.falloff <= 0) return 1
  return Math.max(GUNNERY.falloffFloor, 1 - (dist / range) * GUNNERY.falloff)
}

export function batteryCooldown(state: SimState, index: number, battery: number): number {
  const ships = state.ships
  if (battery === 0) return ships.cooldown[index] ?? 0
  return ships.gunCd[index * 2 + (battery - 1)] ?? 0
}

export function setBatteryCooldown(state: SimState, index: number, battery: number, value: number): void {
  const ships = state.ships
  if (battery === 0) ships.cooldown[index] = value
  else ships.gunCd[index * 2 + (battery - 1)] = value
}

/** Best target for one battery. `legacy` keeps the nearest hull instead of the highest expected damage. */
export function pickBatteryTarget(
  state: SimState,
  index: number,
  battery: BatterySpec,
  found: Int32Array,
  n: number,
  legacy: boolean,
): number {
  const ships = state.ships
  const stats = state.stats
  const scratch = state.scratch
  const sx = ships.x[index] ?? 0
  const sy = ships.y[index] ?? 0
  const hx = scratch.bowX[index] ?? 1
  const hy = scratch.bowY[index] ?? 0
  const side = ships.side[index] === 1 ? 1 : 0
  const policy = ships.falling[index] === 1 ? withdrawalFor(state, side) : null
  if (policy && (scratch.exposed[index] ?? 0) > policy.threat) return -1
  const division = state.divisions[ships.division[index] ?? 0]
  const focus = division?.focus === true
  const scale = (state.damage[side] ?? stats.damage) / Math.max(0.01, stats.damage)
  const volley = battery.guns * battery.power * scale
  const prefer = state.maneuver === 'shaped' ? (ships.target[index] ?? -1) : -1
  let preferScore = -Infinity
  let best = -1
  let bestScore = -Infinity
  let fallback = -1
  let fallbackScore = -Infinity
  for (let k = 0; k < n; k++) {
    const other = found[k] ?? -1
    if (other < 0 || ships.alive[other] === 0 || ships.side[other] === side) continue
    const ox = ships.x[other] ?? 0
    const oy = ships.y[other] ?? 0
    if (!inBattery(hx, hy, sx, sy, ox, oy, battery)) continue
    const dist = Math.hypot(ox - sx, oy - sy)
    if (legacy) {
      const score = -dist
      if (score > bestScore || (score === bestScore && other < best)) {
        bestScore = score
        best = other
      }
      continue
    }
    const victim = CLASS_STATS[ships.shipClass[other] ?? 0] ?? stats
    const factor = armorFactor(
      scratch.bowX[other] ?? 1,
      scratch.bowY[other] ?? 0,
      ox,
      oy,
      sx,
      sy,
      victim,
      scratch.cosBow,
      scratch.cosStern,
    )
    const heat = policy ? (scratch.exposed[index] ?? 0) : 0
    if (policy && heat > 0 && factor + 1e-6 < policy.shot) continue
    const hp = ships.hp[other] ?? 0
    const queued = scratch.incoming[other] ?? 0
    const hpLeft = (scratch.opened[other] ?? hp) - queued
    const blow = volley * factor * stats.hitChance * rangeScale(dist, battery.maxRange)
    if (hpLeft <= 0) {
      const score = hpLeft - dist * GUNNERY.near
      if (score > fallbackScore || (score === fallbackScore && (fallback < 0 || other < fallback))) {
        fallbackScore = score
        fallback = other
      }
      continue
    }
    const killing = blow >= hpLeft
    const finish = killing ? GUNNERY.finish : 1
    const low = 1 + GUNNERY.lowHp * (1 - hp / Math.max(1, hullHp(ships.shipClass[other] ?? 0, state.stats.hp)))
    let score = blow * finish * low
    if (focus && division) {
      const fd = Math.hypot(ox - division.focusX, oy - division.focusY)
      score /= 1 + fd * GUNNERY.focus
    }
    if (division && division.hunt >= 0 && (ships.division[other] ?? -1) === division.hunt) score *= 3
    score -= dist * GUNNERY.near
    if (other === prefer && battery.id === 'bow') preferScore = score
    if (score > bestScore || (score === bestScore && other < best)) {
      bestScore = score
      best = other
    }
  }
  if (battery.id === 'bow' && best >= 0 && preferScore > 0 && prefer >= 0 && preferScore * GUNNERY.stick >= bestScore) {
    return prefer
  }
  if (best >= 0) return best
  if (policy) return -1
  return fallback
}

/** Best in-arc target by expected damage, or -1 when a withdrawing ship should hold fire. */
export function pickTarget(state: SimState, index: number): number {
  const ships = state.ships
  const stats = CLASS_STATS[ships.shipClass[index] ?? 0] ?? state.stats
  const scratch = state.scratch
  const sx = ships.x[index] ?? 0
  const sy = ships.y[index] ?? 0
  const side = ships.side[index] === 1 ? 1 : 0
  if (outOfReach(state, index)) return -1
  const policy = ships.falling[index] === 1 ? withdrawalFor(state, side) : null
  const heat = policy ? (scratch.exposed[index] ?? 0) : 0
  if (policy && heat > policy.threat) return -1
  const hx = scratch.bowX[index] ?? 1
  const hy = scratch.bowY[index] ?? 0
  const range = stats.range
  const rangeSq = range * range
  const n = collectNear(scratch.hash, sx, sy, range, ships.x, ships.y)
  const found = scratch.hash.found
  const division = state.divisions[ships.division[index] ?? 0]
  const focus = division?.focus === true
  const damage = state.damage[side]
  const prefer = state.maneuver === 'shaped' ? (ships.target[index] ?? -1) : -1
  let preferScore = -Infinity
  let best = -1
  let bestScore = -Infinity
  let fallback = -1
  let fallbackScore = -Infinity
  for (let k = 0; k < n; k++) {
    const other = found[k] ?? -1
    if (other < 0 || ships.alive[other] === 0 || ships.side[other] === side) continue
    const ox = ships.x[other] ?? 0
    const oy = ships.y[other] ?? 0
    const dx = ox - sx
    const dy = oy - sy
    const d2 = dx * dx + dy * dy
    if (d2 > rangeSq || d2 < 1e-6) continue
    const forward = dx * hx + dy * hy
    if (forward <= 0) continue
    const cosArc = Math.cos(stats.arc)
    if (forward * forward < d2 * cosArc * cosArc) continue
    const dist = Math.sqrt(d2)
    const victim = CLASS_STATS[ships.shipClass[other] ?? 0] ?? stats
    const factor = armorFactor(
      scratch.bowX[other] ?? 1,
      scratch.bowY[other] ?? 0,
      ox,
      oy,
      sx,
      sy,
      victim,
      scratch.cosBow,
      scratch.cosStern,
    )
    if (policy && heat > 0 && factor + 1e-6 < policy.shot) continue
    const hp = ships.hp[other] ?? 0
    const queued = scratch.incoming[other] ?? 0
    const hpLeft = (scratch.opened[other] ?? hp) - queued
    const blow = damage * factor * stats.hitChance * rangeScale(dist, range)
    if (hpLeft <= 0) {
      const score = hpLeft - dist * GUNNERY.near
      if (score > fallbackScore || (score === fallbackScore && (fallback < 0 || other < fallback))) {
        fallbackScore = score
        fallback = other
      }
      continue
    }
    const killing = blow >= hpLeft
    const finish = killing ? GUNNERY.finish : 1
    const low = 1 + GUNNERY.lowHp * (1 - hp / Math.max(1, hullHp(ships.shipClass[other] ?? 0, state.stats.hp)))
    let score = blow * finish * low
    if (focus && division) {
      const fd = Math.hypot(ox - division.focusX, oy - division.focusY)
      score /= 1 + fd * GUNNERY.focus
    }
    if (division && division.hunt >= 0 && (ships.division[other] ?? -1) === division.hunt) score *= 3
    score -= dist * GUNNERY.near
    if (other === prefer) preferScore = score
    if (score > bestScore || (score === bestScore && other < best)) {
      bestScore = score
      best = other
    }
  }
  if (best >= 0 && preferScore > 0 && prefer >= 0 && preferScore * GUNNERY.stick >= bestScore) return prefer
  if (best >= 0) return best
  if (policy) return -1
  return fallback
}

/** Living enemy inside weapon range and the bow arc, ignoring armor and reservations. */
export function hasClearShot(state: SimState, index: number): boolean {
  const ships = state.ships
  const stats = CLASS_STATS[ships.shipClass[index] ?? 0] ?? state.stats
  const scratch = state.scratch
  if (outOfReach(state, index)) return false
  const sx = ships.x[index] ?? 0
  const sy = ships.y[index] ?? 0
  const side = ships.side[index]
  const hx = scratch.bowX[index] ?? 1
  const hy = scratch.bowY[index] ?? 0
  const rangeSq = stats.range * stats.range
  const n = collectNear(scratch.hash, sx, sy, stats.range, ships.x, ships.y)
  const found = scratch.hash.found
  for (let k = 0; k < n; k++) {
    const other = found[k] ?? -1
    if (other < 0 || ships.alive[other] === 0 || ships.side[other] === side) continue
    const ox = ships.x[other] ?? 0
    const oy = ships.y[other] ?? 0
    const dx = ox - sx
    const dy = oy - sy
    if (dx * dx + dy * dy > rangeSq) continue
    if (inArc(hx, hy, sx, sy, ox, oy, Math.cos(stats.arc))) return true
  }
  return false
}
