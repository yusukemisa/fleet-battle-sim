import type { ShipClassId } from '../balance.ts'
import type { Division, FormationId, SideId, SimState, TacticId } from '../types.ts'

export interface DivisionView {
  id: number
  fleet: number
  side: SideId
  slot: number
  classId: ShipClassId
  alive: number
  roster: number
  x: number
  y: number
  fx: number
  fy: number
  vx: number
  vy: number
  tacticId: TacticId
  /** 0 when the division has sea room, 1 when sampled ships are inside a near miss. */
  pack: number
  /** 0 clear of the enemy, 1 when sampled ships are inside ramming distance. */
  press: number
}

export interface FleetView {
  index: number
  side: SideId
  commanderId: string
  formationId: FormationId
  ships: number
  x: number
  y: number
  fx: number
  fy: number
}

/** Compact snapshot a brain can serialize. Positions are in world units. */
export interface Observation {
  time: number
  fleet: number
  own: FleetView
  enemy: FleetView
  divisions: DivisionView[]
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function viewDivision(division: Division, id: number): DivisionView {
  return {
    id,
    fleet: division.fleet,
    side: division.side,
    slot: division.slot,
    classId: division.classId,
    alive: division.alive,
    roster: division.roster,
    x: round(division.ax),
    y: round(division.ay),
    fx: round(division.fx),
    fy: round(division.fy),
    vx: round(division.vx),
    vy: round(division.vy),
    tacticId: division.tacticId,
    pack: round(division.pack),
    press: round(division.press),
  }
}

export function observe(state: SimState, fleetIndex: number): Observation {
  const fleet = state.fleets[fleetIndex] ?? state.fleets[0]
  const enemy = state.fleets[fleet?.enemyFleet ?? 0] ?? state.fleets[fleet?.side === 0 ? 1 : 0]
  if (!fleet || !enemy) {
    throw new Error('observation requires a fleet')
  }
  const divisions: DivisionView[] = []
  for (let id = 0; id < state.divisions.length; id++) {
    const division = state.divisions[id]
    if (!division || division.alive === 0) continue
    if (division.fleet !== fleet.index && division.fleet !== enemy.index) continue
    divisions.push(viewDivision(division, id))
  }
  return {
    time: round(state.time),
    fleet: fleet.index,
    own: {
      index: fleet.index,
      side: fleet.side,
      commanderId: fleet.commanderId,
      formationId: fleet.formationId,
      ships: fleet.ships,
      x: round(fleet.meanX),
      y: round(fleet.meanY),
      fx: round(fleet.facingX),
      fy: round(fleet.facingY),
    },
    enemy: {
      index: enemy.index,
      side: enemy.side,
      commanderId: enemy.commanderId,
      formationId: enemy.formationId,
      ships: enemy.ships,
      x: round(enemy.meanX),
      y: round(enemy.meanY),
      fx: round(enemy.facingX),
      fy: round(enemy.facingY),
    },
    divisions,
  }
}
