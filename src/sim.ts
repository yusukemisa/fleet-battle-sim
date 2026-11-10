import { acquireSq, CLASS_STATS, DEFAULT_LINE, FIELD, fleetLine, GUNNERY, hullHp, MAX_SHIPS, RANKS, SHIP_CLASS_IDS, SHIP_STATS, SIM_TIME_SCALE, SWEEP, stepYaw, thrust, volleyGap, volleyPhase, type ShipClassId, type ShipStats } from './balance.ts'
import { assignTargets, clampGroups, fleetAnchor, fleetIndex, FLEET_NAMES as FLEET_TITLES, separateFleets } from './fleets.ts'
import { armorZone, inArc, inBattery, inFiringArc, wrapAngle } from './combat.ts'
import { chooseTactic, COMMANDERS, employClass, type BattleFacts, type Bearing } from './commanders.ts'
import { layoutFormation } from './formations.ts'
import { batteryCooldown, cacheBows, cacheSpread, emptyTally, hasClearShot, pickBatteryTarget, pickTarget, setBatteryCooldown } from './gunnery.ts'
import { refreshCover, rotateRanks } from './ranks.ts'
import { collectNear, createScratch, fillSpatialHash } from './spatial.ts'
import { orderPoints, stepMoveOrder } from './move.ts'
import { assessDivision, threatenedHeading } from './threat.ts'
import { stepPlan, updatePlan } from './posture.ts'
import { TACTICS, stepDivision, tacticById } from './tactics.ts'
import {
  DEFAULT_COMMANDER,
  DEFAULT_FORMATION,
  DIVISIONS_PER_SIDE,
  DIVISION_NAMES,
  type BattlePhase,
  type Command,
  type Division,
  type DivisionSlot,
  type Fleet,
  type FleetSetup,
  type GunneryMode,
  type ManeuverMode,
  type SideId,
  type SimConfig,
  type SimState,
  type Speed,
  type TacticId,
} from './types.ts'

const FLEET_NAMES = ['青軍', '赤軍'] as const
/** Cooldown lives in a Float32Array, so summed frame dt can be about a millisecond off. */
const COOLDOWN_SLACK = 1e-3

export function createSim(config: SimConfig): SimState {
  if (config.groups && config.groups.length > 0) return createGrouped(config)
  const formations = config.formations ?? [DEFAULT_FORMATION, DEFAULT_FORMATION]
  const commanders = config.commanders ?? [DEFAULT_COMMANDER, DEFAULT_COMMANDER]
  const stats = shipStats(config)
  const damage: [number, number] = config.damage
    ? [config.damage[0], config.damage[1]]
    : [stats.damage, stats.damage]
  const state = allocate(
    config.shipCount,
    stats,
    damage,
    config.gunnery ?? 'aimed',
    config.maneuver ?? 'shaped',
    config.withdraw ?? [true, true],
  )
  state.fleets[0].formationId = formations[0]
  state.fleets[1].formationId = formations[1]
  state.fleets[0].commanderId = commanders[0]
  state.fleets[1].commanderId = commanders[1]
  const line = fleetLine(config.classes)
  for (let i = 0; i < state.divisions.length; i++) {
    const division = state.divisions[i]
    const classId = line[i]
    if (division && classId) division.classId = classId
  }
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
      if (command.count === state.shipCount && !state.groups) return state
      return createSim(configFrom(state, { shipCount: command.count, groups: null }))
    case 'set-fleet-count':
    case 'set-fleet-ships':
    case 'set-fleet-formation':
    case 'set-fleet-commander':
      if (state.phase.kind !== 'setup') return state
      return createSim(configFrom(state, { groups: resizeGroups(state, command) }))
    case 'set-fleet-tactic': {
      if (state.phase.kind === 'finished') return state
      const fleet = state.fleets[command.fleet]
      if (!fleet) return state
      for (const division of state.divisions) {
        if (division.fleet !== fleet.index) continue
        applyTactic(state, state.divisions.indexOf(division), command.tacticId)
      }
      return state
    }
    case 'set-formation':
      if (state.phase.kind !== 'setup') return state
      state.fleets[command.side].formationId = command.formationId
      if (state.groups) state.groups = patchGroup(state.groups, command.side, { formationId: command.formationId })
      deploy(state)
      return state
    case 'set-commander':
      if (state.phase.kind !== 'setup') return state
      state.fleets[command.side].commanderId = command.commanderId
      if (state.groups) state.groups = patchGroup(state.groups, command.side, { commanderId: command.commanderId })
      return state
    case 'set-class': {
      if (state.phase.kind !== 'setup') return state
      const division = state.divisions[command.division]
      if (!division) return state
      division.classId = command.classId
      deploy(state)
      return state
    }
    case 'order-move':
      return orderMove(state, command.divisions, command.x, command.y, command.heading)
    case 'order-clear':
      return clearMove(state, command.divisions)
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
      const dt = Math.min(Math.max(command.dt, 0), 0.05) * state.phase.speed * SIM_TIME_SCALE
      if (dt > 0) step(state, dt)
      return state
    }
    default: {
      const _exhaustive: never = command
      return _exhaustive
    }
  }
}

function configFrom(state: SimState, patch: { shipCount?: SimState['shipCount']; groups?: FleetSetup[] | null }): SimConfig {
  const groups = patch.groups === null ? undefined : (patch.groups ?? state.groups ?? undefined)
  return {
    shipCount: (patch.shipCount ?? state.shipCount) as SimConfig['shipCount'],
    groups,
    formations: [state.fleets[0].formationId, state.fleets[1].formationId],
    tactics: state.divisions.map((division) => division.tacticId),
    classes: state.divisions.map((division) => division.classId),
    commanders: [state.fleets[0].commanderId, state.fleets[1].commanderId],
    hp: state.stats.hp,
    damage: state.damage,
    gunnery: state.gunnery,
    maneuver: state.maneuver,
    withdraw: state.withdrawSides,
  }
}

function patchGroup(groups: FleetSetup[], side: SideId, patch: Partial<FleetSetup>): FleetSetup[] {
  let used = false
  return groups.map((group) => {
    if (group.side !== side || used) return group
    used = true
    return { ...group, ...patch }
  })
}

function resizeGroups(state: SimState, command: Command): FleetSetup[] {
  const current = state.groups ?? [
    { side: 0, ships: state.fleets[0].ships, formationId: state.fleets[0].formationId, commanderId: state.fleets[0].commanderId },
    { side: 1, ships: state.fleets[1].ships, formationId: state.fleets[1].formationId, commanderId: state.fleets[1].commanderId },
  ]
  if (command.type === 'set-fleet-count') {
    const kept = current.filter((group) => group.side !== command.side)
    const mine = current.filter((group) => group.side === command.side)
    const next = mine.slice(0, command.count)
    while (next.length < command.count) {
      const seed = mine[0]
      next.push({
        side: command.side,
        ships: 500,
        formationId: seed?.formationId ?? DEFAULT_FORMATION,
        commanderId: seed?.commanderId ?? DEFAULT_COMMANDER,
      })
    }
    return clampGroups([...kept, ...next])
  }
  if (command.type === 'set-fleet-ships') {
    const fleet = state.fleets[command.fleet]
    if (!fleet) return current
    let seen = 0
    return clampGroups(current.map((group) => {
      if (group.side !== fleet.side) return group
      const ordinal = seen
      seen += 1
      if (ordinal !== fleet.ordinal) return group
      return { ...group, ships: command.ships }
    }))
  }
  if (command.type === 'set-fleet-formation' || command.type === 'set-fleet-commander') {
    const fleet = state.fleets[command.fleet]
    if (!fleet) return current
    let seen = 0
    return current.map((group) => {
      if (group.side !== fleet.side) return group
      const ordinal = seen
      seen += 1
      if (ordinal !== fleet.ordinal) return group
      if (command.type === 'set-fleet-formation') return { ...group, formationId: command.formationId }
      return { ...group, commanderId: command.commanderId }
    })
  }
  return current
}

function createGrouped(config: SimConfig): SimState {
  const groups = clampGroups(config.groups ?? [])
  const total = Math.min(MAX_SHIPS, groups.reduce((sum, group) => sum + group.ships, 0))
  const state = allocate(total, shipStats(config), config.damage ? [config.damage[0], config.damage[1]] : [shipStats(config).damage, shipStats(config).damage], config.gunnery ?? 'aimed', config.maneuver ?? 'shaped', config.withdraw ?? [true, true])
  state.groups = groups
  state.shipCount = total
  const counts: [number, number] = [0, 0]
  const plans = groups.map((group) => {
    const ordinal = counts[group.side]
    counts[group.side] += 1
    return { ...group, ordinal, index: fleetIndex(group.side, ordinal) }
  })
  const max = plans.reduce((hi, plan) => Math.max(hi, plan.index), 1)
  const fleets: Fleet[] = []
  for (let index = 0; index <= max; index++) {
    const plan = plans.find((item) => item.index === index)
    const side: SideId = index % 2 === 0 ? 0 : 1
    const ordinal = Math.floor(index / 2)
    const anchor = fleetAnchor(side, plan ? plan.ordinal : ordinal)
    const name = FLEET_TITLES[side][ordinal] ?? FLEET_TITLES[side][0] ?? '軍'
    fleets[index] = {
      index,
      ordinal: plan ? plan.ordinal : ordinal,
      side,
      name,
      ships: plan?.ships ?? 0,
      formationId: plan?.formationId ?? DEFAULT_FORMATION,
      commanderId: plan?.commanderId ?? DEFAULT_COMMANDER,
      centerX: anchor.x,
      centerY: anchor.y,
      meanX: anchor.x,
      meanY: anchor.y,
      enemyFleet: side === 0 ? 1 : 0,
      cover: false,
      facingX: side === 0 ? 1 : -1,
      facingY: 0,
      sweepLeg: 0,
      maneuver: 'press',
      maneuverUntil: 0,
      prey: -1,
      bias: 1,
    }
  }
  state.fleets = fleets
  const divisions: Division[] = []
  for (let index = 0; index < fleets.length; index++) {
    const fleet = fleets[index]
    if (!fleet) continue
    for (let slot = 0; slot < DIVISIONS_PER_SIDE; slot++) {
      const division = makeDivision(fleet.side, slot as DivisionSlot, fleet.index)
      const classes = plans.find((plan) => plan.index === fleet.index)?.classes
      division.classId = classes?.[slot] ?? DEFAULT_LINE[slot] ?? 'battleship'
      divisions.push(division)
    }
  }
  state.divisions = divisions
  if (config.tactics) {
    for (let i = 0; i < state.divisions.length; i++) {
      const tacticId = config.tactics[i]
      const division = state.divisions[i]
      if (tacticId && division) division.tacticId = tacticId
    }
  }
  deployGrouped(state)
  return state
}

function deployGrouped(state: SimState): void {
  state.beams.life.fill(0)
  state.booms.life.fill(0)
  state.time = 0
  state.frame = 0
  state.lost[0] = 0
  state.lost[1] = 0
  state.commandAt = 0
  state.log = []
  state.hits.front[0] = 0
  state.hits.front[1] = 0
  state.hits.side[0] = 0
  state.hits.side[1] = 0
  state.hits.rear[0] = 0
  state.hits.rear[1] = 0
  state.tally.shots = 0
  state.tally.hits = 0
  state.tally.damage = 0
  state.tally.overkill = 0
  state.tally.idle = 0
  state.tally.held = 0
  state.tally.wide = 0
  state.tally.deaths = 0
  state.tally.deathTime = 0
  state.rankAt = 0
  state.fallingN = 0
  state.classDamage[0] = 0
  state.classDamage[1] = 0
  state.classDamage[2] = 0
  for (let i = 0; i < state.classOnClass.length; i++) state.classOnClass[i] = 0
  state.ships.falling.fill(0)
  state.ships.yaw.fill(0)
  state.scratch.look.fill(-1)
  for (const division of state.divisions) division.alive = 0
  for (const fleet of state.fleets) {
    fleet.sweepLeg = 0
    fleet.maneuver = 'press'
    fleet.maneuverUntil = 0
    fleet.prey = -1
    fleet.bias = 1
  }
  let cursor = 0
  const alive: [number, number] = [0, 0]
  for (const fleet of state.fleets) {
    if (fleet.ships <= 0) continue
    placeFleet(state, fleet, cursor)
    alive[fleet.side] += fleet.ships
    cursor += fleet.ships
  }
  state.alive[0] = alive[0]
  state.alive[1] = alive[1]
  refreshCentroids(state)
}

function placeFleet(state: SimState, fleet: Fleet, offset: number): void {
  const count = fleet.ships
  const layout = layoutFormation(fleet.formationId, count)
  const ships = state.ships
  const side = fleet.side
  const centerX = fleet.centerX
  const centerY = fleet.centerY
  const sums = state.divisions.map(() => ({ x: 0, y: 0, n: 0 }))
  for (let i = 0; i < count; i++) {
    const at = offset + i
    const localDivision = layout.division[i] ?? 2
    const divisionIndex = fleet.index * DIVISIONS_PER_SIDE + localDivision
    const lx = layout.x[i] ?? 0
    const ly = layout.y[i] ?? 0
    const wx = side === 0 ? centerX + ly : centerX - ly
    const wy = (side === 0 ? -lx : lx) + centerY
    ships.x[at] = wx
    ships.y[at] = wy
    ships.vx[at] = 0
    ships.vy[at] = 0
    const classId = state.divisions[divisionIndex]?.classId ?? 'battleship'
    const classIdx = SHIP_CLASS_IDS.indexOf(classId as ShipClassId)
    const spec = CLASS_STATS[classIdx] ?? state.stats
    ships.shipClass[at] = classIdx < 0 ? 0 : classIdx
    ships.hp[at] = hullHp(ships.shipClass[at] ?? 0, state.stats.hp)
    ships.flash[at] = 0
    ships.cooldown[at] = rand(state) * spec.cooldown
    ships.gunCd[at * 2] = rand(state) * spec.cooldown
    ships.gunCd[at * 2 + 1] = rand(state) * spec.cooldown
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
    const divisionIndex = fleet.index * DIVISIONS_PER_SIDE + slot
    const division = state.divisions[divisionIndex]
    const bucket = sums[divisionIndex]
    if (!division || !bucket) continue
    division.alive = bucket.n
    division.roster = bucket.n
    division.ax = bucket.n > 0 ? bucket.x / bucket.n : centerX
    division.ay = bucket.n > 0 ? bucket.y / bucket.n : centerY
    division.vx = 0
    division.vy = 0
    division.phase = 0
    division.phaseT = 0
    division.fx = side === 0 ? 1 : -1
    division.fy = 0
    division.rx = 0
    division.ry = side === 0 ? -1 : 1
    division.flankSign = division.ay < centerY - 8 ? -1 : division.ay > centerY + 8 ? 1 : division.slot < 2 ? -1 : 1
    const enemyX = -Math.sign(centerX || 1) * FIELD.fleetCenter
    division.orbitBase = Math.atan2(division.ay, division.ax - enemyX)
    division.holdArmed = division.tacticId === 'hold'
    division.holdX = division.ax
    division.holdY = division.ay
    division.sweepLocked = false
    division.sweeping = false
    division.sweepAlong = 0
    division.sweepOut = 0
    division.focus = tacticById(division.tacticId).focus
    division.focusX = enemyX
    division.focusY = centerY
    division.hunt = -1
    division.standoff = false
    division.rush = false
    division.headOn = false
    division.ordered = false
  }
  for (let i = 0; i < count; i++) {
    const at = offset + i
    const division = state.divisions[ships.division[at] ?? 0]
    if (!division) continue
    const dx = (ships.x[at] ?? 0) - division.ax
    const dy = (ships.y[at] ?? 0) - division.ay
    ships.slotX[at] = dx * division.rx + dy * division.ry
    ships.slotY[at] = dx * division.fx + dy * division.fy
    ships.homeX[at] = ships.slotX[at] ?? 0
    ships.homeY[at] = ships.slotY[at] ?? 0
    ships.falling[at] = 0
    ships.heading[at] = Math.atan2(division.fy, division.fx)
  }
  const center = state.divisions[fleet.index * DIVISIONS_PER_SIDE + 2]
  if (!center) return
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < count; i++) {
    const at = offset + i
    if (ships.division[at] !== center.fleet * DIVISIONS_PER_SIDE + 2) continue
    const dx = (ships.x[at] ?? 0) - center.ax
    const dy = (ships.y[at] ?? 0) - center.ay
    const d = dx * dx + dy * dy
    if (d < bestD) {
      bestD = d
      best = at
    }
  }
  if (best >= 0) ships.command[best] = 1
}

function setSpeed(state: SimState, speed: Speed): SimState {
  const phase = state.phase
  if (phase.kind === 'finished') return state
  state.phase = { ...phase, speed }
  return state
}

function orderMove(state: SimState, indexes: readonly number[], x: number, y: number, heading: number): SimState {
  if (state.phase.kind === 'finished') return state
  const allowed = indexes.filter((index) => {
    const division = state.divisions[index]
    return division !== undefined && (state.fleets[division.fleet] ?? state.fleets[division.side])?.commanderId === 'manual'
  })
  const points = orderPoints(state.divisions, allowed, x, y)
  const face = wrapAngle(heading)
  for (const point of points) {
    const division = state.divisions[point.index]
    if (!division) continue
    division.ordered = true
    division.orderX = point.x
    division.orderY = point.y
    division.orderH = face
  }
  return state
}

function clearMove(state: SimState, indexes: readonly number[]): SimState {
  for (const index of indexes) {
    const division = state.divisions[index]
    if (division) division.ordered = false
  }
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
  if (state.fleets.length > 2) {
    for (let index = 0; index < state.divisions.length; index++) {
      const division = state.divisions[index]
      if (!division || division.alive === 0 || division.classId !== 'battleship') continue
      const fleet = state.fleets[division.fleet]
      if (!fleet) continue
      const commander = COMMANDERS[fleet.commanderId]
      if (!commander.auto) continue
      const facts = factsFor(state, division.side, division.slot, index)
      const chosen = chooseTactic(commander, facts)
      const tacticId = chosen ? employClass(commander, division.classId, chosen, facts) : null
      if (!tacticId || tacticId === division.tacticId) continue
      applyTactic(state, index, tacticId)
    }
    return
  }
  const sides: SideId[] = [0, 1]
  const slots: DivisionSlot[] = [0, 1, 2, 3, 4]
  for (const side of sides) {
    const fleet = state.fleets[side]
    const commander = COMMANDERS[fleet.commanderId]
    if (!commander.auto) continue
    for (const slot of slots) {
      const index = side * DIVISIONS_PER_SIDE + slot
      const division = state.divisions[index]
      if (!division || division.alive === 0 || division.classId !== 'battleship') continue
      const facts = factsFor(state, side, slot)
      const chosen = chooseTactic(commander, facts)
      const tacticId = chosen ? employClass(commander, division.classId, chosen, facts) : null
      division.screen = commander.id === 'guard' && division.classId !== 'battleship'
      if (!tacticId || tacticId === division.tacticId) continue
      applyTactic(state, index, tacticId)
      const line = `${fleet.name} ${division.name}: ${tacticById(tacticId).name}に切替`
      state.log.push(line)
      if (state.log.length > FIELD.logLimit) state.log.shift()
    }
  }
}

function factsFor(state: SimState, side: SideId, slot: DivisionSlot, at?: number): BattleFacts {
  const enemy: SideId = side === 0 ? 1 : 0
  const enemyFacts = []
  const enemyDivisions =
    at === undefined
      ? Array.from({ length: DIVISIONS_PER_SIDE }, (_, index) => state.divisions[enemy * DIVISIONS_PER_SIDE + index])
      : state.divisions.filter((division) => division.side === enemy)
  for (const division of enemyDivisions) {
    if (!division) continue
    enemyFacts.push({
      alive: division.alive,
      tacticId: division.tacticId,
      phase: division.phase,
      ax: division.ax,
      ay: division.ay,
      fx: division.fx,
      fy: division.fy,
    })
  }
  const division = state.divisions[at ?? side * DIVISIONS_PER_SIDE + slot]
  return {
    ownAlive: state.alive[side],
    enemyAlive: state.alive[enemy],
    ownLost: state.lost[side],
    enemyLost: state.lost[enemy],
    enemyFormation: (at === undefined ? state.fleets[enemy] : state.fleets[state.fleets[division?.fleet ?? side]?.enemyFleet ?? enemy])?.formationId ?? state.fleets[enemy].formationId,
    ownX: state.centroidX[side] ?? 0,
    ownY: state.centroidY[side] ?? 0,
    ax: division?.ax ?? 0,
    ay: division?.ay ?? 0,
    fx: division?.fx ?? (side === 0 ? 1 : -1),
    fy: division?.fy ?? 0,
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
    enemyCommander: state.fleets[enemy].commanderId,
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

function allocate(
  shipCount: SimState['shipCount'],
  stats: ShipStats,
  damage: [number, number],
  gunnery: GunneryMode,
  maneuver: ManeuverMode,
  withdrawSides: readonly [boolean, boolean],
): SimState {
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
    groups: null,
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
      gunCd: new Float32Array(count * 2),
      slotX: new Float32Array(count),
      slotY: new Float32Array(count),
      homeX: new Float32Array(count),
      homeY: new Float32Array(count),
      falling: new Uint8Array(count),
      approach: new Uint8Array(count),
      heading: new Float32Array(count),
      yaw: new Float32Array(count),
      alive: new Uint8Array(count),
      side: new Uint8Array(count),
      shipClass: new Uint8Array(count),
      division: new Uint8Array(count),
      command: new Uint8Array(count),
      target: new Int32Array(count),
    },
    fleets: [
      { index: 0, ordinal: 0, side: 0, name: FLEET_NAMES[0], ships: count / 2, formationId: DEFAULT_FORMATION, commanderId: DEFAULT_COMMANDER, centerX: -FIELD.fleetCenter, centerY: 0, meanX: -FIELD.fleetCenter, meanY: 0,       enemyFleet: 1, cover: false, facingX: 1, facingY: 0, sweepLeg: 0, maneuver: 'press', maneuverUntil: 0, prey: -1, bias: 1 },
      { index: 1, ordinal: 0, side: 1, name: FLEET_NAMES[1], ships: count / 2, formationId: DEFAULT_FORMATION, commanderId: DEFAULT_COMMANDER, centerX: FIELD.fleetCenter, centerY: 0, meanX: FIELD.fleetCenter, meanY: 0, enemyFleet: 0, cover: false, facingX: -1, facingY: 0, sweepLeg: 0, maneuver: 'press', maneuverUntil: 0, prey: -1, bias: 1 },
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
    hits: { front: [0, 0], side: [0, 0], rear: [0, 0] },
    beams: {
      life: new Float32Array(FIELD.maxBeams),
      x1: new Float32Array(FIELD.maxBeams),
      y1: new Float32Array(FIELD.maxBeams),
      x2: new Float32Array(FIELD.maxBeams),
      y2: new Float32Array(FIELD.maxBeams),
      side: new Uint8Array(FIELD.maxBeams),
      kind: new Uint8Array(FIELD.maxBeams),
      head: 0,
    },
    booms: {
      life: new Float32Array(FIELD.maxBooms),
      x: new Float32Array(FIELD.maxBooms),
      y: new Float32Array(FIELD.maxBooms),
      side: new Uint8Array(FIELD.maxBooms),
      head: 0,
    },
    gunnery,
    maneuver,
    withdrawSides,
    tally: emptyTally(),
    scratch: createScratch(count, GUNNERY.cell),
    classDamage: [0, 0, 0],
    classOnClass: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    rankAt: 0,
    fallingN: 0,
  }
}

function makeDivision(side: SideId, slot: DivisionSlot, fleet: number = side): Division {
  const facing = side === 0 ? 1 : -1
  return {
    side,
    fleet,
    slot,
    name: DIVISION_NAMES[slot],
    classId: 'battleship',
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
    hunt: -1,
    standoff: false,
    rush: false,
    headOn: false,
    markX: 0,
    markY: 0,
    sweepAlong: 0,
    sweepOut: 0,
    sweepLocked: false,
    sweeping: false,
    shaped: false,
    ordered: false,
    orderX: 0,
    orderY: 0,
    orderH: 0,
    guard: 0,
    guardX: 0,
    guardY: 0,
    broadsideOk: false,
    yielding: false,
    sprint: false,
    screen: false,
    alive: 0,
    roster: 0,
  }
}

function deploy(state: SimState): void {
  if (state.groups && state.groups.length > 0) {
    deployGrouped(state)
    return
  }
  const half = state.shipCount / 2
  state.beams.life.fill(0)
  state.booms.life.fill(0)
  state.time = 0
  state.frame = 0
  state.lost[0] = 0
  state.lost[1] = 0
  state.commandAt = 0
  state.log = []
  state.hits.front[0] = 0
  state.hits.front[1] = 0
  state.hits.side[0] = 0
  state.hits.side[1] = 0
  state.hits.rear[0] = 0
  state.hits.rear[1] = 0
  const tally = state.tally
  tally.shots = 0
  tally.hits = 0
  tally.damage = 0
  tally.overkill = 0
  tally.idle = 0
  tally.held = 0
  tally.wide = 0
  tally.deaths = 0
  tally.deathTime = 0
  state.rankAt = 0
  state.fallingN = 0
  state.classDamage[0] = 0
  state.classDamage[1] = 0
  state.classDamage[2] = 0
  for (let i = 0; i < state.classOnClass.length; i++) state.classOnClass[i] = 0
  state.ships.falling.fill(0)
  state.ships.yaw.fill(0)
  state.scratch.look.fill(-1)
  for (const division of state.divisions) division.alive = 0
  const sides: SideId[] = [0, 1]
  state.fleets[0].sweepLeg = 0
  state.fleets[1].sweepLeg = 0
  state.fleets[0].maneuver = 'press'
  state.fleets[1].maneuver = 'press'
  state.fleets[0].maneuverUntil = 0
  state.fleets[1].maneuverUntil = 0
  state.fleets[0].prey = -1
  state.fleets[1].prey = -1
  state.fleets[0].bias = 1
  state.fleets[1].bias = 1
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
    const classId = state.divisions[divisionIndex]?.classId ?? 'battleship'
    const classIdx = SHIP_CLASS_IDS.indexOf(classId)
    const spec = CLASS_STATS[classIdx] ?? state.stats
    ships.shipClass[at] = classIdx < 0 ? 0 : classIdx
    ships.hp[at] = hullHp(ships.shipClass[at] ?? 0, state.stats.hp)
    ships.flash[at] = 0
    ships.cooldown[at] = rand(state) * spec.cooldown
    ships.gunCd[at * 2] = rand(state) * spec.cooldown
    ships.gunCd[at * 2 + 1] = rand(state) * spec.cooldown
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
    division.sweepLocked = false
    division.sweeping = false
    division.sweepAlong = 0
    division.sweepOut = 0
    division.focus = tacticById(division.tacticId).focus
    division.focusX = enemyX
    division.focusY = 0
    division.hunt = -1
    division.standoff = false
    division.rush = false
    division.headOn = false
    division.ordered = false
  }
  for (let i = 0; i < half; i++) {
    const at = offset + i
    const division = state.divisions[ships.division[at] ?? 0]
    if (!division) continue
    const dx = ships.x[at]! - division.ax
    const dy = ships.y[at]! - division.ay
    ships.slotX[at] = dx * division.rx + dy * division.ry
    ships.slotY[at] = dx * division.fx + dy * division.fy
    ships.homeX[at] = ships.slotX[at] ?? 0
    ships.homeY[at] = ships.slotY[at] ?? 0
    ships.falling[at] = 0
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
  const sides: SideId[] = [0, 1]
  for (const side of sides) {
    const enemy: SideId = side === 0 ? 1 : 0
    const dist = Math.hypot(
      (state.centroidX[side] ?? 0) - (state.centroidX[enemy] ?? 0),
      (state.centroidY[side] ?? 0) - (state.centroidY[enemy] ?? 0),
    )
    const fleet = state.fleets[side]
    if (dist < SWEEP.pass) fleet.sweepLeg = 1
    else if (dist > SWEEP.resume) fleet.sweepLeg = 0
  }
  if (state.fleets.length > 2) {
    for (const fleet of state.fleets) {
      if (fleet.ships <= 0) continue
      const enemy = state.fleets[fleet.enemyFleet]
      if (!enemy) continue
      const dist = Math.hypot(fleet.meanX - enemy.meanX, fleet.meanY - enemy.meanY)
      if (dist < SWEEP.pass) fleet.sweepLeg = 1
      else if (dist > SWEEP.resume) fleet.sweepLeg = 0
    }
  }
  if (state.fleets.length > 2) assignTargets(state)
  if (state.maneuver === 'shaped') {
    if (state.fleets.length > 2) {
      for (const fleet of state.fleets) {
        if (fleet.ships > 0) updatePlan(state, fleet.side, fleet.index)
      }
    } else {
      updatePlan(state, 0)
      updatePlan(state, 1)
    }
  }
  for (const division of state.divisions) {
    if (division.alive === 0) {
      division.guard = 0
      division.broadsideOk = false
      continue
    }
    const threat = assessDivision(state, division)
    division.guard = threat.weight
    division.guardX = threat.x
    division.guardY = threat.y
    division.broadsideOk = threat.broadside
  }
  for (const division of state.divisions) {
    if (division.alive === 0) continue
    const enemy: SideId = division.side === 0 ? 1 : 0
    const fleet = (state.fleets.length > 2 ? state.fleets[division.fleet] : state.fleets[division.side]) ?? state.fleets[division.side]
    if (!fleet) continue
    division.yielding = fleet.maneuver === 'breakout' || fleet.maneuver === 'reform'
    division.sprint = fleet.maneuver === 'envelop' || fleet.maneuver === 'seize'
    const manual = fleet.commanderId === 'manual'
    if (division.ordered && !manual) division.ordered = false
    if (division.ordered && manual) {
      stepMoveOrder(division, dt)
      continue
    }
    const shaped = state.maneuver === 'shaped' && COMMANDERS[fleet.commanderId].auto
    const apart = Math.hypot(
      (state.centroidX[division.side] ?? 0) - (state.centroidX[enemy] ?? 0),
      (state.centroidY[division.side] ?? 0) - (state.centroidY[enemy] ?? 0),
    )
    const bowMin = classStatsOf(division.classId).batteries[0]?.minRange ?? 280
    const enemyFleet = state.fleets.length > 2 ? state.fleets[fleet.enemyFleet] : undefined
    const ctx = {
      divisions: state.divisions,
      ownX: state.fleets.length > 2 ? fleet.meanX : state.centroidX[division.side],
      ownY: state.fleets.length > 2 ? fleet.meanY : state.centroidY[division.side],
      enemyX: state.fleets.length > 2 ? (enemyFleet?.meanX ?? state.centroidX[enemy]) : state.centroidX[enemy],
      enemyY: state.fleets.length > 2 ? (enemyFleet?.meanY ?? state.centroidY[enemy]) : state.centroidY[enemy],
      sweepLeg: fleet.sweepLeg,
    }
    if (shaped && !fleet.cover && (fleet.maneuver === 'breakout' || apart < bowMin + 10)) {
      stepPlan(state, division, dt)
      continue
    }
    division.shaped = false
    stepDivision(division, ctx, dt, !shaped || fleet.maneuver === 'wheel')
  }
  if (state.fleets.length > 2) separateFleets(state)
  if (state.time >= state.rankAt) {
    rotateRanks(state)
    const every = state.maneuver === 'shaped' ? RANKS.shapedInterval : RANKS.interval
    state.rankAt = state.time + every
  }
  if (state.fallingN > 0) {
    cacheBows(state)
    refreshCover(state)
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
  if (state.fleets.length > 2) {
    for (const fleet of state.fleets) {
      let x = 0
      let y = 0
      let weight = 0
      for (const division of state.divisions) {
        if (division.fleet !== fleet.index || division.alive === 0) continue
        x += division.ax * division.alive
        y += division.ay * division.alive
        weight += division.alive
      }
      if (weight > 0) {
        fleet.meanX = x / weight
        fleet.meanY = y / weight
      }
    }
  }
}

function classStatsOf(id: (typeof SHIP_CLASS_IDS)[number]): ShipStats {
  return CLASS_STATS[SHIP_CLASS_IDS.indexOf(id)] ?? SHIP_STATS
}

function moveShips(state: SimState, dt: number): void {
  const ships = state.ships
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] === 0) continue
    const stats = CLASS_STATS[ships.shipClass[i] ?? 0] ?? state.stats
    const reverse = stats.maxSpeed * stats.reverse
    const accel = thrust(stats.response) * dt
    const division = state.divisions[ships.division[i] ?? 0]
    if (!division) continue
    const x = ships.x[i] ?? 0
    const y = ships.y[i] ?? 0
    const tx = division.ax + division.rx * (ships.slotX[i] ?? 0) + division.fx * (ships.slotY[i] ?? 0)
    const ty = division.ay + division.ry * (ships.slotX[i] ?? 0) + division.fy * (ships.slotY[i] ?? 0)
    const dx = tx - x
    const dy = ty - y
    const dist = Math.hypot(dx, dy)
    const guns = TACTICS[division.tacticId].guns && !division.sweeping
    let desired = Math.atan2(division.fy, division.fx)
    const target = ships.target[i] ?? -1
    const falling = ships.falling[i] === 1
    if (falling && dist > 8) {
      const enemy = ships.side[i] === 1 ? 0 : 1
      const threat = Math.atan2((state.centroidY[enemy] ?? 0) - y, (state.centroidX[enemy] ?? 0) - x)
      const aim = Math.atan2(dy, dx)
      const delta = wrapAngle(aim - threat)
      // The rally point is behind. Keep the bow toward the enemy and creep, so the stern stays out of their guns.
      desired = Math.abs(delta) > (70 * Math.PI) / 180 ? threat : aim
    } else if (division.shaped && division.focus) {
      desired = Math.atan2(division.fy, division.fx)
    } else if (division.shaped) {
      let chase = ships.approach[i] === 1
      if (dist > 180) chase = true
      else if (dist < 90) chase = false
      ships.approach[i] = chase ? 1 : 0
      desired = chase ? Math.atan2(dy, dx) : Math.atan2(division.fy, division.fx)
    } else if (!guns && dist > 22) {
      desired = Math.atan2(dy, dx)
    } else if (target >= 0 && ships.alive[target] === 1) {
      desired = Math.atan2((ships.y[target] ?? 0) - y, (ships.x[target] ?? 0) - x)
    }
    desired = threatenedHeading(division, desired, x, y)
    const prevHeading = ships.heading[i] ?? desired
    const prevSpeed = (ships.vx[i] ?? 0) * Math.cos(prevHeading) + (ships.vy[i] ?? 0) * Math.sin(prevHeading)
    let heading = prevHeading
    const error = wrapAngle(desired - heading)
    const spun = stepYaw(ships.yaw[i] ?? 0, error, stats.turnRate, stats.yawAccel, dt)
    ships.yaw[i] = spun.yaw
    heading += spun.delta
    ships.heading[i] = heading
    const hx = Math.cos(heading)
    const hy = Math.sin(heading)
    const along = dist > 1e-4 ? (dx * hx + dy * hy) / dist : 1
    let speed = 0
    if (dist < 8) speed = along < 0 ? -reverse * 0.2 : Math.min(stats.maxSpeed * 0.2, dist)
    else if (along > 0.2) speed = Math.min(stats.maxSpeed, dist * 1.5)
    else if (along < -0.2) speed = -reverse
    const off = Math.abs(error)
    if (off > 0.8) speed *= 0.45
    else if (off > 0.35) speed *= 0.75
    const stepSpeed = prevSpeed + Math.max(-accel, Math.min(accel, speed - prevSpeed))
    speed = stepSpeed
    ships.vx[i] = hx * speed
    ships.vy[i] = hy * speed
    ships.x[i] = x + hx * speed * dt
    ships.y[i] = y + hy * speed * dt
    if ((ships.flash[i] ?? 0) > 0) ships.flash[i] = Math.max(0, (ships.flash[i] ?? 0) - dt * 4)
  }
}

function fight(state: SimState, dt: number): void {
  const ships = state.ships
  cacheBows(state)
  cacheSpread(state)
  fillSpatialHash(state.scratch.hash, ships.x, ships.y, ships.alive, ships.count)
  state.scratch.opened.set(ships.hp)
  state.scratch.incoming.fill(0)
  if (state.gunnery === 'legacy') {
    fightLegacy(state, dt)
    return
  }
  const blue = state.scratch.ready.blue
  const red = state.scratch.ready.red
  let n0 = 0
  let n1 = 0
  // Large steps already fire on the frame cooldown elapses. Small steps stagger ships that are still waiting.
  const period = dt >= 0.05 ? 1 : Math.max(1, Math.round(0.45 / dt))
  const frame = state.frame
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] === 0) continue
    tickBatteries(state, i, dt)
    scatterWaiting(state, i, dt)
    if (anyBatteryReady(state, i)) {
      const look = state.scratch.look[i] ?? -1
      let fresh = false
      for (let b = 0; b < state.stats.batteries.length; b++) {
        const now = batteryCooldown(state, i, b)
        if (now <= COOLDOWN_SLACK && now + dt > COOLDOWN_SLACK) fresh = true
      }
      if (fresh || look < 0 || frame - look >= period) {
        state.scratch.look[i] = frame
        if (ships.side[i] === 1) red[n1++] = i
        else blue[n0++] = i
      } else noteIdle(state, i, dt, false)
      continue
    }
    const target = ships.target[i] ?? -1
    if (target >= 0 && ships.alive[target] === 0) {
      ships.target[i] = frame % period === i % period ? pickTarget(state, i) : -1
    }
  }
  const pairs = n0 > n1 ? n0 : n1
  for (let k = 0; k < pairs; k++) {
    const left = blue[k] ?? -1
    const right = red[k] ?? -1
    if (k < n0) volley(state, left, dt)
    if (k < n1) volley(state, right, dt)
  }
}

function volley(state: SimState, index: number, dt: number): void {
  fireBatteries(state, index, dt, false)
}

function anyBatteryReady(state: SimState, index: number): boolean {
  const batteries = state.stats.batteries
  for (let b = 0; b < batteries.length; b++) {
    if (batteryCooldown(state, index, b) <= COOLDOWN_SLACK) return true
  }
  return false
}

function tickBatteries(state: SimState, index: number, dt: number): void {
  const batteries = state.stats.batteries
  for (let b = 0; b < batteries.length; b++) {
    setBatteryCooldown(state, index, b, batteryCooldown(state, index, b) - dt)
  }
}

/** A battery that already sat ready does not join the next contact volley. */
function scatterWaiting(state: SimState, index: number, dt: number): void {
  const batteries = state.stats.batteries
  for (let b = 0; b < batteries.length; b++) {
    const now = batteryCooldown(state, index, b)
    if (now > COOLDOWN_SLACK || now + dt >= -COOLDOWN_SLACK) continue
    const battery = batteries[b]
    if (!battery) continue
    setBatteryCooldown(state, index, b, volleyPhase(state.rng, index, b, battery.cooldown))
  }
}

/** The window elapsed with nothing to shoot. Keep this battery on its own clock. */
function holdBattery(state: SimState, index: number, batteryIndex: number, dt: number): void {
  const overdue = batteryCooldown(state, index, batteryIndex)
  if (overdue > COOLDOWN_SLACK) return
  const battery = state.stats.batteries[batteryIndex]
  if (!battery) return
  const carry = overdue < -dt - COOLDOWN_SLACK ? 0 : overdue
  setBatteryCooldown(state, index, batteryIndex, volleyGap(state.rng, index, batteryIndex, battery.cooldown) + carry)
}

function fightLegacy(state: SimState, dt: number): void {
  const ships = state.ships
  const stagger = FIELD.stagger
  const frame = state.frame
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] === 0) continue
    tickBatteries(state, i, dt)
    scatterWaiting(state, i, dt)
    const target = ships.target[i] ?? -1
    const needs = target < 0 || ships.alive[target] === 0 || i % stagger === frame % stagger
    if (needs) acquire(state, i)
    if (!anyBatteryReady(state, i)) continue
    fireBatteries(state, i, dt, true)
  }
}

function noteIdle(state: SimState, index: number, dt: number, searched: boolean): void {
  const ships = state.ships
  state.tally.idle += dt
  const target = ships.target[index] ?? -1
  let outside = true
  if (target >= 0 && ships.alive[target] === 1) {
    const sx = ships.x[index] ?? 0
    const sy = ships.y[index] ?? 0
    const tx = ships.x[target] ?? 0
    const ty = ships.y[target] ?? 0
    const dx = tx - sx
    const dy = ty - sy
    const inRange = dx * dx + dy * dy <= state.stats.range * state.stats.range
    const aimed = inArc(
      state.scratch.bowX[index] ?? 1,
      state.scratch.bowY[index] ?? 0,
      sx,
      sy,
      tx,
      ty,
      state.scratch.cosArc,
    )
    outside = !inRange || !aimed
  }
  if (outside) state.tally.wide += dt
  if (!searched || ships.falling[index] === 1 || state.gunnery === 'aimed') return
  if (hasClearShot(state, index)) state.tally.held += dt
}

function acquire(state: SimState, index: number): void {
  const ships = state.ships
  const division = state.divisions[ships.division[index] ?? 0]
  const sx = ships.x[index] ?? 0
  const sy = ships.y[index] ?? 0
  const side = ships.side[index] === 1 ? 1 : 0
  const half = state.shipCount / 2
  const origin = side === 0 ? half : 0
  const reach = acquireSq(CLASS_STATS[ships.shipClass[index] ?? 0] ?? state.stats)
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
    const arc = (CLASS_STATS[ships.shipClass[index] ?? 0] ?? state.stats).arc
    if (!inFiringArc(ships.heading[index] ?? 0, sx, sy, ships.x[other]!, ships.y[other]!, arc)) continue
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

function fireBatteries(state: SimState, index: number, dt: number, legacy: boolean): void {
  const ships = state.ships
  const batteries = (CLASS_STATS[ships.shipClass[index] ?? 0] ?? state.stats).batteries
  let maxR = 0
  for (const battery of batteries) maxR = Math.max(maxR, battery.maxRange)
  const sx = ships.x[index] ?? 0
  const sy = ships.y[index] ?? 0
  const enemy = ships.side[index] === 1 ? 0 : 1
  const cdx = (state.centroidX[enemy] ?? 0) - sx
  const cdy = (state.centroidY[enemy] ?? 0) - sy
  if (cdx * cdx + cdy * cdy > (maxR + 220) * (maxR + 220)) {
    for (let b = 0; b < batteries.length; b++) holdBattery(state, index, b, dt)
    if (batteryCooldown(state, index, 0) <= COOLDOWN_SLACK) noteIdle(state, index, dt, true)
    return
  }
  const n = collectNear(state.scratch.hash, sx, sy, maxR, ships.x, ships.y)
  const found = state.scratch.hash.found
  let bowTried = false
  let bowFired = false
  for (let b = 0; b < batteries.length; b++) {
    if (batteryCooldown(state, index, b) > COOLDOWN_SLACK) continue
    const battery = batteries[b]
    if (!battery) continue
    const target = pickBatteryTarget(state, index, battery, found, n, legacy)
    if (b === 0) {
      ships.target[index] = target
      bowTried = true
    }
    const fired = target >= 0 && shootBattery(state, index, target, b, dt)
    if (fired) {
      if (b === 0) bowFired = true
    } else holdBattery(state, index, b, dt)
  }
  if (bowTried && !bowFired) noteIdle(state, index, dt, true)
}

function shootBattery(state: SimState, index: number, target: number, batteryIndex: number, dt: number): boolean {
  const battery = (CLASS_STATS[state.ships.shipClass[index] ?? 0] ?? state.stats).batteries[batteryIndex]
  if (!battery) return false
  const ships = state.ships
  if (ships.alive[target] === 0) return false
  const sx = ships.x[index] ?? 0
  const sy = ships.y[index] ?? 0
  const tx = ships.x[target] ?? 0
  const ty = ships.y[target] ?? 0
  const hx = state.scratch.bowX[index] ?? 1
  const hy = state.scratch.bowY[index] ?? 0
  if (!inBattery(hx, hy, sx, sy, tx, ty, battery)) return false
  const overdue = batteryCooldown(state, index, batteryIndex)
  const carry = overdue < -dt - COOLDOWN_SLACK ? 0 : overdue
  setBatteryCooldown(state, index, batteryIndex, volleyGap(state.rng, index, batteryIndex, battery.cooldown) + carry)
  const side = ships.side[index] === 1 ? 1 : 0
  const victim = CLASS_STATS[ships.shipClass[target] ?? 0] ?? state.stats
  const zone = armorZone(ships.heading[target] ?? 0, tx, ty, sx, sy, victim)
  const factor = zone === 'front' ? victim.armorFront : zone === 'rear' ? victim.armorRear : victim.armorSide
  const scale = (state.damage[side] ?? state.stats.damage) / Math.max(0.01, state.stats.damage)
  const blow = battery.guns * battery.power * scale * factor
  const opened = state.scratch.opened[target] ?? 0
  const queued = state.scratch.incoming[target] ?? 0
  if ((ships.hp[target] ?? 0) <= 0 || (opened > 0 && queued >= opened)) state.tally.overkill += 1
  state.scratch.incoming[target] = queued + blow * GUNNERY.reserve
  state.tally.shots += 1
  const hit = rand(state) <= state.stats.hitChance
  const spread = hit ? 0.4 : 8
  const ox = (rand(state) - 0.5) * spread
  const oy = (rand(state) - 0.5) * spread
  const mount = batteryMount(hx, hy, battery.id)
  spawnBeam(state, sx + mount.x, sy + mount.y, tx + ox, ty + oy, side, batteryIndex === 0 ? 0 : 1)
  if (!hit) return true
  state.hits[zone][side] += 1
  const before = ships.hp[target] ?? 0
  state.tally.hits += 1
  const dealt = Math.min(before, blow)
  state.tally.damage += dealt
  const shooterClass = ships.shipClass[index] ?? 0
  state.classDamage[shooterClass] = (state.classDamage[shooterClass] ?? 0) + dealt
  const victimClass = ships.shipClass[target] ?? 0
  state.classOnClass[shooterClass * 3 + victimClass] = (state.classOnClass[shooterClass * 3 + victimClass] ?? 0) + dealt
  ships.hp[target] = before - blow
  ships.flash[target] = 1
  if ((ships.hp[target] ?? 0) <= 0) destroy(state, target)
  return true
}

function batteryMount(hx: number, hy: number, id: string): { x: number; y: number } {
  const lx = -hy
  const ly = hx
  if (id === 'port') return { x: lx * 8, y: ly * 8 }
  if (id === 'starboard') return { x: -lx * 8, y: -ly * 8 }
  return { x: hx * 14, y: hy * 14 }
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
  state.tally.deaths += 1
  state.tally.deathTime += state.time
  const slot = state.booms.head
  state.booms.head = (slot + 1) % FIELD.maxBooms
  state.booms.x[slot] = ships.x[index] ?? 0
  state.booms.y[slot] = ships.y[index] ?? 0
  state.booms.life[slot] = FIELD.boomLife
  state.booms.side[slot] = side
}

function spawnBeam(state: SimState, x1: number, y1: number, x2: number, y2: number, side: number, kind: number): void {
  const slot = state.beams.head
  state.beams.head = (slot + 1) % FIELD.maxBeams
  state.beams.x1[slot] = x1
  state.beams.y1[slot] = y1
  state.beams.x2[slot] = x2
  state.beams.y2[slot] = y2
  state.beams.life[slot] = kind === 0 ? FIELD.beamLife : FIELD.beamLifeSide
  state.beams.side[slot] = side
  state.beams.kind[slot] = kind
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
