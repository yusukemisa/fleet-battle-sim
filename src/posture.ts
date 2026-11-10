import { anchorPace, CLASS_MODS, CLASS_STATS, classIndex, MANEUVER } from './balance.ts'
import type { PostureWeights } from './commanders.ts'
import { COMMANDERS, lightDuty } from './commanders.ts'
import { aimUnderThreat, wideFlankGoal } from './threat.ts'
import { stepDivision, tacticById, wheelDivision } from './tactics.ts'
import type { CommanderId, Division, Fleet, ManeuverId, SideId, SimState, TacticContext, TacticId } from './types.ts'
import { MANEUVER_IDS } from './types.ts'

export interface Situation {
  enveloped: boolean
  exposed: boolean
  exposedSign: number
  prey: number
  wider: boolean
  ratio: number
  flankThreatened: boolean
  threatSign: number
  contact: boolean
  weakAngle: number
  ownX: number
  ownY: number
  enemyX: number
  enemyY: number
}

function hypot(x: number, y: number): number {
  return Math.hypot(x, y)
}

function steer(div: Division, mx: number, my: number, speed: number, dt: number): void {
  const len = hypot(mx, my)
  let tvx = 0
  let tvy = 0
  const paced = speed * anchorPace(div)
  if (len > 0.8 && paced > 0) {
    tvx = (mx / len) * paced
    tvy = (my / len) * paced
  }
  const a = 1 - Math.exp(-1.7 * dt)
  div.vx += (tvx - div.vx) * a
  div.vy += (tvy - div.vy) * a
  div.ax += div.vx * dt
  div.ay += div.vy * dt
}

function face(div: Division, tx: number, ty: number, dt: number): void {
  const aimed = aimUnderThreat(div, tx, ty)
  let fx = aimed.x - div.ax
  let fy = aimed.y - div.ay
  const len = hypot(fx, fy)
  if (len < 1e-4) return
  fx /= len
  fy /= len
  const a = 1 - Math.exp(-2.4 * CLASS_MODS[div.classId].turn * dt)
  div.fx += (fx - div.fx) * a
  div.fy += (fy - div.fy) * a
  const fl = hypot(div.fx, div.fy) || 1
  div.fx /= fl
  div.fy /= fl
  div.rx = div.fy
  div.ry = -div.fx
}

function drive(div: Division, gx: number, gy: number, faceX: number, faceY: number, speed: number, dt: number): void {
  const dx = gx - div.ax
  const dy = gy - div.ay
  const dist = hypot(dx, dy)
  const spd = dist < 28 ? Math.min(speed * 0.35, dist) : speed
  div.markX = gx
  div.markY = gy
  div.sweeping = false
  div.shaped = true
  div.focus = false
  steer(div, dx, dy, spd, dt)
  face(div, faceX, faceY, dt)
}

function divisionsOf(state: SimState, side: SideId): Division[] {
  const found: Division[] = []
  for (const division of state.divisions) {
    if (division.side === side && division.alive > 0) found.push(division)
  }
  return found
}

function exposure(div: Division, fromX: number, fromY: number): { zone: number; sign: number; dist: number } {
  const dx = fromX - div.ax
  const dy = fromY - div.ay
  const dist = hypot(dx, dy) || 1
  const dot = (dx / dist) * div.fx + (dy / dist) * div.fy
  const cross = dx * div.fy - dy * div.fx
  const zone = dot <= -0.35 ? 2 : dot < 0.45 ? 1 : 0
  const sign = cross === 0 ? 1 : Math.sign(cross)
  return { zone, sign, dist }
}

function span(list: readonly Division[], ox: number, oy: number, fx: number, fy: number): number {
  let width = 0
  const rx = fy
  const ry = -fx
  for (const division of list) {
    const lateral = Math.abs((division.ax - ox) * rx + (division.ay - oy) * ry)
    if (lateral > width) width = lateral
  }
  return width
}

export function assess(
  state: SimState,
  side: SideId,
  focus?: { ownX: number; ownY: number; enemyX: number; enemyY: number },
): Situation {
  const enemy: SideId = side === 0 ? 1 : 0
  const ownX = focus?.ownX ?? state.centroidX[side] ?? 0
  const ownY = focus?.ownY ?? state.centroidY[side] ?? 0
  const enemyX = focus?.enemyX ?? state.centroidX[enemy] ?? 0
  const enemyY = focus?.enemyY ?? state.centroidY[enemy] ?? 0
  const toX = enemyX - ownX
  const toY = enemyY - ownY
  const dist = hypot(toX, toY) || 1
  const fx = toX / dist
  const fy = toY / dist
  const own = divisionsOf(state, side)
  const theirs = divisionsOf(state, enemy)
  let left = 0
  let right = 0
  let back = 0
  for (const division of theirs) {
    const rdx = division.ax - ownX
    const rdy = division.ay - ownY
    if (hypot(rdx, rdy) > 560) continue
    const along = rdx * fx + rdy * fy
    const cross = rdx * fy - rdy * fx
    if (along < -70) back += division.alive
    if (cross > 90) left += division.alive
    else if (cross < -90) right += division.alive
  }
  let weakAngle = 0
  let weakThreat = Infinity
  for (let k = 0; k < 8; k++) {
    const ang = -Math.PI + k * (Math.PI / 4)
    const dx = Math.cos(ang)
    const dy = Math.sin(ang)
    let threat = 0
    for (const division of theirs) {
      const along = (division.ax - ownX) * dx + (division.ay - ownY) * dy
      const lat = Math.abs((division.ax - ownX) * -dy + (division.ay - ownY) * dx)
      if (along > -40 && lat < 200) threat += division.alive / Math.max(90, along)
    }
    if (threat < weakThreat) {
      weakThreat = threat
      weakAngle = ang
    }
  }
  let prey = -1
  let preyZone = -1
  let preyMid = Infinity
  let exposedSign = 1
  for (let index = 0; index < state.divisions.length; index++) {
    const division = state.divisions[index]
    if (!division || division.side !== enemy || division.alive === 0) continue
    const seen = exposure(division, ownX, ownY)
    const mid = hypot(division.ax - enemyX, division.ay - enemyY)
    if (seen.zone > preyZone || (seen.zone === preyZone && mid < preyMid)) {
      preyZone = seen.zone
      preyMid = mid
      prey = index
      exposedSign = seen.sign
    }
  }
  let flankThreatened = false
  let threatSign = 1
  let threatDist = Infinity
  for (const division of theirs) {
    const dx = division.ax - ownX
    const dy = division.ay - ownY
    const d = hypot(dx, dy)
    if (d > 780) continue
    const forward = (dx / d) * fx + (dy / d) * fy
    const cross = dx * fy - dy * fx
    if (Math.abs(forward) > 0.55) continue
    const toward = -dx * division.fx - dy * division.fy
    if (toward <= 0 || d >= threatDist) continue
    flankThreatened = true
    threatDist = d
    threatSign = cross === 0 ? 1 : Math.sign(cross)
  }
  return {
    enveloped: left >= 4 && right >= 4 && back >= 4,
    exposed: preyZone >= 1,
    exposedSign,
    prey,
    wider: span(own, ownX, ownY, fx, fy) > span(theirs, enemyX, enemyY, fx, fy) * 1.2,
    ratio: state.alive[side] / Math.max(1, state.alive[enemy]),
    flankThreatened,
    threatSign,
    contact: dist < MANEUVER.contact,
    weakAngle,
    ownX,
    ownY,
    enemyX,
    enemyY,
  }
}

function weight(id: ManeuverId, sit: Situation, posture: PostureWeights): number {
  let score = posture[id]
  if (id === 'breakout' && sit.enveloped && !sit.wider) score += 8
  if (id === 'reform' && sit.ratio < 0.75 && !sit.enveloped) score += 6
  if (id === 'reform' && sit.enveloped) score += 2
  if (id === 'seize' && sit.exposed) score += 5
  if (id === 'envelop' && sit.wider && sit.exposed) score += 4
  if (id === 'refuse' && sit.flankThreatened && !sit.enveloped) score += 4
  if (id === 'press' && sit.ratio > 1.05 && !sit.enveloped && !sit.exposed) score += 3
  if (id === 'wheel' && sit.contact && !sit.enveloped && !sit.exposed && !sit.flankThreatened) score += 2
  return score
}

export function selectManeuver(posture: PostureWeights, sit: Situation, current: ManeuverId, committed: boolean): ManeuverId {
  const rank: Record<ManeuverId, number> = {
    breakout: 7,
    seize: 6,
    envelop: 5,
    press: 4,
    refuse: 3,
    reform: 2,
    wheel: 1,
  }
  let best: ManeuverId = 'press'
  let bestScore = -Infinity
  for (const id of MANEUVER_IDS) {
    const score = weight(id, sit, posture)
    if (score > bestScore || (score === bestScore && rank[id] > rank[best])) {
      bestScore = score
      best = id
    }
  }
  if (!committed) return best
  const emergency = sit.enveloped && current !== 'breakout' && current !== 'reform'
  if (emergency) return best
  const currentScore = weight(current, sit, posture)
  if (currentScore * MANEUVER.stick >= bestScore) return current
  return best
}

function slotOffset(slot: number): number {
  return (slot - 2) * MANEUVER.lane
}

function stepPlaced(div: Division, sit: Situation, fleetManeuver: ManeuverId, dt: number): void {
  const dx = sit.enemyX - sit.ownX
  const dy = sit.enemyY - sit.ownY
  const span = hypot(dx, dy) || 1
  const fx = dx / span
  const fy = dy / span
  const lx = -fy
  const ly = fx
  const across = slotOffset(div.slot) * CLASS_MODS[div.classId].wing
  if (fleetManeuver === 'reform' || (fleetManeuver === 'refuse' && !sit.flankThreatened)) {
    drive(
      div,
      sit.enemyX - fx * MANEUVER.reform + lx * across,
      sit.enemyY - fy * MANEUVER.reform + ly * across,
      sit.enemyX,
      sit.enemyY,
      34,
      dt,
    )
    return
  }
  if (fleetManeuver === 'refuse') {
    const wing = Math.sign(across) || sit.threatSign
    const pull = wing === sit.threatSign ? 200 : 30
    drive(
      div,
      sit.ownX - fx * pull + lx * across,
      sit.ownY - fy * pull + ly * across,
      sit.enemyX,
      sit.enemyY,
      30,
      dt,
    )
    return
  }
  if (fleetManeuver === 'breakout') {
    const dirX = Math.cos(sit.weakAngle)
    const dirY = Math.sin(sit.weakAngle)
    const px = -dirY
    const py = dirX
    const side = slotOffset(div.slot)
    drive(
      div,
      sit.ownX + dirX * MANEUVER.breakOut + px * side,
      sit.ownY + dirY * MANEUVER.breakOut + py * side,
      sit.enemyX,
      sit.enemyY,
      36,
      dt,
    )
    div.focus = true
    return
  }
  if (fleetManeuver === 'press') {
    drive(
      div,
      sit.enemyX - fx * 640 + lx * across,
      sit.enemyY - fy * 640 + ly * across,
      sit.enemyX,
      sit.enemyY,
      48,
      dt,
    )
    return
  }
  drive(div, sit.enemyX - fx * 500 + lx * across, sit.enemyY - fy * 500 + ly * across, sit.enemyX, sit.enemyY, 40, dt)
}

export function stepPlan(state: SimState, div: Division, dt: number): void {
  const side = div.side
  const multi = state.fleets.length > 2
  const fleet = (multi ? state.fleets[div.fleet] : state.fleets[side]) ?? state.fleets[side]
  if (!fleet) return
  const enemy: SideId = side === 0 ? 1 : 0
  const enemyFleet = multi ? state.fleets[fleet.enemyFleet] : undefined
  const ownX = multi ? fleet.meanX : (state.centroidX[side] ?? 0)
  const ownY = multi ? fleet.meanY : (state.centroidY[side] ?? 0)
  const enemyX = multi ? (enemyFleet?.meanX ?? state.centroidX[enemy] ?? 0) : (state.centroidX[enemy] ?? 0)
  const enemyY = multi ? (enemyFleet?.meanY ?? state.centroidY[enemy] ?? 0) : (state.centroidY[enemy] ?? 0)
  const ctx: TacticContext = {
    divisions: state.divisions,
    ownX,
    ownY,
    enemyX,
    enemyY,
    sweepLeg: fleet.sweepLeg,
  }
  const sit = multi ? assess(state, side, { ownX, ownY, enemyX, enemyY }) : assess(state, side)
  const apart = hypot(sit.enemyX - sit.ownX, sit.enemyY - sit.ownY)
  const onMission = div.tacticId === 'flank' || div.tacticId === 'broadside' || div.tacticId === 'rear' || div.tacticId === 'feint'
  if (onMission && fleet.maneuver !== 'breakout') {
    stepDivision(div, ctx, dt, false)
    return
  }
  if (fleet.maneuver === 'wheel' && apart < 700) {
    wheelDivision(div, ctx, dt)
    div.shaped = false
    return
  }
  const guns = CLASS_STATS[classIndex(div.classId)] ?? state.stats
  const bow = guns.batteries[0]
  const sideGun = guns.batteries[1]
  const bowMin = bow?.minRange ?? 280
  const sideMax = sideGun?.maxRange ?? 420
  const prey = state.divisions[fleet.prey >= 0 ? fleet.prey : sit.prey]
  const onFlank = fleet.maneuver === 'seize' || fleet.maneuver === 'envelop'
  if (onFlank && prey && prey.alive > 0 && prey.side !== side && apart < (bow?.maxRange ?? 900) + 120) {
    const wide = wideFlankGoal(div, prey, 'side')
    if (!wide.pocket) {
      drive(div, wide.x, wide.y, prey.ax, prey.ay, 40, dt)
      return
    }
    // Outside the bow arc: point our front at their exposed beam.
    const s = fleet.bias || sit.exposedSign || 1
    const fore = slotOffset(div.slot)
    const reach = Math.min(400 * CLASS_MODS[div.classId].wing, (sideGun?.maxRange ?? 420) * 0.9)
    const gx = prey.ax + prey.fx * fore + prey.rx * s * reach
    const gy = prey.ay + prey.fy * fore + prey.ry * s * reach
    drive(div, gx, gy, prey.ax, prey.ay, 38, dt)
    return
  }
  if (fleet.maneuver !== 'breakout' && apart < bowMin + 10) {
    if (div.broadsideOk) presentBroadside(div, sit.enemyX, sit.enemyY, fleet.bias || 1, Math.min(sideMax * 0.72, 300), dt)
    else drive(div, div.ax, div.ay, sit.enemyX, sit.enemyY, 0, dt)
    return
  }
  if (apart > bowMin + 200) {
    stepPlaced(div, sit, 'press', dt)
    return
  }
  stepPlaced(div, sit, fleet.maneuver, dt)
}

function presentBroadside(div: Division, ox: number, oy: number, sign: number, range: number, dt: number): void {
  const dx = ox - div.ax
  const dy = oy - div.ay
  const dist = hypot(dx, dy) || 1
  const fx = dx / dist
  const fy = dy / dist
  const lx = -fy
  const ly = fx
  const s = sign || 1
  const hx = -fy * s
  const hy = fx * s
  const across = slotOffset(div.slot) * CLASS_MODS[div.classId].wing
  const gx = ox - fx * range + lx * across
  const gy = oy - fy * range + ly * across
  drive(div, gx, gy, gx + hx * 180, gy + hy * 180, 36, dt)
}

export function updatePlan(state: SimState, side: SideId, fleetIndex?: number): void {
  const fleet = state.fleets[fleetIndex ?? side]
  if (!fleet || fleet.ships <= 0) return
  const commander = COMMANDERS[fleet.commanderId]
  if (!commander.auto) return
  const enemyFleet = state.fleets[fleet.enemyFleet]
  const sit =
    fleetIndex === undefined
      ? assess(state, side)
      : assess(state, fleet.side, {
          ownX: fleet.meanX,
          ownY: fleet.meanY,
          enemyX: enemyFleet?.meanX ?? state.centroidX[fleet.side === 0 ? 1 : 0] ?? 0,
          enemyY: enemyFleet?.meanY ?? state.centroidY[fleet.side === 0 ? 1 : 0] ?? 0,
        })
  const committed = state.time < fleet.maneuverUntil
  const next = selectManeuver(commander.posture, sit, fleet.maneuver, committed)
  if (next !== fleet.maneuver || state.time >= fleet.maneuverUntil) {
    if (next !== fleet.maneuver) {
      for (const division of state.divisions) {
        if (fleetIndex === undefined ? division.side !== side : division.fleet !== fleet.index) continue
        division.phase = 0
        division.phaseT = 0
        division.sweepLocked = false
      }
    }
    fleet.maneuver = next
    fleet.maneuverUntil = state.time + commander.posture.commit
    fleet.bias = sit.exposedSign || 1
  }
  if (commander.id === 'balanced') commitPrey(state, fleet.side, fleetIndex)
  else {
    const preyAlive = (state.divisions[fleet.prey]?.alive ?? 0) > 0
    if (sit.prey >= 0 && (!preyAlive || !committed)) fleet.prey = sit.prey
  }
  chooseCounter(state, fleet, sit)
  directLights(state, fleet.side, fleetIndex)
}

/**
 * A fierce fleet is rushing when it still faces us and its battleships are closing.
 * The opening second has no velocity yet, so facing alone is enough to lock a plan.
 */
function rushAxis(state: SimState, fleet: Fleet, sit: Situation): boolean {
  const foe = state.fleets[fleet.enemyFleet]
  if (!foe || foe.commanderId !== 'fierce') return false
  const dx = sit.ownX - sit.enemyX
  const dy = sit.ownY - sit.enemyY
  const dist = hypot(dx, dy) || 1
  const facing = foe.facingX * (dx / dist) + foe.facingY * (dy / dist)
  if (facing < 0.15) return false
  if (state.time < 1.5) return true
  let closing = 0
  let seen = 0
  for (const division of state.divisions) {
    if (division.fleet !== foe.index || division.alive === 0 || division.classId !== 'battleship') continue
    closing += (-division.vx * dx - division.vy * dy) / dist
    seen += 1
  }
  return seen === 0 || closing > 8
}

/** Pick one counter and keep it. Only 方円 and 鶴翼 against a rush leave the normal line. */
function chooseCounter(state: SimState, fleet: Fleet, sit: Situation): void {
  if (fleet.commanderId !== 'balanced') return
  if (fleet.plan !== 'none' && state.time < fleet.planUntil) return
  if (state.time > 6 && fleet.plan !== 'none') return
  const foe = state.fleets[fleet.enemyFleet]
  let next: Fleet['plan'] = 'none'
  if (foe && rushAxis(state, fleet, sit)) {
    if (fleet.formationId === 'houen' && foe.formationId === 'gyorin') next = 'spear'
    else if (fleet.formationId === 'houen' && foe.formationId === 'hoshi') next = 'offset'
    else if (fleet.formationId === 'houen' && foe.formationId !== 'houen') next = 'ring'
    else if (fleet.formationId === 'kakuyoku') next = 'crane'
  }
  if (next === fleet.plan) return
  fleet.plan = next
  fleet.planUntil = state.time + 18
}

function setDuty(state: SimState, div: Division, tactic: TacticId): void {
  if (div.tacticId === tactic) return
  div.tacticId = tactic
  div.phase = 0
  div.phaseT = 0
  div.holdArmed = false
  div.focus = tactic === 'focus'
  const fleet = state.fleets[div.side]
  state.log.push(`${fleet.name} ${div.name}: ${tacticById(tactic).name}に切替`)
  if (state.log.length > 8) state.log.shift()
}

/** Destroyers either duck under a battleship's bow or stand in front of our own. */
function directLights(state: SimState, side: SideId, fleetIndex?: number): void {
  const commander = state.fleets[fleetIndex ?? side]?.commanderId
  if (!commander) return
  const enemy: SideId = side === 0 ? 1 : 0
  let ownBb: Division | undefined
  const enemyBbs: Division[] = []
  const enemyDds: Division[] = []
  for (const division of state.divisions) {
    if (division.alive === 0) continue
    if (division.side === side && division.classId === 'battleship' && (fleetIndex === undefined || division.fleet === fleetIndex)) {
      ownBb = division
    }
    if (division.side === enemy && division.classId === 'battleship') enemyBbs.push(division)
    if (division.side === enemy && division.classId === 'destroyer') enemyDds.push(division)
  }
  const incoming = enemyDds.filter((division) => {
    if (!ownBb) return false
    return Math.hypot(division.ax - ownBb.ax, division.ay - ownBb.ay) < 820
  }).length
  const enemyScreenHome =
    enemyDds.length > 0 &&
    enemyDds.some((division) => {
      let near = Infinity
      for (const bb of enemyBbs) {
        const dist = Math.hypot(division.ax - bb.ax, division.ay - bb.ay)
        if (dist < near) near = dist
      }
      return near < 380
    })
  const threats = enemyDds.slice().sort((a, b) => {
    if (!ownBb) return 0
    return Math.hypot(a.ax - ownBb.ax, a.ay - ownBb.ay) - Math.hypot(b.ax - ownBb.ax, b.ay - ownBb.ay)
  })
  let threatAt = 0
  const prey = enemyBbs[0]
  for (const division of state.divisions) {
    if (division.side !== side || division.alive === 0 || division.classId === 'battleship') continue
    if (fleetIndex !== undefined && division.fleet !== fleetIndex) continue
    const duty = lightDuty(commander, division.classId, incoming, enemyScreenHome, division.slot)
    const home = state.fleets[fleetIndex ?? side]
    const foeCommander = enemyBbs[0] ? state.fleets[enemyBbs[0].fleet]?.commanderId : undefined
    if (home && commander === 'balanced' && home.formationId === 'houen' && foeCommander !== 'guard') home.cover = true
    if (home?.cover && commander === 'balanced') {
      for (const heavy of state.divisions) {
        if (heavy.side !== side || heavy.classId !== 'battleship') continue
        if (fleetIndex !== undefined && heavy.fleet !== fleetIndex) continue
        heavy.screen = true
        if (home.plan === 'ring') heavy.phase = 5
        else if (home.plan === 'spear') heavy.phase = 7
        else if (home.plan === 'offset') heavy.phase = 8
      }
    }
    if (commander === 'balanced' && home?.plan === 'crane' && division.classId === 'destroyer' && ownBb && enemyBbs[0]) {
      const preyBb = enemyBbs[0]
      const fx = preyBb.ax - ownBb.ax
      const fy = preyBb.ay - ownBb.ay
      const flen = Math.hypot(fx, fy) || 1
      const lead = ((division.ax - ownBb.ax) * fx + (division.ay - ownBb.ay) * fy) / flen
      const rushRange = Math.hypot(preyBb.ax - ownBb.ax, preyBb.ay - ownBb.ay)
      if (lead > 80) {
        division.screen = true
        division.headOn = false
        division.standoff = false
        const threat = threats[0]
        division.hunt = threat ? state.divisions.indexOf(threat) : -1
        setDuty(state, division, 'flank')
        division.phase = 4
        continue
      }
      if (rushRange > 760) {
        division.screen = true
        division.headOn = false
        division.standoff = false
        const threat = threats[0]
        division.hunt = threat ? state.divisions.indexOf(threat) : -1
        setDuty(state, division, 'flank')
        division.phase = 0
        continue
      }
      if (division.phase === 4) division.phase = 0
    }
    if (commander === 'balanced' && home?.cover) {
      division.screen = true
      division.headOn = false
      division.standoff = true
      const threat = threats[0]
      division.hunt = threat ? state.divisions.indexOf(threat) : -1
      setDuty(state, division, 'flank')
      continue
    }
    if (commander === 'balanced' && ownBb && enemyBbs[0]) {
      const preyBb = enemyBbs[0]
      const fx = preyBb.ax - ownBb.ax
      const fy = preyBb.ay - ownBb.ay
      const flen = Math.hypot(fx, fy) || 1
      const lead = ((division.ax - ownBb.ax) * fx + (division.ay - ownBb.ay) * fy) / flen
      if (lead > 100) {
        division.screen = true
        division.headOn = false
        const threat = threats[0]
        division.hunt = threat ? state.divisions.indexOf(threat) : -1
        setDuty(state, division, 'flank')
        continue
      }
    }
    if (duty === 'screen') {
      division.screen = true
      division.headOn = false
      const threat = threats[threatAt] ?? threats[0]
      if (threat) threatAt += 1
      division.hunt = threat ? state.divisions.indexOf(threat) : -1
      setDuty(state, division, 'flank')
      continue
    }
    division.screen = false
    division.headOn = duty === 'under' && commander === 'fierce'
    division.hunt = prey ? state.divisions.indexOf(prey) : -1
    setDuty(state, division, duty === 'under' ? 'rear' : 'broadside')
  }
}

function preyValue(division: Division, enemyCommander: CommanderId, ex: number, ey: number, ox: number, oy: number): number {
  const roster = Math.max(1, division.roster)
  const hurt = 1 - division.alive / roster
  const weight = division.classId === 'battleship' ? 5 : division.classId === 'cruiser' ? 2.1 : 0.75
  let score = weight * (0.6 + hurt)
  if (hurt >= 0.28 && weight >= 2) score += 2.4
  const isolated = Math.hypot(division.ax - ex, division.ay - ey)
  if (enemyCommander === 'fierce' && division.classId === 'battleship') score += 2.2
  if (enemyCommander === 'guard' && (division.slot === 0 || division.slot === 4)) score += 0.6
  if (enemyCommander === 'cunning' && isolated > 160 && division.classId !== 'battleship') score += 1.15
  const dist = Math.hypot(division.ax - ox, division.ay - oy)
  const flanking =
    division.tacticId === 'flank' ||
    division.tacticId === 'broadside' ||
    division.tacticId === 'rear' ||
    division.tacticId === 'encircle'
  if (flanking && dist < 620 && division.classId !== 'battleship') score += 1.8
  return score
}

/** One enemy division at a time. Stick with it until it is almost gone. */
function commitPrey(state: SimState, side: SideId, fleetIndex?: number): void {
  const fleet = state.fleets[fleetIndex ?? side]
  if (!fleet) return
  const enemy: SideId = side === 0 ? 1 : 0
  const enemyCommander = state.fleets[enemy].commanderId
  const ex = state.centroidX[enemy] ?? 0
  const ey = state.centroidY[enemy] ?? 0
  const ox = state.centroidX[side] ?? 0
  const oy = state.centroidY[side] ?? 0
  let best = -1
  let bestScore = -Infinity
  for (let index = 0; index < state.divisions.length; index++) {
    const division = state.divisions[index]
    if (!division || division.side !== enemy || division.alive === 0) continue
    const score = preyValue(division, enemyCommander, ex, ey, ox, oy)
    if (score > bestScore) {
      bestScore = score
      best = index
    }
  }
  const current = state.divisions[fleet.prey]
  if (current && current.side === enemy && current.alive >= 4 && fleet.prey !== best) {
    const stuck = preyValue(current, enemyCommander, ex, ey, ox, oy)
    if (stuck >= bestScore * 0.82) best = fleet.prey
  }
  if (best >= 0) fleet.prey = best
  for (const division of state.divisions) {
    if (division.side !== side) continue
    if (fleetIndex !== undefined && division.fleet !== fleet.index) continue
    division.hunt = fleet.prey
    division.standoff = division.classId === 'battleship' && enemyCommander !== 'guard'
    division.rush = division.classId !== 'battleship'
  }
}
