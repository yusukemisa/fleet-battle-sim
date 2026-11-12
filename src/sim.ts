import { acquireSq, BLAST, CLASS_STATS, DEFAULT_LINE, FIELD, FLEET_STANDOFF, fleetLine, GUNNERY, hullHp, hullRadius, RANKS, SHIP_CLASS_IDS, SHIP_STATS, SIM_TIME_SCALE, SLOT_PITCH, STRAY, SWEEP, stepYawInto, volleyGap, volleyPhase, type ShipClassId, type ShipStats } from './balance.ts'
import { anchorFleets, assignTargets, fitGroups, fleetIndex, FLEET_NAMES as FLEET_TITLES, separateFleets } from './fleets.ts'
import { armorZone, inArc, inBattery, inFiringArc, wrapAngle } from './combat.ts'
import { chooseTactic, COMMANDERS, employClass, type BattleFacts, type Bearing } from './commanders.ts'
import { formationExtent, layoutFormation } from './formations.ts'
import { batteryCooldown, blastDamage, cacheBows, cacheSpread, crossfireScale, emptyTally, hasClearShot, pickBatteryTarget, pickTarget, setBatteryCooldown, shotBlocked, strayChance } from './gunnery.ts'
import { refreshCover, rotateRanks } from './ranks.ts'
import { collectInto, collectNear, createScratch, fillSpatialHash } from './spatial.ts'
import { orderPoints, stepMoveOrder } from './move.ts'
import { assessDivision, threatenedHeading } from './threat.ts'
import { avoidanceVectors, separateShips, steerClear } from './collide.ts'
import { appointFlagships, commandMods, commandRates, noteFlagshipLoss, refreshCommand } from './flagship.ts'
import { BACK_OFF, GUN_HOLD, holdFronts, holdVectors } from './standoff.ts'
import { decideTransformer, forgetTransformer, recordDecision, tacticsFrom } from './brain/dt.ts'
import { featurize } from './brain/features.ts'
import { DECISION_INTERVAL, decidePolicy, defaultBrain, preferredFormation } from './brain/policy.ts'
import { observe } from './brain/observe.ts'
import { stepPlan, updatePlan } from './posture.ts'
import { TACTICS, stepDivision, tacticById } from './tactics.ts'
import {
  DEFAULT_COMMANDER,
  DEFAULT_FORMATION,
  DIVISIONS_PER_SIDE,
  DIVISION_NAMES,
  idleAi,
  type BattlePhase,
  type BrainOrder,
  type Command,
  type Division,
  type DivisionSlot,
  type Fleet,
  type FleetSetup,
  type FormationId,
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
  state.fleets[0].brain = config.brains?.[0] ?? defaultBrain(commanders[0])
  state.fleets[1].brain = config.brains?.[1] ?? defaultBrain(commanders[1])
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
    case 'set-fleet-brain':
      return setFleetBrain(state, command.fleet, command.brain)
    case 'brain-thinking':
      return markBrain(state, command.fleet, 'thinking')
    case 'brain-decision':
      return acceptBrain(state, command.fleet, command.orders, command.note, command.latencyMs)
    case 'brain-fallback':
      return fallbackBrain(state, command.fleet, command.latencyMs)
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
      adoptCommanderBrain(state.fleets[command.side])
      if (state.groups) state.groups = patchGroup(state.groups, command.side, { commanderId: command.commanderId, brain: state.fleets[command.side].brain })
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
      chooseAiFormation(state)
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
    brains: [state.fleets[0].brain, state.fleets[1].brain],
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
    { side: 0, ships: state.fleets[0].ships, formationId: state.fleets[0].formationId, commanderId: state.fleets[0].commanderId, brain: state.fleets[0].brain },
    { side: 1, ships: state.fleets[1].ships, formationId: state.fleets[1].formationId, commanderId: state.fleets[1].commanderId, brain: state.fleets[1].brain },
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
        brain: defaultBrain(seed?.commanderId ?? DEFAULT_COMMANDER),
      })
    }
    return [...kept, ...next]
  }
  if (command.type === 'set-fleet-ships') {
    const fleet = state.fleets[command.fleet]
    if (!fleet) return current
    let seen = 0
    return current.map((group) => {
      if (group.side !== fleet.side) return group
      const ordinal = seen
      seen += 1
      if (ordinal !== fleet.ordinal) return group
      return { ...group, ships: command.ships }
    })
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
      return { ...group, commanderId: command.commanderId, brain: defaultBrain(command.commanderId) }
    })
  }
  return current
}

function createGrouped(config: SimConfig): SimState {
  const fit = fitGroups(config.groups ?? [])
  const groups = fit.groups
  const total = groups.reduce((sum, group) => sum + group.ships, 0)
  const state = allocate(total, shipStats(config), config.damage ? [config.damage[0], config.damage[1]] : [shipStats(config).damage, shipStats(config).damage], config.gunnery ?? 'aimed', config.maneuver ?? 'shaped', config.withdraw ?? [true, true])
  state.groups = fit.requested
  state.shipCount = total
  state.fitNotice = fit.notice
  const counts: [number, number] = [0, 0]
  const plans = groups.map((group, index) => {
    const ordinal = counts[group.side]
    counts[group.side] += 1
    return { ...group, requested: fit.requested[index]?.ships ?? group.ships, ordinal, index: fleetIndex(group.side, ordinal) }
  })
  const max = plans.reduce((hi, plan) => Math.max(hi, plan.index), 1)
  const fleets: Fleet[] = []
  for (let index = 0; index <= max; index++) {
    const plan = plans.find((item) => item.index === index)
    const side: SideId = index % 2 === 0 ? 0 : 1
    const ordinal = Math.floor(index / 2)
    const anchor = { x: side === 0 ? -FIELD.fleetCenter : FIELD.fleetCenter, y: 0 }
    const name = FLEET_TITLES[side][ordinal] ?? FLEET_TITLES[side][0] ?? '軍'
    fleets[index] = {
      index,
      ordinal: plan ? plan.ordinal : ordinal,
      side,
      name,
      ships: plan?.ships ?? 0,
      requested: plan?.requested ?? 0,
      formationId: plan?.formationId ?? DEFAULT_FORMATION,
      commanderId: plan?.commanderId ?? DEFAULT_COMMANDER,
      brain: plan?.brain ?? defaultBrain(plan?.commanderId ?? DEFAULT_COMMANDER),
      ai: idleAi(),
      orders: null,
      centerX: anchor.x,
      centerY: anchor.y,
      meanX: anchor.x,
      meanY: anchor.y,
      enemyFleet: side === 0 ? 1 : 0,
      cover: false,
      plan: 'none',
      planUntil: 0,
      facingX: side === 0 ? 1 : -1,
      facingY: 0,
      sweepLeg: 0,
      maneuver: 'press',
      maneuverUntil: 0,
      prey: -1,
      bias: 1,
      reach: 0,
      flagship: -1,
      flagAt: 0,
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
  reflowAnchors(state)
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
  state.dealt[0] = 0
  state.dealt[1] = 0
  state.ram = 0
  state.collisionDeaths[0] = 0
  state.collisionDeaths[1] = 0
  state.destroyerDealt[0] = 0
  state.destroyerDealt[1] = 0
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
  appointFlagships(state)
}

function reflowAnchors(state: SimState): void {
  for (const side of [0, 1] as const) {
    const ours = state.fleets.filter((fleet) => fleet.side === side && fleet.ships > 0)
    const anchors = anchorFleets(
      side,
      ours.map((fleet) => {
        const extent = formationExtent(fleet.formationId, fleet.ships)
        return { ordinal: fleet.ordinal, halfY: extent.halfY, forward: extent.forward }
      }),
    )
    ours.forEach((fleet, index) => {
      const anchor = anchors[index]
      if (!anchor) return
      fleet.centerX = anchor.x
      fleet.centerY = anchor.y
      fleet.meanX = anchor.x
      fleet.meanY = anchor.y
    })
  }
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
    division.flagship = -1
    division.flagAt = 0
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
  let reach = 0
  for (let i = 0; i < count; i++) {
    const dy = Math.abs((ships.y[offset + i] ?? 0) - centerY)
    if (dy > reach) reach = dy
  }
  fleet.reach = reach
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
      if (!commander.auto || !rulesDrive(fleet)) continue
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
    if (!commander.auto || !rulesDrive(fleet)) continue
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
      headingCos: new Float64Array(count),
      headingSin: new Float64Array(count),
      headingStamp: new Float32Array(count),
      headingKnown: new Uint8Array(count),
      yaw: new Float32Array(count),
      alive: new Uint8Array(count),
      side: new Uint8Array(count),
      shipClass: new Uint8Array(count),
      division: new Uint8Array(count),
      command: new Uint8Array(count),
      target: new Int32Array(count),
    },
    fleets: [
      { index: 0, ordinal: 0, side: 0, name: FLEET_NAMES[0], ships: count / 2, requested: count / 2, formationId: DEFAULT_FORMATION, commanderId: DEFAULT_COMMANDER, brain: 'rule', ai: idleAi(), orders: null, centerX: -FIELD.fleetCenter, centerY: 0, meanX: -FIELD.fleetCenter, meanY: 0, enemyFleet: 1, cover: false, plan: 'none', planUntil: 0, facingX: 1, facingY: 0, sweepLeg: 0, maneuver: 'press', maneuverUntil: 0, prey: -1, bias: 1, reach: 0, flagship: -1, flagAt: 0 },
      { index: 1, ordinal: 0, side: 1, name: FLEET_NAMES[1], ships: count / 2, requested: count / 2, formationId: DEFAULT_FORMATION, commanderId: DEFAULT_COMMANDER, brain: 'rule', ai: idleAi(), orders: null, centerX: FIELD.fleetCenter, centerY: 0, meanX: FIELD.fleetCenter, meanY: 0, enemyFleet: 0, cover: false, plan: 'none', planUntil: 0, facingX: -1, facingY: 0, sweepLeg: 0, maneuver: 'press', maneuverUntil: 0, prey: -1, bias: 1, reach: 0, flagship: -1, flagAt: 0 },
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
    dealt: [0, 0],
    ram: 0,
    collisionDeaths: [0, 0],
    destroyerDealt: [0, 0],
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
    fitNotice: null,
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
    pack: 0,
    press: 0,
    flagship: -1,
    flagAt: 0,
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
  state.dealt[0] = 0
  state.dealt[1] = 0
  state.ram = 0
  state.collisionDeaths[0] = 0
  state.collisionDeaths[1] = 0
  state.destroyerDealt[0] = 0
  state.destroyerDealt[1] = 0
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
  state.fleets[0].flagship = -1
  state.fleets[1].flagship = -1
  state.fleets[0].flagAt = 0
  state.fleets[1].flagAt = 0
  for (const side of sides) placeSide(state, side, half)
  state.alive[0] = half
  state.alive[1] = half
  refreshCentroids(state)
  appointFlagships(state)
}

function placeSide(state: SimState, side: SideId, half: number): void {
  const layout = layoutFormation(state.fleets[side].formationId, half)
  const ships = state.ships
  const offset = side * half
  let forward = 0
  let halfY = 0
  for (let i = 0; i < half; i++) {
    forward = Math.max(forward, layout.y[i] ?? 0)
    halfY = Math.max(halfY, Math.abs(layout.x[i] ?? 0))
  }
  const magnitude = Math.max(FIELD.fleetCenter, forward + FLEET_STANDOFF)
  const centerX = side === 0 ? -magnitude : magnitude
  const fleet = state.fleets[side]
  if (fleet) {
    fleet.centerX = centerX
    fleet.meanX = centerX
    fleet.reach = halfY
  }
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
    division.flagship = -1
    division.flagAt = 0
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
}

/** Rule fleets, and AI fleets that have no valid orders yet, keep the existing commander. */
function usesModel(fleet: Fleet): boolean {
  return fleet.brain === 'ai' || fleet.brain === 'dt'
}

function rulesDrive(fleet: Fleet): boolean {
  return !usesModel(fleet) || fleet.ai.status === 'fallback' || fleet.orders === null
}

function chooseAiFormation(state: SimState): void {
  const picks: { fleet: Fleet; formationId: FormationId }[] = []
  for (const fleet of state.fleets) {
    if (!fleet || !usesModel(fleet) || fleet.ships <= 0) continue
    const enemy = state.fleets[fleet.enemyFleet]
    if (!enemy) continue
    const formationId = preferredFormation(fleet.commanderId, enemy.formationId)
    if (!formationId || formationId === fleet.formationId) continue
    picks.push({ fleet, formationId })
  }
  if (picks.length === 0) return
  for (const pick of picks) pick.fleet.formationId = pick.formationId
  deploy(state)
}

function adoptCommanderBrain(fleet: Fleet | undefined): void {
  if (!fleet) return
  forgetTransformer(fleet)
  fleet.brain = defaultBrain(fleet.commanderId)
  fleet.orders = null
  const fallbacks = fleet.ai.fallbacks
  fleet.ai = idleAi()
  fleet.ai.fallbacks = fallbacks
}

function rememberBrain(state: SimState, fleet: Fleet): void {
  if (!state.groups) return
  let seen = 0
  state.groups = state.groups.map((group) => {
    if (group.side !== fleet.side) return group
    const ordinal = seen
    seen += 1
    if (ordinal !== fleet.ordinal) return group
    return { ...group, brain: fleet.brain }
  })
}

function setFleetBrain(state: SimState, index: number, brain: Fleet['brain']): SimState {
  const fleet = state.fleets[index]
  if (!fleet) return state
  fleet.brain = brain
  forgetTransformer(fleet)
  if (brain === 'rule') {
    fleet.orders = null
    const fallbacks = fleet.ai.fallbacks
    fleet.ai = idleAi()
    fleet.ai.fallbacks = fallbacks
  }
  rememberBrain(state, fleet)
  return state
}

function markBrain(state: SimState, index: number, status: Fleet['ai']['status']): SimState {
  const fleet = state.fleets[index]
  if (!fleet || !usesModel(fleet)) return state
  if (fleet.ai.status !== 'fallback') fleet.ai.status = status
  return state
}

function acceptBrain(state: SimState, index: number, orders: BrainOrder[], note: string, latencyMs: number): SimState {
  const fleet = state.fleets[index]
  if (!fleet || !usesModel(fleet)) return state
  fleet.orders = orders
  fleet.ai.status = 'ready'
  fleet.ai.note = note
  fleet.ai.latencyMs = latencyMs
  fleet.ai.decidedAt = state.time
  holdBrainOrders(state, fleet)
  return state
}

function fallbackBrain(state: SimState, index: number, latencyMs: number): SimState {
  const fleet = state.fleets[index]
  if (!fleet || !usesModel(fleet)) return state
  fleet.orders = null
  fleet.ai.status = 'fallback'
  fleet.ai.latencyMs = latencyMs
  fleet.ai.fallbacks += 1
  fleet.ai.note = 'ルールに戻しました'
  fleet.ai.decidedAt = state.time
  return state
}

function holdBrainOrders(state: SimState, fleet: Fleet): void {
  if (!fleet.orders) return
  for (const order of fleet.orders) {
    const division = state.divisions[order.division]
    if (!division || division.fleet !== fleet.index || division.alive === 0) continue
    if (division.tacticId !== order.tacticId) applyTactic(state, order.division, order.tacticId)
    if (order.target !== undefined) division.hunt = order.target
    if (order.move) {
      division.ordered = true
      division.orderX = order.move.x
      division.orderY = order.move.y
      division.orderH = order.move.heading
    } else {
      division.ordered = false
    }
  }
}

function driveAi(state: SimState): void {
  for (const fleet of state.fleets) {
    if (!fleet || !usesModel(fleet) || fleet.ships <= 0) continue
    if (fleet.orders && state.time < fleet.ai.decidedAt + DECISION_INTERVAL) continue
    const started = performance.now()
    const observation = observe(state, fleet.index)
    const decision = fleet.brain === 'dt' ? decideTransformer(fleet, observation) : decidePolicy(observation)
    fleet.ai.latencyMs = Math.round((performance.now() - started) * 100) / 100
    fleet.ai.decidedAt = state.time
    if (!decision) {
      if (fleet.ai.status !== 'fallback') fleet.ai.fallbacks += 1
      fleet.orders = null
      fleet.ai.status = 'fallback'
      const name = COMMANDERS[fleet.commanderId].name
      fleet.ai.note = `${name}の方策がないのでルールで代行`
      continue
    }
    fleet.orders = decision.orders
    fleet.ai.status = 'ready'
    fleet.ai.note = decision.note
    recordDecision(fleet.index, featurize(observation), tacticsFrom(observation, decision.orders))
  }
}

function step(state: SimState, dt: number): void {
  appointFlagships(state)
  refreshCommand(state)
  refreshCentroids(state)
  driveAi(state)
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
        if (fleet.ships > 0 && rulesDrive(fleet)) updatePlan(state, fleet.side, fleet.index)
      }
    } else {
      if (state.fleets[0] && rulesDrive(state.fleets[0])) updatePlan(state, 0)
      if (state.fleets[1] && rulesDrive(state.fleets[1])) updatePlan(state, 1)
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
    const brainMove = !rulesDrive(fleet)
    if (brainMove) holdBrainOrders(state, fleet)
    if (division.ordered && !manual && !brainMove) division.ordered = false
    if (division.ordered && (manual || brainMove)) {
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
  holdFronts(state)
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

let motionSpeed = new Float32Array(0)
let motionHeading = new Float32Array(0)

function cacheDivisionMotion(state: SimState): void {
  const n = state.divisions.length
  if (motionSpeed.length < n) {
    motionSpeed = new Float32Array(n)
    motionHeading = new Float32Array(n)
  }
  for (let index = 0; index < n; index++) {
    const division = state.divisions[index]
    if (!division) continue
    motionSpeed[index] = Math.hypot(division.vx, division.vy)
    motionHeading[index] = Math.atan2(division.fy, division.fx)
  }
}

function moveShips(state: SimState, dt: number): void {
  const ships = state.ships
  steerClear(state)
  cacheDivisionMotion(state)
  const [turnOf, responseOf] = commandRates()
  const [gapOf, awayXOf, awayYOf] = holdVectors()
  const [avoidXs, avoidYs, brakes] = avoidanceVectors()
  const spun = { yaw: 0, delta: 0 }
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] === 0) continue
    const stats = CLASS_STATS[ships.shipClass[i] ?? 0] ?? state.stats
    const reverse = stats.maxSpeed * stats.reverse
    const modsTurn = turnOf[i] ?? 1
    const accel = stats.response * (responseOf[i] ?? 1) * 14 * dt
    const turnRate = stats.turnRate * modsTurn
    const divisionIndex = ships.division[i] ?? 0
    const division = state.divisions[divisionIndex]
    if (!division) continue
    const x = ships.x[i] ?? 0
    const y = ships.y[i] ?? 0
    const tx = division.ax + division.rx * (ships.slotX[i] ?? 0) + division.fx * (ships.slotY[i] ?? 0)
    const ty = division.ay + division.ry * (ships.slotX[i] ?? 0) + division.fy * (ships.slotY[i] ?? 0)
    const dx = tx - x
    const dy = ty - y
    const dist = Math.hypot(dx, dy)
    const guns = TACTICS[division.tacticId].guns && !division.sweeping
    const divisionHeading = motionHeading[divisionIndex] ?? 0
    // Inside one slot pitch the station is close enough. Chasing it makes a blocked ship
    // yaw toward a point that collision keeps moving to the other side.
    const settled = dist <= SLOT_PITCH
    const target = ships.target[i] ?? -1
    let targetInRange = false
    if (target >= 0 && ships.alive[target] === 1) {
      const rdx = (ships.x[target] ?? 0) - x
      const rdy = (ships.y[target] ?? 0) - y
      const reach = stats.range
      targetInRange = rdx * rdx + rdy * rdy <= reach * reach
    }
    const classId = ships.shipClass[i] ?? 0
    const stranded = classId === 2 ? 180 : 480
    const battleship = classId === 0
    const fleet = state.fleets[division.fleet]
    const ring = fleet?.formationId === 'houen'
    let divSpeed = 0
    let stuck = false
    let catching = false
    let keepUp = false
    if (battleship && !ring && !targetInRange) {
      const svx = ships.vx[i] ?? 0
      const svy = ships.vy[i] ?? 0
      const speedSq = svx * svx + svy * svy
      divSpeed = motionSpeed[divisionIndex] ?? 0
      const slotAhead = dx * division.vx + dy * division.vy
      // A stopped battleship whose slot is pulling away turns back. 方円 is left
      // on the old distance rule so the ring does not unfold.
      stuck = dist > 60 && speedSq < 36 && divSpeed > 4 && slotAhead > 80
      // Large blocks never reach the 480 rejoin line: the ship is still inside
      // the formation. Point it at the slot until it is moving.
      keepUp = division.roster >= 40 && dist <= stranded && (speedSq <= 196 || dist <= SLOT_PITCH)
      if (dist > SLOT_PITCH && speedSq > 16) {
        const headingNow = ships.heading[i] ?? 0
        const towardSlot = dx * Math.cos(headingNow) + dy * Math.sin(headingNow)
        catching = towardSlot > 16
      }
    }
    const rejoin = (!targetInRange && dist > stranded) || stuck || catching || keepUp
    let desired = divisionHeading
    const falling = ships.falling[i] === 1
    if (rejoin) desired = dist <= SLOT_PITCH ? divisionHeading : Math.atan2(dy, dx)
    else if (falling && dist > 8) {
      const enemy = ships.side[i] === 1 ? 0 : 1
      const threat = Math.atan2((state.centroidY[enemy] ?? 0) - y, (state.centroidX[enemy] ?? 0) - x)
      const aim = Math.atan2(dy, dx)
      const delta = wrapAngle(aim - threat)
      // The rally point is behind. Keep the bow toward the enemy and creep, so the stern stays out of their guns.
      desired = Math.abs(delta) > (70 * Math.PI) / 180 ? threat : aim
    } else if (division.shaped && division.focus) {
      desired = divisionHeading
    } else if (division.shaped) {
      let chase = ships.approach[i] === 1
      if (dist > 180) chase = true
      else if (dist < 90) chase = false
      ships.approach[i] = chase ? 1 : 0
      desired = chase ? Math.atan2(dy, dx) : divisionHeading
    } else if (!guns && !settled) {
      desired = Math.atan2(dy, dx)
    } else if (target >= 0 && ships.alive[target] === 1) {
      desired = Math.atan2((ships.y[target] ?? 0) - y, (ships.x[target] ?? 0) - x)
    }
    if (!rejoin && division.guard > 0 && !division.yielding && !division.broadsideOk) {
      desired = threatenedHeading(division, desired, x, y)
    }
    const gap = gapOf[divisionIndex] ?? 1e6
    const hold = GUN_HOLD[classId] ?? GUN_HOLD[0]
    const tooClose = division.roster >= 40 && gap < hold
    if (tooClose) {
      const sx = awayXOf[divisionIndex] ?? 0
      const sy = awayYOf[divisionIndex] ?? 0
      // The whole hold keeps the bow on the enemy, including the reverse out of
      // the inner band. Pointing the bow away silences every battery.
      desired = Math.atan2(-sy, -sx)
    }
    const axv = avoidXs[i] ?? 0
    const ayv = avoidYs[i] ?? 0
    const avoidMag = axv * axv + ayv * ayv
    const caution = avoidMag > 0.04
    if (avoidMag > 0.2) desired = Math.atan2(ayv, axv)
    else if (caution) desired += wrapAngle(Math.atan2(ayv, axv) - desired) * 0.8
    const prevHeading = ships.heading[i] ?? desired
    let prevCos = ships.headingCos[i] ?? 0
    let prevSin = ships.headingSin[i] ?? 0
    if (ships.headingKnown[i] !== 1 || ships.headingStamp[i] !== prevHeading) {
      prevCos = Math.cos(prevHeading)
      prevSin = Math.sin(prevHeading)
    }
    const prevSpeed = (ships.vx[i] ?? 0) * prevCos + (ships.vy[i] ?? 0) * prevSin
    let heading = prevHeading
    const error = wrapAngle(desired - heading)
    stepYawInto(spun, ships.yaw[i] ?? 0, error, turnRate, stats.yawAccel, dt)
    ships.yaw[i] = spun.yaw
    heading += spun.delta
    ships.heading[i] = heading
    const stored = ships.heading[i] ?? heading
    const hx = Math.cos(heading)
    const hy = Math.sin(heading)
    ships.headingCos[i] = stored === heading ? hx : Math.cos(stored)
    ships.headingSin[i] = stored === heading ? hy : Math.sin(stored)
    ships.headingStamp[i] = stored
    ships.headingKnown[i] = 1
    const along = dist > 1e-4 ? (dx * hx + dy * hy) / dist : 1
    let speed = 0
    if (settled) speed = along > 0.5 ? Math.min(14, dist) : 0
    else if (dist < 8) speed = along < 0 ? -reverse * 0.2 : Math.min(stats.maxSpeed * 0.2, dist)
    else if (along > 0.2) speed = Math.min(stats.maxSpeed, dist * 1.5)
    else if (along < -0.2) speed = -reverse
    if (keepUp) speed = Math.max(speed, Math.min(stats.maxSpeed, Math.max(divSpeed, 18)))
    if (battleship && division.roster >= 40 && dist < 160) speed = Math.min(speed, 14)
    const off = Math.abs(error)
    if (off > 0.8) speed *= 0.45
    else if (off > 0.35) speed *= 0.75
    if (avoidMag > 0.2) speed *= 0.35
    else if (caution) speed *= 0.62
    speed *= 1 - 0.82 * (brakes[i] ?? 0)
    if (tooClose) {
      const inner = BACK_OFF[classId] ?? BACK_OFF[0]
      if (gap >= inner) speed = 0
      else {
        const bowOn = Math.abs(wrapAngle(desired - heading)) < 0.7
        speed = bowOn ? -Math.min(12, Math.max(Math.abs(speed), 8)) : 0
      }
    }
    if (division.roster >= 40) {
      const leaving = tooClose && gap < (BACK_OFF[classId] ?? BACK_OFF[0])
      // Still out of gun range: a slightly faster cruise, still under the
      // collision closing speed when two ships meet head-on.
      const far = gap > hold + 80
      const cap = leaving ? 22 : far ? 26 : 18
      speed = speed < 0 ? -Math.min(-speed, cap) : Math.min(speed, cap)
    }
    const stepSpeed = prevSpeed + Math.max(-accel, Math.min(accel, speed - prevSpeed))
    speed = stepSpeed
    ships.vx[i] = hx * speed
    ships.vy[i] = hy * speed
    ships.x[i] = x + hx * speed * dt
    ships.y[i] = y + hy * speed * dt
    if ((ships.flash[i] ?? 0) > 0) ships.flash[i] = Math.max(0, (ships.flash[i] ?? 0) - dt * 4)
  }
  separateShips(state, dt)
  reapRammed(state)
}

function reapRammed(state: SimState): void {
  const ships = state.ships
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] === 1 && (ships.hp[i] ?? 0) <= 0) destroy(state, i)
  }
}

function fight(state: SimState, dt: number): void {
  const ships = state.ships
  cacheBows(state)
  cacheSpread(state)
  cacheDivisionReach(state)
  fillSpatialHash(state.scratch.hash, ships.x, ships.y, ships.alive, ships.count)
  state.scratch.opened.set(ships.hp)
  state.scratch.incoming.fill(0)
  state.scratch.bearing.fill(99)
  state.scratch.blasts = 0
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
  const cd = ships.cooldown
  const gun = ships.gunCd
  const alive = ships.alive
  const batteries = state.stats.batteries
  const bow = batteries[0]
  const port = batteries[1]
  const starboard = batteries[2]
  const rng = state.rng
  const slack = COOLDOWN_SLACK
  for (let i = 0; i < ships.count; i++) {
    if (alive[i] === 0) continue
    let c0 = (cd[i] ?? 0) - dt
    let c1 = (gun[i * 2] ?? 0) - dt
    let c2 = (gun[i * 2 + 1] ?? 0) - dt
    if (c0 <= slack && c0 + dt < -slack && bow) c0 = volleyPhase(rng, i, 0, bow.cooldown)
    if (c1 <= slack && c1 + dt < -slack && port) c1 = volleyPhase(rng, i, 1, port.cooldown)
    if (c2 <= slack && c2 + dt < -slack && starboard) c2 = volleyPhase(rng, i, 2, starboard.cooldown)
    cd[i] = c0
    gun[i * 2] = c1
    gun[i * 2 + 1] = c2
    if (c0 <= slack || c1 <= slack || c2 <= slack) {
      const look = state.scratch.look[i] ?? -1
      const fresh =
        (c0 <= slack && c0 + dt > slack) ||
        (c1 <= slack && c1 + dt > slack) ||
        (c2 <= slack && c2 + dt > slack)
      if (fresh || look < 0 || frame - look >= period) {
        state.scratch.look[i] = frame
        if (ships.side[i] === 1) red[n1++] = i
        else blue[n0++] = i
      } else noteIdle(state, i, dt, false)
      continue
    }
    const target = ships.target[i] ?? -1
    if (target >= 0 && alive[target] === 0) {
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
  drainBlasts(state)
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
  state.scratch.bearing.fill(99)
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
  drainBlasts(state)
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

let divisionReachSq = new Float64Array(0)
let divisionReach = new Float64Array(0)

/** Farthest living hull from each division anchor, so a gun can be rejected without looking at the enemy centroid. */
function cacheDivisionReach(state: SimState): void {
  const nDiv = state.divisions.length
  if (divisionReachSq.length < nDiv) {
    divisionReachSq = new Float64Array(nDiv)
    divisionReach = new Float64Array(nDiv)
  }
  divisionReachSq.fill(0, 0, nDiv)
  const ships = state.ships
  const xs = ships.x
  const ys = ships.y
  const alive = ships.alive
  const divOf = ships.division
  for (let i = 0; i < ships.count; i++) {
    if (alive[i] !== 1) continue
    const d = divOf[i] ?? 0
    const division = state.divisions[d]
    if (!division) continue
    const dx = (xs[i] ?? 0) - division.ax
    const dy = (ys[i] ?? 0) - division.ay
    const distSq = dx * dx + dy * dy
    if (distSq > (divisionReachSq[d] ?? 0)) divisionReachSq[d] = distSq
  }
  for (let d = 0; d < nDiv; d++) divisionReach[d] = Math.sqrt(divisionReachSq[d] ?? 0)
}

/**
 * True when no enemy hull can be inside `maxR`.
 * A hull within `maxR` of this ship puts its division anchor within `maxR` plus that division's extent.
 */
function enemyOutOfRange(state: SimState, index: number, sx: number, sy: number, maxR: number): boolean {
  const side = state.ships.side[index] === 1 ? 1 : 0
  const enemy = side === 0 ? 1 : 0
  const cdx = (state.centroidX[enemy] ?? 0) - sx
  const cdy = (state.centroidY[enemy] ?? 0) - sy
  if (cdx * cdx + cdy * cdy <= (maxR + 220) * (maxR + 220)) return false
  // Small fleets fit inside the centroid margin. Large ones do not: a wing can
  // be inside gun range while the enemy centroid is still thousands away.
  if (state.ships.count < 2000) return true
  const divisions = state.divisions
  for (let d = 0; d < divisions.length; d++) {
    const division = divisions[d]
    if (!division || division.side === side || division.alive === 0) continue
    const dx = division.ax - sx
    const dy = division.ay - sy
    const limit = maxR + (divisionReach[d] ?? 0) + 1
    if (dx * dx + dy * dy <= limit * limit) return false
  }
  return true
}

function fireBatteries(state: SimState, index: number, dt: number, legacy: boolean): void {
  const ships = state.ships
  const batteries = (CLASS_STATS[ships.shipClass[index] ?? 0] ?? state.stats).batteries
  let maxR = 0
  for (const battery of batteries) maxR = Math.max(maxR, battery.maxRange)
  const sx = ships.x[index] ?? 0
  const sy = ships.y[index] ?? 0
  if (enemyOutOfRange(state, index, sx, sy, maxR)) {
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
  if (shotBlocked(state, index, target)) return false
  const shot = commandMods(state, index)
  const hitAdd = shot.hit
  const rof = shot.rof
  const overdue = batteryCooldown(state, index, batteryIndex)
  const carry = overdue < -dt - COOLDOWN_SLACK ? 0 : overdue
  setBatteryCooldown(state, index, batteryIndex, volleyGap(state.rng, index, batteryIndex, battery.cooldown) * rof + carry)
  const side = ships.side[index] === 1 ? 1 : 0
  const victim = CLASS_STATS[ships.shipClass[target] ?? 0] ?? state.stats
  const zone = armorZone(ships.heading[target] ?? 0, tx, ty, sx, sy, victim)
  const factor = zone === 'front' ? victim.armorFront : zone === 'rear' ? victim.armorRear : victim.armorSide
  const scale = (state.damage[side] ?? state.stats.damage) / Math.max(0.01, state.stats.damage)
  const dist = Math.hypot(tx - sx, ty - sy)
  const angle = Math.atan2(sy - ty, sx - tx)
  let blow = battery.guns * battery.power * scale * factor
  blow *= crossfireScale(state.scratch.bearing[target] ?? 99, angle)
  blow *= commandMods(state, target).evade
  const opened = state.scratch.opened[target] ?? 0
  const queued = state.scratch.incoming[target] ?? 0
  if ((ships.hp[target] ?? 0) <= 0 || (opened > 0 && queued >= opened)) state.tally.overkill += 1
  state.scratch.incoming[target] = queued + blow * GUNNERY.reserve
  state.tally.shots += 1
  const hit = rand(state) <= Math.min(1, Math.max(0, state.stats.hitChance + hitAdd))
  const spread = hit ? 0.4 : 8
  const ox = (rand(state) - 0.5) * spread
  const oy = (rand(state) - 0.5) * spread
  const mount = batteryMount(hx, hy, battery.id)
  spawnBeam(state, sx + mount.x, sy + mount.y, tx + ox, ty + oy, side, batteryIndex === 0 ? 0 : 1)
  if (!hit) {
    clipShot(state, index, tx, ty, blow * STRAY.power, target)
    return true
  }
  state.scratch.bearing[target] = angle
  state.hits[zone][side] += 1
  const before = ships.hp[target] ?? 0
  state.tally.hits += 1
  const dealt = Math.min(before, blow)
  state.tally.damage += dealt
  state.dealt[side] = (state.dealt[side] ?? 0) + dealt
  const shooterClass = ships.shipClass[index] ?? 0
  if (shooterClass === 2) state.destroyerDealt[side] = (state.destroyerDealt[side] ?? 0) + dealt
  state.classDamage[shooterClass] = (state.classDamage[shooterClass] ?? 0) + dealt
  const victimClass = ships.shipClass[target] ?? 0
  state.classOnClass[shooterClass * 3 + victimClass] = (state.classOnClass[shooterClass * 3 + victimClass] ?? 0) + dealt
  ships.hp[target] = before - blow
  ships.flash[target] = 1
  const excess = blow - before
  if ((ships.hp[target] ?? 0) <= 0) destroy(state, target)
  if (excess > 0) {
    const step = dist || 1
    clipShot(state, index, tx + ((tx - sx) / step) * 24, ty + ((ty - sy) / step) * 24, excess * STRAY.overpen, target)
  }
  return true
}

function batteryMount(hx: number, hy: number, id: string): { x: number; y: number } {
  const lx = -hy
  const ly = hx
  if (id === 'port') return { x: lx * 8, y: ly * 8 }
  if (id === 'starboard') return { x: -lx * 8, y: -ly * 8 }
  return { x: hx * 14, y: hy * 14 }
}

const blastQueue: number[] = []

function destroy(state: SimState, index: number): void {
  const ships = state.ships
  if (ships.alive[index] === 0) return
  noteFlagshipLoss(state, index)
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
  blastQueue.push(index)
}

/** A miss or an overpenetrating shell clips the nearest other hull when the impact is crowded. */
function clipShot(state: SimState, shooter: number, x: number, y: number, blow: number, skip: number): void {
  if (blow <= 0.05) return
  const ships = state.ships
  const splash = state.scratch.splash
  const n = collectInto(state.scratch.hash, x, y, STRAY.radius, ships.x, ships.y, splash)
  let bystanders = 0
  let best = -1
  let bestD = Infinity
  for (let k = 0; k < n; k++) {
    const ship = splash[k] ?? -1
    if (ship < 0 || ship === shooter || ship === skip || ships.alive[ship] === 0) continue
    bystanders += 1
    const dx = (ships.x[ship] ?? 0) - x
    const dy = (ships.y[ship] ?? 0) - y
    const dist = dx * dx + dy * dy
    if (dist < bestD) {
      bestD = dist
      best = ship
    }
  }
  if (best < 0 || rand(state) > strayChance(bystanders)) return
  hurtFromShot(state, shooter, best, blow)
}

function hurtFromShot(state: SimState, shooter: number, target: number, blow: number): void {
  const ships = state.ships
  if (ships.alive[target] === 0) return
  const taken = blow * commandMods(state, target).evade
  const before = ships.hp[target] ?? 0
  if (before <= 0) return
  const dealt = Math.min(before, taken)
  const origin = ships.side[shooter] === 1 ? 1 : 0
  const victimSide = ships.side[target] === 1 ? 1 : 0
  if (origin !== victimSide) {
    const sx = ships.x[shooter] ?? 0
    const sy = ships.y[shooter] ?? 0
    const tx = ships.x[target] ?? 0
    const ty = ships.y[target] ?? 0
    const victim = CLASS_STATS[ships.shipClass[target] ?? 0] ?? state.stats
    const zone = armorZone(ships.heading[target] ?? 0, tx, ty, sx, sy, victim)
    state.hits[zone][origin] += 1
    state.tally.hits += 1
    state.tally.damage += dealt
    state.dealt[origin] = (state.dealt[origin] ?? 0) + dealt
    const shooterClass = ships.shipClass[shooter] ?? 0
    if (shooterClass === 2) state.destroyerDealt[origin] = (state.destroyerDealt[origin] ?? 0) + dealt
    state.classDamage[shooterClass] = (state.classDamage[shooterClass] ?? 0) + dealt
    const victimClass = ships.shipClass[target] ?? 0
    state.classOnClass[shooterClass * 3 + victimClass] = (state.classOnClass[shooterClass * 3 + victimClass] ?? 0) + dealt
  }
  ships.hp[target] = before - taken
  ships.flash[target] = 1
  if ((ships.hp[target] ?? 0) <= 0) destroy(state, target)
}

const blastHold = new Int32Array(48)

function drainBlasts(state: SimState): void {
  while (blastQueue.length > 0 && state.scratch.blasts < BLAST.max) {
    const index = blastQueue.pop()
    if (index === undefined) break
    state.scratch.blasts += 1
    explode(state, index)
  }
  blastQueue.length = 0
}

/** Radius damage around a destroyed hull. A battleship reaches farther than a destroyer. */
export function explode(state: SimState, index: number): void {
  const ships = state.ships
  const radius = hullRadius(ships.shipClass[index] ?? 0)
  const reach = radius * BLAST.reach
  const x = ships.x[index] ?? 0
  const y = ships.y[index] ?? 0
  const splash = state.scratch.splash
  const n = collectInto(state.scratch.hash, x, y, reach, ships.x, ships.y, splash)
  let kept = 0
  for (let k = 0; k < n && kept < blastHold.length; k++) {
    const ship = splash[k] ?? -1
    if (ship < 0 || ship === index || ships.alive[ship] === 0) continue
    blastHold[kept++] = ship
  }
  for (let k = 0; k < kept; k++) {
    const ship = blastHold[k] ?? -1
    if (ship < 0 || ships.alive[ship] === 0) continue
    const dist = Math.hypot((ships.x[ship] ?? 0) - x, (ships.y[ship] ?? 0) - y)
    const blow = blastDamage(radius, dist) * commandMods(state, ship).evade
    if (blow <= 0) continue
    const before = ships.hp[ship] ?? 0
    ships.hp[ship] = before - blow
    ships.flash[ship] = 1
    if ((ships.hp[ship] ?? 0) <= 0) destroy(state, ship)
  }
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
