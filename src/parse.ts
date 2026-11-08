import {
  COMMANDER_IDS,
  FORMATION_IDS,
  SHIP_COUNTS,
  TACTIC_IDS,
  type CommanderId,
  type FormationId,
  type ShipCount,
  type Speed,
  type TacticId,
} from './types.ts'

export function parseShipCount(value: string): ShipCount | null {
  const n = Number(value)
  for (const count of SHIP_COUNTS) {
    if (count === n) return count
  }
  return null
}

export function parseFormationId(value: string): FormationId | null {
  for (const id of FORMATION_IDS) {
    if (id === value) return id
  }
  return null
}

export function parseCommanderId(value: string): CommanderId | null {
  for (const id of COMMANDER_IDS) {
    if (id === value) return id
  }
  return null
}

export function parseTacticId(value: string): TacticId | null {
  for (const id of TACTIC_IDS) {
    if (id === value) return id
  }
  return null
}

export function parseSpeed(value: string): Speed | null {
  if (value === '1') return 1
  if (value === '2') return 2
  if (value === '4') return 4
  return null
}
