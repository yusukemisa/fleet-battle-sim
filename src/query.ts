import { defaultBrain } from './brain/policy.ts'
import { COMMANDERS } from './commanders.ts'
import { FORMATIONS } from './formations.ts'
import { DEFAULT_VARIANT, parseTacticVariant, type TacticVariant } from './operation.ts'
import { parseShipCount, parseSpeed } from './parse.ts'
import {
  COMMANDER_IDS,
  FORMATION_IDS,
  type BrainMode,
  type CommanderId,
  type FormationId,
  type ShipCount,
  type Speed,
} from './types.ts'

export interface BattleQuery {
  blue: TacticVariant | null
  red: TacticVariant | null
  cmdBlue: CommanderId | null
  cmdRed: CommanderId | null
  ships: ShipCount | null
  seed: number | null
  formBlue: FormationId | null
  formRed: FormationId | null
  speed: Speed | null
  brainBlue: BrainMode | null
  brainRed: BrainMode | null
}

export function parseBattleQuery(params: URLSearchParams): BattleQuery {
  const sharedForm = parseNamedFormation(params.get('form'))
  const sharedBrain = parseBrain(params.get('brain'))
  return {
    blue: parseOptionalVariant(params.get('blue')),
    red: parseOptionalVariant(params.get('red')),
    cmdBlue: parseNamedCommander(params.get('cmdBlue')),
    cmdRed: parseNamedCommander(params.get('cmdRed')),
    ships: parseShipCount(params.get('ships') ?? ''),
    seed: parseSeed(params.get('seed')),
    formBlue: parseNamedFormation(params.get('formBlue')) ?? sharedForm,
    formRed: parseNamedFormation(params.get('formRed')) ?? sharedForm,
    speed: parseSpeed(params.get('speed') ?? ''),
    brainBlue: parseBrain(params.get('brainBlue')) ?? sharedBrain,
    brainRed: parseBrain(params.get('brainRed')) ?? sharedBrain,
  }
}

export function battleSearch(input: {
  blue: TacticVariant
  red: TacticVariant
  cmdBlue: CommanderId
  cmdRed: CommanderId
  ships: number
  seed: number | null
  formBlue: FormationId
  formRed: FormationId
  speed: Speed
  brainBlue: BrainMode
  brainRed: BrainMode
}): string {
  const params = new URLSearchParams()
  if (input.blue !== DEFAULT_VARIANT) params.set('blue', input.blue)
  if (input.red !== DEFAULT_VARIANT) params.set('red', input.red)
  if (input.cmdBlue !== 'balanced') params.set('cmdBlue', COMMANDERS[input.cmdBlue].name)
  if (input.cmdRed !== 'balanced') params.set('cmdRed', COMMANDERS[input.cmdRed].name)
  if (input.ships !== 1000) {
    const preset = parseShipCount(String(input.ships))
    if (preset !== null) params.set('ships', String(preset))
  }
  if (input.seed !== null) params.set('seed', String(input.seed))
  if (input.formBlue !== 'oujin') params.set('formBlue', input.formBlue)
  if (input.formRed !== 'oujin') params.set('formRed', input.formRed)
  if (input.speed !== 1) params.set('speed', String(input.speed))
  const keepsBlue = input.blue === 'main' || input.blue === DEFAULT_VARIANT
  const keepsRed = input.red === 'main' || input.red === DEFAULT_VARIANT
  if (keepsBlue && input.brainBlue !== defaultBrain(input.cmdBlue)) params.set('brainBlue', input.brainBlue)
  if (keepsRed && input.brainRed !== defaultBrain(input.cmdRed)) params.set('brainRed', input.brainRed)
  const text = params.toString()
  return text ? `?${text}` : ''
}

function parseBrain(value: string | null): BrainMode | null {
  if (value === null) return null
  const text = value.trim().toLowerCase()
  if (text === 'rule' || text === 'ルール') return 'rule'
  if (text === 'ai') return 'ai'
  if (text === 'dt') return 'dt'
  return null
}

function parseOptionalVariant(value: string | null): TacticVariant | null {
  if (value === null || value.trim() === '') return null
  return parseTacticVariant(value)
}

function parseNamedCommander(value: string | null): CommanderId | null {
  if (value === null) return null
  const text = value.trim()
  for (const id of COMMANDER_IDS) {
    if (text === id || text === COMMANDERS[id].name) return id
  }
  return null
}

function parseNamedFormation(value: string | null): FormationId | null {
  if (value === null) return null
  const text = value.trim()
  for (const id of FORMATION_IDS) {
    if (text === id || text === FORMATIONS[id].name) return id
  }
  return null
}

function parseSeed(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0x7fffffff) return null
  return parsed
}
