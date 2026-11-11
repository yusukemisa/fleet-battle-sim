import { COMMANDERS, chooseTactic, employClass, lightDuty } from '../commanders.ts'
import type { BattleFacts, DivisionFact } from '../commanders.ts'
import type { DivisionSlot, TacticId } from '../types.ts'
import type { DivisionView, Observation } from './observe.ts'
import type { BrainDecision } from './orders.ts'

function bearing(dx: number, dy: number, fx: number, fy: number): 'front' | 'side' | 'rear' {
  const len = Math.hypot(dx, dy) || 1
  const dot = (dx / len) * fx + (dy / len) * fy
  if (dot <= -0.3) return 'rear'
  if (dot < 0.45) return 'side'
  return 'front'
}

function enemyFacts(observation: Observation): DivisionFact[] {
  return observation.divisions
    .filter((division) => division.fleet === observation.enemy.index)
    .map((division) => ({
      alive: division.alive,
      tacticId: division.tacticId,
      phase: 0,
      ax: division.x,
      ay: division.y,
      fx: division.fx,
      fy: division.fy,
    }))
}

function factsFor(observation: Observation, division: DivisionView): BattleFacts {
  const enemies = observation.divisions.filter((item) => item.fleet === observation.enemy.index && item.alive > 0)
  let nearest = enemies[0]
  let nearestRange = Infinity
  for (const enemy of enemies) {
    const range = Math.hypot(enemy.x - division.x, enemy.y - division.y)
    if (range < nearestRange) {
      nearestRange = range
      nearest = enemy
    }
  }
  const relX = division.x - (nearest?.x ?? observation.enemy.x)
  const relY = division.y - (nearest?.y ?? observation.enemy.y)
  const ownAlive = observation.divisions.filter((item) => item.fleet === observation.fleet).reduce((sum, item) => sum + item.alive, 0)
  const enemyAlive = enemies.reduce((sum, item) => sum + item.alive, 0)
  return {
    ownAlive,
    enemyAlive,
    ownLost: Math.max(0, observation.own.ships - ownAlive),
    enemyLost: Math.max(0, observation.enemy.ships - enemyAlive),
    enemyFormation: observation.enemy.formationId,
    ownX: observation.own.x,
    ownY: observation.own.y,
    ax: division.x,
    ay: division.y,
    fx: division.fx,
    fy: division.fy,
    slot: division.slot as DivisionSlot,
    enemy: enemyFacts(observation),
    enemyOnUs: nearest ? bearing(nearest.x - division.x, nearest.y - division.y, division.fx, division.fy) : 'front',
    usOnEnemy: nearest ? bearing(relX, relY, nearest.fx, nearest.fy) : 'front',
    enemyCommander: observation.enemy.commanderId as BattleFacts['enemyCommander'],
  }
}

function incoming(observation: Observation): number {
  const battleship = observation.divisions.find((division) => division.fleet === observation.fleet && division.classId === 'battleship')
  if (!battleship) return 0
  return observation.divisions.filter((division) => {
    if (division.fleet !== observation.enemy.index || division.classId !== 'destroyer') return false
    return Math.hypot(division.x - battleship.x, division.y - battleship.y) < 820
  }).length
}

function enemyScreenHome(observation: Observation): boolean {
  const battleships = observation.divisions.filter((division) => division.fleet === observation.enemy.index && division.classId === 'battleship')
  return observation.divisions.some((division) => {
    if (division.fleet !== observation.enemy.index || division.classId !== 'destroyer') return false
    return battleships.some((battleship) => Math.hypot(division.x - battleship.x, division.y - battleship.y) < 380)
  })
}

function nearestEnemy(observation: Observation, division: DivisionView): number | undefined {
  let best: DivisionView | null = null
  let bestRange = Infinity
  for (const enemy of observation.divisions) {
    if (enemy.fleet !== observation.enemy.index || enemy.alive === 0) continue
    const range = Math.hypot(enemy.x - division.x, enemy.y - division.y)
    if (range < bestRange) {
      bestRange = range
      best = enemy
    }
  }
  return best?.id
}

/** The code commanders, as one decision over the shared order vocabulary. */
export function ruleDecide(observation: Observation): BrainDecision {
  const commander = COMMANDERS[observation.own.commanderId as keyof typeof COMMANDERS] ?? COMMANDERS.balanced
  const near = incoming(observation)
  const screenHome = enemyScreenHome(observation)
  const orders = []
  for (const division of observation.divisions) {
    if (division.fleet !== observation.fleet || division.alive === 0) continue
    const facts = factsFor(observation, division)
    const chosen = chooseTactic(commander, facts) ?? commander.prefer[0] ?? 'charge'
    let tacticId: TacticId = employClass(commander, division.classId, chosen, facts)
    const duty = lightDuty(commander.id, division.classId, near, screenHome, division.slot as DivisionSlot)
    if (division.classId === 'destroyer' && duty === 'under') tacticId = 'rear'
    if (duty === 'screen') tacticId = 'flank'
    const target = nearestEnemy(observation, division)
    orders.push(target === undefined ? { division: division.id, tacticId } : { division: division.id, tacticId, target })
  }
  return { note: '', orders }
}
