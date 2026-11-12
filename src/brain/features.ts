import { FORMATION_IDS } from '../types.ts'
import type { DivisionView, Observation } from './observe.ts'

const SLOT = 9
const COMMANDERS = ['fierce', 'cunning', 'guard', 'balanced'] as const

/** Own 5 divisions, enemy 5 divisions, both formations, own commander, range, closing, strength. */
export const INPUT_SIZE = 5 * SLOT * 2 + FORMATION_IDS.length * 2 + COMMANDERS.length + 3

function writeSlot(out: Float64Array, at: number, division: DivisionView | undefined, originX: number, originY: number): void {
  if (!division || division.roster <= 0) return
  out[at] = division.alive / division.roster
  out[at + 1] = division.classId === 'battleship' ? 1 : division.classId === 'cruiser' ? 0 : -1
  out[at + 2] = (division.x - originX) / 1500
  out[at + 3] = (division.y - originY) / 1500
  out[at + 4] = division.fx
  out[at + 5] = division.fy
  out[at + 6] = division.vx / 80
  out[at + 7] = division.vy / 80
  out[at + 8] = division.pack
}

/** Fixed-length features. Missing divisions stay zero. */
export function featurize(observation: Observation): Float64Array {
  const out = new Float64Array(INPUT_SIZE)
  const originX = observation.own.x
  const originY = observation.own.y
  for (let slot = 0; slot < 5; slot++) {
    writeSlot(
      out,
      slot * SLOT,
      observation.divisions.find((division) => division.fleet === observation.fleet && division.slot === slot),
      originX,
      originY,
    )
    writeSlot(
      out,
      5 * SLOT + slot * SLOT,
      observation.divisions.find((division) => division.fleet === observation.enemy.index && division.slot === slot),
      originX,
      originY,
    )
  }
  let cursor = 5 * SLOT * 2
  const ownForm = FORMATION_IDS.indexOf(observation.own.formationId)
  const enemyForm = FORMATION_IDS.indexOf(observation.enemy.formationId)
  if (ownForm >= 0) out[cursor + ownForm] = 1
  cursor += FORMATION_IDS.length
  if (enemyForm >= 0) out[cursor + enemyForm] = 1
  cursor += FORMATION_IDS.length
  for (let i = 0; i < COMMANDERS.length; i++) {
    if (COMMANDERS[i] === observation.own.commanderId) out[cursor + i] = 1
  }
  cursor += COMMANDERS.length
  const dx = observation.enemy.x - originX
  const dy = observation.enemy.y - originY
  const range = Math.hypot(dx, dy) || 1
  out[cursor] = range / 2000
  let vx = 0
  let vy = 0
  let seen = 0
  let ownAlive = 0
  let enemyAlive = 0
  for (const division of observation.divisions) {
    if (division.fleet === observation.fleet) ownAlive += division.alive
    else {
      enemyAlive += division.alive
      vx += division.vx
      vy += division.vy
      seen += 1
    }
  }
  if (seen > 0) {
    vx /= seen
    vy /= seen
  }
  out[cursor + 1] = ((-dx) * vx + (-dy) * vy) / range / 80
  out[cursor + 2] = ownAlive / Math.max(1, ownAlive + enemyAlive)
  return out
}
