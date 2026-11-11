import { TACTIC_IDS, type BrainOrder, type TacticId } from '../types.ts'
import type { Observation } from './observe.ts'

const WORLD = 20000

export interface BrainDecision {
  orders: BrainOrder[]
  note: string
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value))
}

function wrapHeading(value: number): number {
  const turns = Math.atan2(Math.sin(value), Math.cos(value))
  return Math.round(turns * 1000) / 1000
}

function tacticOf(value: unknown): TacticId | null {
  return typeof value === 'string' && (TACTIC_IDS as readonly string[]).includes(value) ? (value as TacticId) : null
}

function readOrder(value: unknown, observation: Observation): BrainOrder | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const division = finite(raw.division)
  if (division === null || !Number.isInteger(division)) return null
  const own = observation.divisions.find((item) => item.id === division && item.fleet === observation.fleet)
  if (!own) return null
  const tacticId = tacticOf(raw.tacticId)
  if (!tacticId) return null
  const order: BrainOrder = { division, tacticId }
  const target = finite(raw.target)
  if (target !== null && Number.isInteger(target)) {
    const enemy = observation.divisions.find((item) => item.id === target && item.fleet === observation.enemy.index)
    if (enemy) order.target = target
  }
  if (raw.move && typeof raw.move === 'object') {
    const move = raw.move as Record<string, unknown>
    const x = finite(move.x)
    const y = finite(move.y)
    const heading = finite(move.heading)
    if (x !== null && y !== null && heading !== null) {
      order.move = { x: clamp(x, WORLD), y: clamp(y, WORLD), heading: wrapHeading(heading) }
    }
  }
  return order
}

/** Pull a JSON object out of a model reply. Markdown fences are ignored. */
export function parseBrainDecision(raw: string, observation: Observation): BrainDecision | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const body = parsed as Record<string, unknown>
  if (!Array.isArray(body.orders)) return null
  const orders: BrainOrder[] = []
  const seen = new Set<number>()
  for (const item of body.orders) {
    const order = readOrder(item, observation)
    if (!order || seen.has(order.division)) continue
    seen.add(order.division)
    orders.push(order)
  }
  if (orders.length === 0) return null
  const note = typeof body.note === 'string' ? body.note.replace(/\s+/g, ' ').trim().slice(0, 240) : ''
  return { orders, note }
}
