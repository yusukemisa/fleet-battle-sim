import type { Division, Fleet, SimState } from './types.ts'

/**
 * A fleet flagship is one battleship. Each division also has its own flagship.
 * Ships inside a radius gain a modest bonus. The two radii do not add in full.
 * Destroying a flagship drops the bonus and slows maneuver until a successor
 * is appointed. There was no flagship before this: `ships.command` only marked
 * the hull nearest the center division and nothing read it.
 */
export const FLAGSHIP = {
  fleetRadius: 640,
  divisionRadius: 300,
  divisionDelay: 8,
  fleetDelay: 12,
  hitFleet: 0.012,
  hitDivision: 0.006,
  hitStack: 0.016,
  rofFleet: 0.975,
  rofDivision: 0.988,
  rofStack: 0.968,
  evadeFleet: 0.984,
  evadeDivision: 0.992,
  evadeStack: 0.98,
  turnFleet: 1.024,
  turnDivision: 1.016,
  turnStack: 1.032,
  disruptTurn: 0.92,
  disruptResponse: 0.88,
  disruptHit: -0.02,
} as const

export interface CommandMods {
  /** Added to hit chance. */
  hit: number
  /** Multiplies the volley gap. Below 1 fires faster. */
  rof: number
  /** Multiplies damage taken. Below 1 is evasion. */
  evade: number
  /** Multiplies turn rate. */
  turn: number
  /** Multiplies acceleration. */
  response: number
}

const mods: CommandMods = { hit: 0, rof: 1, evade: 1, turn: 1, response: 1 }
let bound: SimState | null = null
let hitBuf = new Float32Array(0)
let rofBuf = new Float32Array(0)
let evadeBuf = new Float32Array(0)
let turnBuf = new Float32Array(0)
let responseBuf = new Float32Array(0)

function near(state: SimState, flagship: number, x: number, y: number, radius: number): boolean {
  if (flagship < 0) return false
  const ships = state.ships
  if (ships.alive[flagship] !== 1) return false
  const dx = (ships.x[flagship] ?? 0) - x
  const dy = (ships.y[flagship] ?? 0) - y
  return dx * dx + dy * dy <= radius * radius
}

let divX = new Float32Array(0)
let divY = new Float32Array(0)
let divOn = new Uint8Array(0)
let divDown = new Uint8Array(0)
let divFleet = new Uint8Array(0)
let fleetX = new Float32Array(0)
let fleetY = new Float32Array(0)
let fleetOn = new Uint8Array(0)
let fleetDown = new Uint8Array(0)

/** One pass per step. Later lookups are array reads, so the shot loop stays cheap. */
export function refreshCommand(state: SimState): void {
  const ships = state.ships
  const n = ships.count
  const divisions = state.divisions.length
  const fleets = state.fleets.length
  if (hitBuf.length < n) {
    hitBuf = new Float32Array(n)
    rofBuf = new Float32Array(n)
    evadeBuf = new Float32Array(n)
    turnBuf = new Float32Array(n)
    responseBuf = new Float32Array(n)
  }
  if (divOn.length < divisions) {
    divX = new Float32Array(divisions)
    divY = new Float32Array(divisions)
    divOn = new Uint8Array(divisions)
    divDown = new Uint8Array(divisions)
    divFleet = new Uint8Array(divisions)
  } else {
    divOn.fill(0)
    divDown.fill(0)
  }
  if (fleetOn.length < fleets) {
    fleetX = new Float32Array(fleets)
    fleetY = new Float32Array(fleets)
    fleetOn = new Uint8Array(fleets)
    fleetDown = new Uint8Array(fleets)
  } else {
    fleetOn.fill(0)
    fleetDown.fill(0)
  }
  const time = state.time
  for (let index = 0; index < divisions; index++) {
    const division = state.divisions[index]
    if (!division) continue
    divFleet[index] = division.fleet
    const at = division.flagship
    if (at >= 0 && ships.alive[at] === 1) {
      divOn[index] = 1
      divX[index] = ships.x[at] ?? 0
      divY[index] = ships.y[at] ?? 0
    } else if (division.flagAt > 0 && time < division.flagAt) divDown[index] = 1
  }
  for (let index = 0; index < fleets; index++) {
    const fleet = state.fleets[index]
    if (!fleet) continue
    const at = fleet.flagship
    if (at >= 0 && ships.alive[at] === 1) {
      fleetOn[index] = 1
      fleetX[index] = ships.x[at] ?? 0
      fleetY[index] = ships.y[at] ?? 0
    } else if (fleet.flagAt > 0 && time < fleet.flagAt) fleetDown[index] = 1
  }
  const divR = FLAGSHIP.divisionRadius * FLAGSHIP.divisionRadius
  const fleetR = FLAGSHIP.fleetRadius * FLAGSHIP.fleetRadius
  const sx = ships.x
  const sy = ships.y
  const alive = ships.alive
  const divisionOf = ships.division
  for (let index = 0; index < n; index++) {
    if (alive[index] !== 1) {
      hitBuf[index] = 0
      rofBuf[index] = 1
      evadeBuf[index] = 1
      turnBuf[index] = 1
      responseBuf[index] = 1
      continue
    }
    const division = divisionOf[index] ?? 0
    const fleet = divFleet[division] ?? 0
    const x = sx[index] ?? 0
    const y = sy[index] ?? 0
    let divUp = false
    if (divOn[division] === 1) {
      const dx = (divX[division] ?? 0) - x
      const dy = (divY[division] ?? 0) - y
      divUp = dx * dx + dy * dy <= divR
    }
    let fleetUp = false
    if (fleetOn[fleet] === 1) {
      const dx = (fleetX[fleet] ?? 0) - x
      const dy = (fleetY[fleet] ?? 0) - y
      fleetUp = dx * dx + dy * dy <= fleetR
    }
    const disrupted = divDown[division] === 1 || fleetDown[fleet] === 1
    let hit = 0
    let rof = 1
    let evade = 1
    let turn = 1
    if (fleetUp && divUp) {
      hit = FLAGSHIP.hitStack
      rof = FLAGSHIP.rofStack
      evade = FLAGSHIP.evadeStack
      turn = FLAGSHIP.turnStack
    } else if (fleetUp) {
      hit = FLAGSHIP.hitFleet
      rof = FLAGSHIP.rofFleet
      evade = FLAGSHIP.evadeFleet
      turn = FLAGSHIP.turnFleet
    } else if (divUp) {
      hit = FLAGSHIP.hitDivision
      rof = FLAGSHIP.rofDivision
      evade = FLAGSHIP.evadeDivision
      turn = FLAGSHIP.turnDivision
    }
    let response = 1
    if (disrupted) {
      hit += FLAGSHIP.disruptHit
      turn *= FLAGSHIP.disruptTurn
      response = FLAGSHIP.disruptResponse
    }
    hitBuf[index] = hit
    rofBuf[index] = rof
    evadeBuf[index] = evade
    turnBuf[index] = turn
    responseBuf[index] = response
  }
  bound = state
}

/** Bonuses for one hull. The returned object is reused, so copy the numbers. */
export function commandMods(state: SimState, index: number): CommandMods {
  if (bound === state) {
    mods.hit = hitBuf[index] ?? 0
    mods.rof = rofBuf[index] ?? 1
    mods.evade = evadeBuf[index] ?? 1
    mods.turn = turnBuf[index] ?? 1
    mods.response = responseBuf[index] ?? 1
    return mods
  }
  writeMods(state, index)
  return mods
}

function writeMods(state: SimState, index: number): void {
  const ships = state.ships
  const division = state.divisions[ships.division[index] ?? 0]
  const fleet = division ? state.fleets[division.fleet] : undefined
  const x = ships.x[index] ?? 0
  const y = ships.y[index] ?? 0
  const divUp = division ? near(state, division.flagship, x, y, FLAGSHIP.divisionRadius) : false
  const fleetUp = fleet ? near(state, fleet.flagship, x, y, FLAGSHIP.fleetRadius) : false
  const disrupted =
    (division != null && division.flagship < 0 && division.flagAt > 0 && state.time < division.flagAt) ||
    (fleet != null && fleet.flagship < 0 && fleet.flagAt > 0 && state.time < fleet.flagAt)
  if (fleetUp && divUp) {
    mods.hit = FLAGSHIP.hitStack
    mods.rof = FLAGSHIP.rofStack
    mods.evade = FLAGSHIP.evadeStack
    mods.turn = FLAGSHIP.turnStack
  } else if (fleetUp) {
    mods.hit = FLAGSHIP.hitFleet
    mods.rof = FLAGSHIP.rofFleet
    mods.evade = FLAGSHIP.evadeFleet
    mods.turn = FLAGSHIP.turnFleet
  } else if (divUp) {
    mods.hit = FLAGSHIP.hitDivision
    mods.rof = FLAGSHIP.rofDivision
    mods.evade = FLAGSHIP.evadeDivision
    mods.turn = FLAGSHIP.turnDivision
  } else {
    mods.hit = 0
    mods.rof = 1
    mods.evade = 1
    mods.turn = 1
  }
  mods.response = 1
  if (disrupted) {
    mods.hit += FLAGSHIP.disruptHit
    mods.turn *= FLAGSHIP.disruptTurn
    mods.response = FLAGSHIP.disruptResponse
  }
}

/** The enemy fleet flagship is worth hunting when its division is on a wing or already thin. */
export function exposedFlagship(state: SimState, ship: number): boolean {
  const ships = state.ships
  if (ships.command[ship] !== 2 || ships.alive[ship] !== 1) return false
  const division = state.divisions[ships.division[ship] ?? 0]
  if (!division || division.roster <= 0) return false
  return division.slot === 0 || division.slot === 4 || division.alive <= division.roster * 0.7
}

/** Extra prey score for the division that holds an exposed enemy fleet flagship. */
export function flagshipPreyBonus(state: SimState, division: Division): number {
  const fleet = state.fleets[division.fleet]
  if (!fleet || fleet.flagship < 0) return 0
  const at = fleet.flagship
  const ships = state.ships
  if (ships.alive[at] !== 1) return 0
  if (state.divisions[ships.division[at] ?? 0] !== division) return 0
  return exposedFlagship(state, at) ? 4.5 : 0
}

/** Point the fleet at an exposed enemy flagship division. */
export function huntExposedFlagship(state: SimState, fleet: Fleet): void {
  if (fleet.commanderId === 'balanced') return
  if (fleet.maneuver === 'breakout' || fleet.maneuver === 'reform') return
  let best = -1
  let bestBonus = 0
  for (let index = 0; index < state.divisions.length; index++) {
    const division = state.divisions[index]
    if (!division || division.side === fleet.side || division.alive === 0) continue
    if (state.fleets.length > 2 && division.fleet !== fleet.enemyFleet) continue
    const bonus = flagshipPreyBonus(state, division)
    if (bonus > bestBonus) {
      bestBonus = bonus
      best = index
    }
  }
  if (best < 0) return
  fleet.prey = best
  for (const division of state.divisions) {
    if (division.fleet !== fleet.index) continue
    division.hunt = best
  }
}

/** The battleship division that carries the fleet flagship holds the line. */
export function guardOwnFlagship(state: SimState, fleet: Fleet): void {
  if (fleet.flagship < 0 || fleet.formationId === 'houen') return
  const division = state.divisions[state.ships.division[fleet.flagship] ?? 0]
  if (!division || division.fleet !== fleet.index || division.classId !== 'battleship') return
  if (fleet.maneuver === 'breakout' || fleet.maneuver === 'reform') {
    division.standoff = false
    return
  }
  division.standoff = true
  if (division.tacticId === 'charge') {
    division.tacticId = 'focus'
    division.focus = true
  }
}

function pickDivisionFlag(state: SimState, divisionIndex: number): number {
  const ships = state.ships
  const division = state.divisions[divisionIndex]
  if (!division) return -1
  let bestBb = -1
  let bestBbD = Infinity
  let bestCl = -1
  let bestClD = Infinity
  let bestAny = -1
  let bestAnyD = Infinity
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] !== 1 || ships.division[i] !== divisionIndex) continue
    const dx = (ships.x[i] ?? 0) - division.ax
    const dy = (ships.y[i] ?? 0) - division.ay
    const dist = dx * dx + dy * dy
    const cls = ships.shipClass[i] ?? 0
    if (cls === 0 && dist < bestBbD) {
      bestBb = i
      bestBbD = dist
    } else if (cls === 1 && dist < bestClD) {
      bestCl = i
      bestClD = dist
    }
    if (dist < bestAnyD) {
      bestAny = i
      bestAnyD = dist
    }
  }
  if (bestBb >= 0) return bestBb
  if (bestCl >= 0) return bestCl
  return bestAny
}

function pickFleetFlag(state: SimState, fleet: Fleet): number {
  const ships = state.ships
  let best = -1
  let bestScore = -Infinity
  for (let index = 0; index < state.divisions.length; index++) {
    const division = state.divisions[index]
    if (!division || division.fleet !== fleet.index) continue
    const at = division.flagship
    if (at < 0 || ships.alive[at] !== 1) continue
    const cls = ships.shipClass[at] ?? 0
    const score = (cls === 0 ? 10 : cls === 1 ? 4 : 1) + (2 - Math.abs(division.slot - 2))
    if (score > bestScore) {
      bestScore = score
      best = at
    }
  }
  return best
}

function mark(state: SimState, index: number, kind: 1 | 2): void {
  state.ships.command[index] = kind
}

/** Appoint missing flagships once their succession delay has elapsed. A negative `flagAt` suspends command. */
export function appointFlagships(state: SimState): void {
  const ships = state.ships
  for (let index = 0; index < state.divisions.length; index++) {
    const division = state.divisions[index]
    if (!division) continue
    const at = division.flagship
    const live = at >= 0 && ships.alive[at] === 1 && ships.division[at] === index
    if (live || division.flagAt < 0) continue
    if (division.alive === 0) {
      division.flagship = -1
      continue
    }
    if (division.flagAt > 0 && state.time < division.flagAt) continue
    const next = pickDivisionFlag(state, index)
    division.flagship = next
    if (next >= 0) {
      const fleet = state.fleets[division.fleet]
      mark(state, next, fleet && fleet.flagship === next ? 2 : 1)
    }
  }
  for (const fleet of state.fleets) {
    if (!fleet || fleet.ships <= 0) continue
    const at = fleet.flagship
    const live = at >= 0 && ships.alive[at] === 1
    if (live) {
      ships.command[at] = 2
      continue
    }
    if (fleet.flagAt < 0) continue
    if (fleet.flagAt > 0 && state.time < fleet.flagAt) {
      fleet.flagship = -1
      continue
    }
    const next = pickFleetFlag(state, fleet)
    fleet.flagship = next
    if (next >= 0) mark(state, next, 2)
  }
}

/** A destroyed flagship opens a gap before the next hull takes the mark. */
export function noteFlagshipLoss(state: SimState, index: number): void {
  const ships = state.ships
  const division = state.divisions[ships.division[index] ?? 0]
  if (!division) return
  if (division.flagship === index) {
    division.flagship = -1
    division.flagAt = state.time + FLAGSHIP.divisionDelay
  }
  const fleet = state.fleets[division.fleet]
  if (fleet && fleet.flagship === index) {
    fleet.flagship = -1
    fleet.flagAt = state.time + FLAGSHIP.fleetDelay
  }
  ships.command[index] = 0
}
