import { acquireSq, FIELD, rangeSq, SHIP_STATS, type ShipStats } from './balance.ts'
import { armorMultiplier, inFiringArc, wrapAngle } from './combat.ts'
import { chooseTactic, COMMANDERS, type BattleFacts, type Bearing } from './commanders.ts'
import { layoutFormation } from './formations.ts'
import { TACTICS, tacticById } from './tactics.ts'
import {
  DEFAULT_COMMANDER,
  DEFAULT_FORMATION,
  DIVISIONS_PER_SIDE,
  DIVISION_NAMES,
  type BattlePhase,
  type Command,
  type Division,
  type DivisionSlot,
  type SideId,
  type SimConfig,
  type SimState,
  type Speed,
  type TacticId,
} from './types.ts'

const FLEET_NAMES = ['青軍', '赤軍'] as const

export function createSim(config: SimConfig): SimState {
  const formations = config.formations ?? [DEFAULT_FORMATION, DEFAULT_FORMATION]
  const commanders = config.commanders ?? [DEFAULT_COMMANDER, DEFAULT_COMMANDER]
  const stats = shipStats(config)
  const damage: [number, number] = config.damage
    ? [config.damage[0], config.damage[1]]
    : [stats.damage, stats.damage]
  const state = allocate(config.shipCount, stats, damage)
  state.fleets[0].formationId = formations[0]
  state.fleets[1].formationId = formations[1]
  state.fleets[0].commanderId = commanders[0]
  state.fleets[1].commanderId = commanders[1]
  if (config.tactics) {
    for (let i = 0; i < state.divisions.length; i++) {
      const tacticId = config.tactics[i]
      const division = state.divisions[i]
      if (tacticId && division) division.tacticId = tacticId
    }
  }
  deploy(state)
  return state
}

export function dispatch(state: SimState, command: Command): SimState {
  switch (command.type) {
    case 'set-ship-count':
      if (state.phase.kind !== 'setup') return state
      if (command.count === state.shipCount) return state
      return createSim(configFrom(state, { shipCount: command.count }))
    case 'set-formation':
      if (state.phase.kind !== 'setup') return state
      state.fleets[command.side].formationId = command.formationId
      deploy(state)
      return state
    case 'set-commander':
      if (state.phase.kind !== 'setup') return state
      state.fleets[command.side].commanderId = command.commanderId
      return state
    case 'set-tactic':
      return applyTactic(state, command.division, command.tacticId)
    case 'set-side-tactic': {
      if (state.phase.kind === 'finished') return state
      const start = command.side * DIVISIONS_PER_SIDE
      for (let i = 0; i < DIVISIONS_PER_SIDE; i++) applyTactic(state, start + i, command.tacticId)
      return state
    }
    case 'start':
      if (state.phase.kind !== 'setup') return state
      state.phase = { kind: 'running', speed: state.phase.speed }
      return state
    case 'pause':
      if (state.phase.kind !== 'running') return state
      state.phase = { kind: 'paused', speed: state.phase.speed }
      return state
    case 'resume':
      if (state.phase.kind !== 'paused') return state
      state.phase = { kind: 'running', speed: state.phase.speed }
      return state
    case 'set-speed':
      return setSpeed(state, command.speed)
    case 'reset':
      return createSim(configFrom(state, {}))
    case 'tick': {
      if (state.phase.kind !== 'running') return state
      const dt = Math.min(Math.max(command.dt, 0), 0.05) * state.phase.speed
      if (dt > 0) step(state, dt)
      return state
    }
    default: {
      const _exhaustive: never = command
      return _exhaustive
    }
  }
}

function configFrom(state: SimState, patch: { shipCount?: SimState['shipCount'] }): SimConfig {
  return {
    shipCount: patch.shipCount ?? state.shipCount,
    formations: [state.fleets[0].formationId, state.fleets[1].formationId],
    tactics: state.divisions.map((division) => division.tacticId),
    commanders: [state.fleets[0].commanderId, state.fleets[1].commanderId],
    hp: state.stats.hp,
    damage: state.damage,
  }
}

function setSpeed(state: SimState, speed: Speed): SimState {
  const phase = state.phase
  if (phase.kind === 'finished') return state
  state.phase = { ...phase, speed }
  return state
}

function applyTactic(state: SimState, index: number, tacticId: TacticId): SimState {
  if (state.phase.kind === 'finished') return state
  const division = state.divisions[index]
  if (!division) return state
  division.tacticId = tacticId
  division.phase = 0
  division.phaseT = 0
  division.holdArmed = tacticId === 'hold'
  if (tacticId === 'hold') {
    division.holdX = division.ax
    division.holdY = division.ay
  }
  division.focus = tacticById(tacticId).focus
  return state
}

function issueOrders(state: SimState): void {
  const sides: SideId[] = [0, 1]
  const slots: DivisionSlot[] = [0, 1, 2, 3, 4]
  for (const side of sides) {
    const fleet = state.fleets[side]
    const commander = COMMANDERS[fleet.commanderId]
    if (!commander.auto) continue
    for (const slot of slots) {
      const index = side * DIVISIONS_PER_SIDE + slot
      const division = state.divisions[index]
      if (!division || division.alive === 0) continue
      const tacticId = chooseTactic(commander, factsFor(state, side, slot))
      if (!tacticId || tacticId === division.tacticId) continue
      applyTactic(state, index, tacticId)
      const line = `${fleet.name} ${division.name}: ${tacticById(tacticId).name}に切替`
      state.log.push(line)
      if (state.log.length > FIELD.logLimit) state.log.shift()
    }
  }
}

function factsFor(state: SimState, side: SideId, slot: DivisionSlot): BattleFacts {
  const enemy: SideId = side === 0 ? 1 : 0
  const enemyFacts = []
  for (let index = 0; index < DIVISIONS_PER_SIDE; index++) {
    const division = state.divisions[enemy * DIVISIONS_PER_SIDE + index]
    if (!division) continue
    enemyFacts.push({
      alive: division.alive,
      tacticId: division.tacticId,
      phase: division.phase,
      ax: division.ax,
      ay: division.ay,
    })
  }
  return {
    ownAlive: state.alive[side],
    enemyAlive: state.alive[enemy],
    ownLost: state.lost[side],
    enemyLost: state.lost[enemy],
    enemyFormation: state.fleets[enemy].formationId,
    ownX: state.centroidX[side] ?? 0,
    ownY: state.centroidY[side] ?? 0,
    slot,
    enemy: enemyFacts,
    enemyOnUs: bearing(
      state.centroidX[side] ?? 0,
      state.centroidY[side] ?? 0,
      fleetHeading(state, side),
      state.centroidX[enemy] ?? 0,
      state.centroidY[enemy] ?? 0,
    ),
    usOnEnemy: bearing(
      state.centroidX[enemy] ?? 0,
      state.centroidY[enemy] ?? 0,
      fleetHeading(state, enemy),
      state.centroidX[side] ?? 0,
      state.centroidY[side] ?? 0,
    ),
  }
}

function fleetHeading(state: SimState, side: SideId): { x: number; y: number } {
  let x = 0
  let y = 0
  let n = 0
  for (let index = 0; index < DIVISIONS_PER_SIDE; index++) {
    const division = state.divisions[side * DIVISIONS_PER_SIDE + index]
    if (!division || division.alive === 0) continue
    x += division.fx
    y += division.fy
    n += 1
  }
  if (n === 0) return side === 0 ? { x: 1, y: 0 } : { x: -1, y: 0 }
  const len = Math.hypot(x, y) || 1
  return { x: x / len, y: y / len }
}

function bearing(ox: number, oy: number, facing: { x: number; y: number }, tx: number, ty: number): Bearing {
  const dx = tx - ox
  const dy = ty - oy
  const len = Math.hypot(dx, dy) || 1
  const dot = (dx / len) * facing.x + (dy / len) * facing.y
  if (dot >= 0.5) return 'front'
  if (dot <= -0.35) return 'rear'
  return 'side'
}

function shipStats(config: SimConfig): ShipStats {
  return { ...SHIP_STATS, hp: config.hp ?? SHIP_STATS.hp }
}

function allocate(shipCount: SimState['shipCount'], stats: ShipStats, damage: [number, number]): SimState {
  const count = shipCount
  const divisions: Division[] = []
  const sides: SideId[] = [0, 1]
  const slots: DivisionSlot[] = [0, 1, 2, 3, 4]
  for (const side of sides) {
    for (const slot of slots) divisions.push(makeDivision(side, slot))
  }
  const phase: BattlePhase = { kind: 'setup', speed: 1 }
  return {
    shipCount,
    phase,
    ships: {
      count,
      x: new Float32Array(count),
      y: new Float32Array(count),
      vx: new Float32Array(count),
      vy: new Float32Array(count),
      hp: new Float32Array(count),
      flash: new Float32Array(count),
      cooldown: new Float32Array(count),
      slotX: new Float32Array(count),
      slotY: new Float32Array(count),
      heading: new Float32Array(count),
      alive: new Uint8Array(count),
      side: new Uint8Array(count),
      division: new Uint8Array(count),
      command: new Uint8Array(count),
      target: new Int32Array(count),
    },
    fleets: [
      { side: 0, name: FLEET_NAMES[0], formationId: DEFAULT_FORMATION, commanderId: DEFAULT_COMMANDER, centerX: -FIELD.fleetCenter, centerY: 0, facingX: 1, facingY: 0 },
      { side: 1, name: FLEET_NAMES[1], formationId: DEFAULT_FORMATION, commanderId: DEFAULT_COMMANDER, centerX: FIELD.fleetCenter, centerY: 0, facingX: -1, facingY: 0 },
    ],
    divisions,
    alive: [count / 2, count / 2],
    lost: [0, 0],
    centroidX: [-FIELD.fleetCenter, FIELD.fleetCenter],
    centroidY: [0, 0],
    time: 0,
    frame: 0,
    rng: 0xa341316c,
    stats,
    damage,
    commandAt: 0,
    log: [],
    beams: {
      life: new Float32Array(FIELD.maxBeams),
      x1: new Float32Array(FIELD.maxBeams),
      y1: new Float32Array(FIELD.maxBeams),
      x2: new Float32Array(FIELD.maxBeams),
      y2: new Float32Array(FIELD.maxBeams),
      side: new Uint8Array(FIELD.maxBeams),
      head: 0,
    },
    booms: {
      life: new Float32Array(FIELD.maxBooms),
      x: new Float32Array(FIELD.maxBooms),
      y: new Float32Array(FIELD.maxBooms),
      side: new Uint8Array(FIELD.maxBooms),
      head: 0,
    },
  }
}

function makeDivision(side: SideId, slot: DivisionSlot): Division {
  const facing = side === 0 ? 1 : -1
  return {
    side,
    slot,
    name: DIVISION_NAMES[slot],
    tacticId: 'charge',
    ax: facing * -FIELD.fleetCenter,
    ay: 0,
    fx: facing,
    fy: 0,
    rx: 0,
    ry: facing === 1 ? -1 : 1,
    vx: 0,
    vy: 0,
    phase: 0,
    phaseT: 0,
    holdX: 0,
    holdY: 0,
    holdArmed: false,
    flankSign: slot < 2 ? -1 : 1,
    orbitBase: 0,
    focus: false,
    focusX: 0,
    focusY: 0,
    alive: 0,
    roster: 0,
  }
}

function deploy(state: SimState): void {
  const half = state.shipCount / 2
  state.beams.life.fill(0)
  state.booms.life.fill(0)
  state.time = 0
  state.frame = 0
  state.lost[0] = 0
  state.lost[1] = 0
  state.commandAt = 0
  state.log = []
  for (const division of state.divisions) division.alive = 0
  const sides: SideId[] = [0, 1]
  for (const side of sides) placeSide(state, side, half)
  state.alive[0] = half
  state.alive[1] = half
  refreshCentroids(state)
}

function placeSide(state: SimState, side: SideId, half: number): void {
  const layout = layoutFormation(state.fleets[side].formationId, half)
  const ships = state.ships
  const offset = side * half
  const centerX = side === 0 ? -FIELD.fleetCenter : FIELD.fleetCenter
  const sums = state.divisions.map(() => ({ x: 0, y: 0, n: 0 }))
  for (let i = 0; i < half; i++) {
    const at = offset + i
    const localDivision = layout.division[i] ?? 2
    const divisionIndex = side * DIVISIONS_PER_SIDE + localDivision
    const lx = layout.x[i] ?? 0
    const ly = layout.y[i] ?? 0
    const wx = side === 0 ? centerX + ly : centerX - ly
    const wy = side === 0 ? -lx : lx
    ships.x[at] = wx
    ships.y[at] = wy
    ships.vx[at] = 0
    ships.vy[at] = 0
    ships.hp[at] = state.stats.hp
    ships.flash[at] = 0
    ships.cooldown[at] = rand(state) * state.stats.cooldown
    ships.alive[at] = 1
    ships.side[at] = side
    ships.division[at] = divisionIndex
    ships.command[at] = 0
    ships.target[at] = -1
    const bucket = sums[divisionIndex]
    if (!bucket) continue
    bucket.x += wx
    bucket.y += wy
    bucket.n += 1
  }
  for (let slot = 0; slot < DIVISIONS_PER_SIDE; slot++) {
    const division = state.divisions[side * DIVISIONS_PER_SIDE + slot]
    const bucket = sums[side * DIVISIONS_PER_SIDE + slot]
    if (!division || !bucket) continue
    division.alive = bucket.n
    division.roster = bucket.n
    division.ax = bucket.n > 0 ? bucket.x / bucket.n : centerX
    division.ay = bucket.n > 0 ? bucket.y / bucket.n : 0
    division.vx = 0
    division.vy = 0
    division.phase = 0
    division.phaseT = 0
    division.fx = side === 0 ? 1 : -1
    division.fy = 0
    division.rx = 0
    division.ry = side === 0 ? -1 : 1
    division.flankSign = division.ay < -8 ? -1 : division.ay > 8 ? 1 : division.slot < 2 ? -1 : 1
    const enemyX = -centerX
    division.orbitBase = Math.atan2(division.ay, division.ax - enemyX)
    division.holdArmed = division.tacticId === 'hold'
    division.holdX = division.ax
    division.holdY = division.ay
    division.focus = tacticById(division.tacticId).focus
    division.focusX = enemyX
    division.focusY = 0
  }
  for (let i = 0; i < half; i++) {
    const at = offset + i
    const division = state.divisions[ships.division[at] ?? 0]
    if (!division) continue
    const dx = ships.x[at]! - division.ax
    const dy = ships.y[at]! - division.ay
    ships.slotX[at] = dx * division.rx + dy * division.ry
    ships.slotY[at] = dx * division.fx + dy * division.fy
    ships.heading[at] = Math.atan2(division.fy, division.fx)
  }
  markCommander(state, side, half)
}

function markCommander(state: SimState, side: SideId, half: number): void {
  const ships = state.ships
  const division = state.divisions[side * DIVISIONS_PER_SIDE + 2]
  if (!division) return
  let best = -1
  let bestD = Infinity
  const offset = side * half
  for (let i = 0; i < half; i++) {
    const at = offset + i
    if (ships.division[at] !== division.side * DIVISIONS_PER_SIDE + 2) continue
    const dx = ships.x[at]! - division.ax
    const dy = ships.y[at]! - division.ay
    const d = dx * dx + dy * dy
    if (d < bestD) {
      bestD = d
      best = at
    }
  }
  if (best >= 0) ships.command[best] = 1
}

function step(state: SimState, dt: number): void {
  refreshCentroids(state)
  if (state.time >= state.commandAt) {
    issueOrders(state)
    state.commandAt += FIELD.commandInterval
  }
  const ctxBase = {
    divisions: state.divisions,
  }
  for (const division of state.divisions) {
    if (division.alive === 0) continue
    const enemy: SideId = division.side === 0 ? 1 : 0
    tacticById(division.tacticId).step(
      division,
      {
        ...ctxBase,
        ownX: state.centroidX[division.side],
        ownY: state.centroidY[division.side],
        enemyX: state.centroidX[enemy],
        enemyY: state.centroidY[enemy],
      },
      dt,
    )
  }
  moveShips(state, dt)
  fight(state, dt)
  fadeEffects(state, dt)
  state.time += dt
  state.frame += 1
  if (state.alive[0] === 0 || state.alive[1] === 0) {
    const winner = state.alive[0] === state.alive[1] ? 'draw' : state.alive[0] > 0 ? 0 : 1
    state.phase = { kind: 'finished', winner }
  }
}

function refreshCentroids(state: SimState): void {
  const sx = [0, 0]
  const sy = [0, 0]
  const w = [0, 0]
  for (const division of state.divisions) {
    if (division.alive === 0) continue
    sx[division.side]! += division.ax * division.alive
    sy[division.side]! += division.ay * division.alive
    w[division.side]! += division.alive
  }
  for (let side = 0; side < 2; side++) {
    const weight = w[side] ?? 0
    if (weight <= 0) continue
    state.centroidX[side] = (sx[side] ?? 0) / weight
    state.centroidY[side] = (sy[side] ?? 0) / weight
  }
}

function moveShips(state: SimState, dt: number): void {
  const ships = state.ships
  const stats = state.stats
  const maxTurn = stats.turnRate * dt
  const reverse = stats.maxSpeed * stats.reverse
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] === 0) continue
    const division = state.divisions[ships.division[i] ?? 0]
    if (!division) continue
    const x = ships.x[i] ?? 0
    const y = ships.y[i] ?? 0
    const tx = division.ax + division.rx * (ships.slotX[i] ?? 0) + division.fx * (ships.slotY[i] ?? 0)
    const ty = division.ay + division.ry * (ships.slotX[i] ?? 0) + division.fy * (ships.slotY[i] ?? 0)
    const dx = tx - x
    const dy = ty - y
    const dist = Math.hypot(dx, dy)
    const guns = TACTICS[division.tacticId].guns
    let desired = Math.atan2(division.fy, division.fx)
    const target = ships.target[i] ?? -1
    if (!guns && dist > 22) {
      desired = Math.atan2(dy, dx)
    } else if (target >= 0 && ships.alive[target] === 1) {
      desired = Math.atan2((ships.y[target] ?? 0) - y, (ships.x[target] ?? 0) - x)
    }
    let heading = ships.heading[i] ?? desired
    const turn = wrapAngle(desired - heading)
    heading += Math.max(-maxTurn, Math.min(maxTurn, turn))
    ships.heading[i] = heading
    const hx = Math.cos(heading)
    const hy = Math.sin(heading)
    const along = dist > 1e-4 ? (dx * hx + dy * hy) / dist : 1
    let speed = 0
    if (dist < 8) speed = along < 0 ? -reverse * 0.2 : Math.min(stats.maxSpeed * 0.2, dist)
    else if (along > 0.2) speed = Math.min(stats.maxSpeed, dist * 1.5)
    else if (along < -0.2) speed = -reverse
    ships.vx[i] = hx * speed
    ships.vy[i] = hy * speed
    ships.x[i] = x + hx * speed * dt
    ships.y[i] = y + hy * speed * dt
    if ((ships.flash[i] ?? 0) > 0) ships.flash[i] = Math.max(0, (ships.flash[i] ?? 0) - dt * 4)
  }
}

function fight(state: SimState, dt: number): void {
  const ships = state.ships
  const stagger = FIELD.stagger
  const frame = state.frame
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] === 0) continue
    const target = ships.target[i] ?? -1
    const needs = target < 0 || ships.alive[target] === 0 || i % stagger === frame % stagger
    if (needs) acquire(state, i)
    ships.cooldown[i] = (ships.cooldown[i] ?? 0) - dt
    if ((ships.cooldown[i] ?? 0) > 0) continue
    shoot(state, i)
  }
}

function acquire(state: SimState, index: number): void {
  const ships = state.ships
  const division = state.divisions[ships.division[index] ?? 0]
  const sx = ships.x[index] ?? 0
  const sy = ships.y[index] ?? 0
  const side = ships.side[index] === 1 ? 1 : 0
  const half = state.shipCount / 2
  const origin = side === 0 ? half : 0
  const reach = acquireSq(state.stats)
  const step = Math.max(1, Math.floor(half / FIELD.sampleStep))
  let best = -1
  let bestScore = Infinity
  for (let k = (index + state.frame) % step; k < half; k += step) {
    const other = origin + k
    if (ships.alive[other] === 0) continue
    const dx = ships.x[other]! - sx
    const dy = ships.y[other]! - sy
    const d2 = dx * dx + dy * dy
    if (d2 > reach) continue
    if (!inFiringArc(ships.heading[index] ?? 0, sx, sy, ships.x[other]!, ships.y[other]!, state.stats.arc)) continue
    let score = d2
    if (division?.focus) {
      const fx = ships.x[other]! - division.focusX
      const fy = ships.y[other]! - division.focusY
      score = fx * fx + fy * fy + d2 * 0.12
    }
    if (score < bestScore) {
      bestScore = score
      best = other
    }
  }
  ships.target[index] = best
}

function shoot(state: SimState, index: number): void {
  const ships = state.ships
  const target = ships.target[index] ?? -1
  if (target < 0 || ships.alive[target] === 0) return
  const dx = ships.x[target]! - ships.x[index]!
  const dy = ships.y[target]! - ships.y[index]!
  if (dx * dx + dy * dy > rangeSq(state.stats)) return
  if (!inFiringArc(ships.heading[index] ?? 0, ships.x[index] ?? 0, ships.y[index] ?? 0, ships.x[target] ?? 0, ships.y[target] ?? 0, state.stats.arc)) {
    return
  }
  ships.cooldown[index] = state.stats.cooldown * (0.85 + rand(state) * 0.3)
  const hit = rand(state) <= state.stats.hitChance
  const spread = hit ? 0.4 : 8
  const ox = (rand(state) - 0.5) * spread
  const oy = (rand(state) - 0.5) * spread
  spawnBeam(
    state,
    ships.x[index]!,
    ships.y[index]!,
    ships.x[target]! + ox,
    ships.y[target]! + oy,
    ships.side[index] ?? 0,
  )
  if (!hit) return
  const side = ships.side[index] === 1 ? 1 : 0
  const factor = armorMultiplier(
    ships.heading[target] ?? 0,
    ships.x[target] ?? 0,
    ships.y[target] ?? 0,
    ships.x[index] ?? 0,
    ships.y[index] ?? 0,
    state.stats,
  )
  ships.hp[target] = (ships.hp[target] ?? 0) - state.damage[side] * factor
  ships.flash[target] = 1
  if ((ships.hp[target] ?? 0) <= 0) destroy(state, target)
}

function destroy(state: SimState, index: number): void {
  const ships = state.ships
  if (ships.alive[index] === 0) return
  ships.alive[index] = 0
  ships.hp[index] = 0
  const division = state.divisions[ships.division[index] ?? 0]
  if (division) division.alive = Math.max(0, division.alive - 1)
  const side: SideId = ships.side[index] === 1 ? 1 : 0
  state.alive[side] -= 1
  state.lost[side] += 1
  const slot = state.booms.head
  state.booms.head = (slot + 1) % FIELD.maxBooms
  state.booms.x[slot] = ships.x[index] ?? 0
  state.booms.y[slot] = ships.y[index] ?? 0
  state.booms.life[slot] = FIELD.boomLife
  state.booms.side[slot] = side
}

function spawnBeam(state: SimState, x1: number, y1: number, x2: number, y2: number, side: number): void {
  const slot = state.beams.head
  state.beams.head = (slot + 1) % FIELD.maxBeams
  state.beams.x1[slot] = x1
  state.beams.y1[slot] = y1
  state.beams.x2[slot] = x2
  state.beams.y2[slot] = y2
  state.beams.life[slot] = FIELD.beamLife
  state.beams.side[slot] = side
}

function fadeEffects(state: SimState, dt: number): void {
  const beams = state.beams.life
  for (let i = 0; i < beams.length; i++) {
    if (beams[i]! > 0) beams[i] = beams[i]! - dt
  }
  const booms = state.booms.life
  for (let i = 0; i < booms.length; i++) {
    if (booms[i]! > 0) booms[i] = booms[i]! - dt
  }
}

function rand(state: SimState): number {
  let x = state.rng | 0
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  state.rng = x | 0
  return (x >>> 0) / 4294967296
}
