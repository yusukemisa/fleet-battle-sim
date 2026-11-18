import { CLASS_MODS, CLASS_STATS, classIndex, hullRadius, SHIP_STATS } from './balance.ts'
import type { CommanderId, Division, SideId, SimState } from './types.ts'

/**
 * Anvil-and-hammer overlay. The opening behaviour keeps hammer wings on the
 * anvil's depth. `main` is the older movement, kept for comparison.
 * One fleet against one fleet, and only a side with at least 400 ships.
 */
export const TACTIC_VARIANTS = ['main', 'table', 'r7a', 'r7b', 'r7c'] as const
export type TacticVariant = (typeof TACTIC_VARIANTS)[number]

/** What a fresh battle does before anyone picks a variant. */
export const DEFAULT_VARIANT: TacticVariant = 'r7b'

export const VARIANT_CHOICES: readonly { id: TacticVariant; label: string; title: string }[] = [
  {
    id: 'r7b',
    label: '槌は列に残す',
    title: '開いたときの動きです。翼は金床と同じ深さから前へ出ません。',
  },
  { id: 'main', label: '以前の動き', title: '上書きする前の艦隊です。比べるときに使います。' },
  {
    id: 'table',
    label: '第5回の表',
    title: '猛将は1200で60度の両翼。智将は薄い側の一翼70度。守将は700まで待って25度。常勝は900で35度。',
  },
  {
    id: 'r7a',
    label: '猛将は戻らない',
    title: '第5回の表のまま。猛将だけ、一度離した隊には戻りません。',
  },
  {
    id: 'r7c',
    label: '守将は900で出す',
    title: '第5回の表のまま。守将だけ、700ではなく900で25度を出します。',
  },
]

interface Persona {
  range: number
  angle: number
  wings: 'both' | 'one'
  retarget: number
  oneWay: boolean
  abort: boolean
  rollOnlyIfAhead: boolean
}

const PERSONA: Record<string, Persona> = {
  fierce: { range: 1200, angle: 60, wings: 'both', retarget: 0.45, oneWay: false, abort: false, rollOnlyIfAhead: false },
  cunning: { range: 900, angle: 70, wings: 'one', retarget: 0.3, oneWay: true, abort: true, rollOnlyIfAhead: false },
  guard: { range: 700, angle: 25, wings: 'both', retarget: 0.3, oneWay: true, abort: true, rollOnlyIfAhead: true },
  balanced: { range: 900, angle: 35, wings: 'both', retarget: 0.3, oneWay: true, abort: true, rollOnlyIfAhead: false },
}

const ALIAS: Record<string, TacticVariant> = {
  main: 'main',
  off: 'main',
  table: 'table',
  r5: 'table',
  fixed: 'table',
  r7a: 'r7a',
  steady: 'r7a',
  r7b: 'r7b',
  rank: 'r7b',
  r7c: 'r7c',
  soon: 'r7c',
}

let variants: [TacticVariant, TacticVariant] = [DEFAULT_VARIANT, DEFAULT_VARIANT]

export function tacticVariants(): readonly [TacticVariant, TacticVariant] {
  return variants
}

export function setTacticVariant(side: SideId, variant: TacticVariant): void {
  variants = side === 0 ? [variant, variants[1]] : [variants[0], variant]
}

export function resetTacticVariants(): void {
  variants = [DEFAULT_VARIANT, DEFAULT_VARIANT]
}

/** Older movement and the opening hammer keep the commander's own brain. */
export function variantKeepsBrain(variant: TacticVariant): boolean {
  return variant === 'main' || variant === DEFAULT_VARIANT
}

export function parseTacticVariant(value: string): TacticVariant | null {
  return ALIAS[value.trim().toLowerCase()] ?? null
}

interface Book {
  pin: [number, number]
  cue: [number, number]
  seen: [number[], number[]]
}

const books = new WeakMap<SimState, Book>()

function bookOf(state: SimState): Book {
  let book = books.get(state)
  if (!book) {
    book = { pin: [-1, -1], cue: [-1, -1], seen: [[], []] }
    books.set(state, book)
  }
  return book
}

function hypot(x: number, y: number): number {
  return Math.hypot(x, y)
}

function enemyInRange(state: SimState, division: Division): boolean {
  const bow = 900
  const reach = bow * bow
  for (const other of state.divisions) {
    if (other.side === division.side || other.alive <= 0) continue
    const dx = other.ax - division.ax
    const dy = other.ay - division.ay
    if (dx * dx + dy * dy <= reach) return true
  }
  return false
}

function steer(div: Division, gx: number, gy: number, faceX: number, faceY: number, speed: number, dt: number, gentle = false): void {
  const dx = gx - div.ax
  const dy = gy - div.ay
  const len = hypot(dx, dy) || 1
  const paced = Math.min(22, speed * (CLASS_MODS[div.classId].speed || 1))
  const step = len > 20 ? Math.min(paced, len) : 0
  const a = 1 - Math.exp(-1.5 * dt)
  div.vx += ((dx / len) * step - div.vx) * a
  div.vy += ((dy / len) * step - div.vy) * a
  div.ax += div.vx * dt
  div.ay += div.vy * dt
  div.shaped = true
  let fx = faceX - div.ax
  let fy = faceY - div.ay
  const fl = hypot(fx, fy)
  if (fl < 1e-4) return
  fx /= fl
  fy /= fl
  const turn = 1 - Math.exp((gentle ? -0.35 : -2) * dt)
  div.fx += (fx - div.fx) * turn
  div.fy += (fy - div.fy) * turn
  const norm = hypot(div.fx, div.fy) || 1
  div.fx /= norm
  div.fy /= norm
  div.rx = div.fy
  div.ry = -div.fx
}

function personaOf(id: CommanderId | string, variant: TacticVariant): Persona {
  const base = PERSONA[id] ?? PERSONA.balanced
  if (!base) return PERSONA.balanced as Persona
  if (variant === 'r7a') return { ...base, oneWay: true }
  if (variant === 'r7c' && id === 'guard') return { ...base, range: 900 }
  return base
}

function anvilOf(state: SimState, side: SideId): Division | undefined {
  return state.divisions.find((division) => division.side === side && division.slot === 2 && division.alive > 0)
}

function pickTarget(state: SimState, anvil: Division, persona: Persona, seen: number[]): Division | undefined {
  const current = state.divisions[seen[seen.length - 1] ?? -1]
  const ownLost = state.lost[anvil.side] ?? 0
  const enemyLost = state.lost[anvil.side === 0 ? 1 : 0] ?? 0
  if (persona.rollOnlyIfAhead && ownLost >= enemyLost && current && current.alive > 0) return current
  const closed = new Set(persona.oneWay ? seen.slice(0, -1) : [])
  let best: Division | undefined
  let bestDist = Infinity
  for (const division of state.divisions) {
    if (division.side === anvil.side || division.alive <= 0) continue
    if (closed.has(state.divisions.indexOf(division))) continue
    if (division.roster > 0 && division.alive < division.roster * persona.retarget && division !== current) continue
    if (current && division === current && division.roster > 0 && division.alive < division.roster * persona.retarget) continue
    const dist = hypot(division.ax - anvil.ax, division.ay - anvil.ay)
    if (dist < bestDist) {
      bestDist = dist
      best = division
    }
  }
  if (best) return best
  if (current && current.alive > 0) return current
  bestDist = Infinity
  for (const division of state.divisions) {
    if (division.side === anvil.side || division.alive <= 0) continue
    const dist = hypot(division.ax - anvil.ax, division.ay - anvil.ay)
    if (dist < bestDist) {
      bestDist = dist
      best = division
    }
  }
  return best
}

function frameOf(anvil: Division, target: Division, wing: Division | undefined): { fx: number; fy: number; lx: number; ly: number } {
  let fx = target.ax - anvil.ax
  let fy = target.ay - anvil.ay
  const len = hypot(fx, fy) || 1
  fx /= len
  fy /= len
  let lx = -fy
  let ly = fx
  const across = wing ? (wing.ax - target.ax) * lx + (wing.ay - target.ay) * ly : 1
  if (across < 0) {
    lx = -lx
    ly = -ly
  }
  return { fx, fy, lx, ly }
}

function place(target: Division, axis: { fx: number; fy: number; lx: number; ly: number }, depth: number, lateral: number): { x: number; y: number } {
  return {
    x: target.ax - axis.fx * depth + axis.lx * lateral,
    y: target.ay - axis.fy * depth + axis.ly * lateral,
  }
}

function outflanked(state: SimState, side: SideId, hammer: Division, axis: { lx: number; ly: number }, target: Division): boolean {
  const hammerAcross = (hammer.ax - target.ax) * axis.lx + (hammer.ay - target.ay) * axis.ly
  for (const division of state.divisions) {
    if (division.side === side || division.alive <= 0) continue
    const across = (division.ax - target.ax) * axis.lx + (division.ay - target.ay) * axis.ly
    if (Math.sign(across) !== Math.sign(hammerAcross) || Math.abs(hammerAcross) < 80) continue
    if (Math.abs(across) > Math.abs(hammerAcross) + 40 && hypot(division.ax - hammer.ax, division.ay - hammer.ay) < 700) return true
  }
  return false
}

export function applyOperation(state: SimState, dt: number): void {
  if (variants[0] === 'main' && variants[1] === 'main') return
  if (state.maneuver !== 'shaped' || state.fleets.length > 2) return
  const book = bookOf(state)
  for (const side of [0, 1] as const) {
    const variant = variants[side]
    if (variant === 'main') continue
    const fleet = state.fleets[side]
    const anvil = anvilOf(state, side)
    if (!fleet || !anvil || fleet.commanderId === 'manual' || fleet.ships < 400) continue
    const persona = personaOf(fleet.commanderId, variant)
    const target = pickTarget(state, anvil, persona, book.seen[side])
    if (!target) continue
    const targetId = state.divisions.indexOf(target)
    book.pin[side] = targetId
    const seen = book.seen[side]
    if (seen[seen.length - 1] !== targetId) seen.push(targetId)
    const wing = state.divisions.find((division) => division.side === side && division.slot === 0 && division.alive > 0)
    const axis = frameOf(anvil, target, wing)
    const dist = hypot(target.ax - anvil.ax, target.ay - anvil.ay)
    const bow = (CLASS_STATS[classIndex(target.classId)] ?? SHIP_STATS).batteries[0]?.maxRange ?? 900
    // Start the flank about twelve seconds of closing before the guns, so the swing is finished on contact.
    const setup = Math.max(persona.range, bow) + 18 * 12
    const triggered = dist <= setup
    if (triggered && book.cue[side] < 0) book.cue[side] = state.time
    let thin = 1
    if (persona.wings === 'one') {
      let pos = 0
      let neg = 0
      for (const division of state.divisions) {
        if (division.side === side || division.alive <= 0) continue
        const across = (division.ax - target.ax) * axis.lx + (division.ay - target.ay) * axis.ly
        if (across >= 0) pos += division.alive
        else neg += division.alive
      }
      thin = neg <= pos ? -1 : 1
    }
    const own = state.divisions.filter((division) => division.side === side && division.alive > 0)
    const roomOf = blockRooms(state, own)
    for (const division of own) {
      const acrossNow = (division.ax - target.ax) * axis.lx + (division.ay - target.ay) * axis.ly
      let keep = acrossNow >= 0 ? 1 : -1
      if (Math.abs(acrossNow) < 30) keep = division.slot < 2 ? -1 : 1
      const outer = Math.abs(division.slot - 2) >= 2
      const hold = Math.min(820, Math.max(620, persona.range - 80))
      let lateral = 0
      let depth = hold
      let angle = 0
      if (outer && triggered && (persona.wings === 'both' || keep === thin)) {
        angle = persona.angle
        if (persona.abort && outflanked(state, side, division, axis, target)) angle = 0
      }
      if (Math.abs(division.slot - 2) >= 1) {
        const span = 740
        const reach = Math.abs(division.slot - 2) >= 2 ? span : 380
        lateral = keep * reach
        if (outer) {
          const rad = (angle * Math.PI) / 180
          lateral = keep * span * Math.cos(rad)
          depth = holdsRank(variant) ? hold : hold - span * Math.sin(rad)
        }
      }
      const fitted = fleet.ships > 2000 ? keep * (roomOf.get(division.slot) ?? 0) : 0
      if (Math.abs(fitted) > Math.abs(lateral)) lateral = fitted
      const goal = place(target, axis, depth, lateral)
      steer(division, goal.x, goal.y, target.ax, target.ay, angle > 0 ? 20 : 14, dt, !enemyInRange(state, division))
      division.hunt = targetId
      division.focus = true
      division.focusX = target.ax
      division.focusY = target.ay
    }
  }
}

function holdsRank(variant: TacticVariant): boolean {
  return variant === 'r7b'
}

/** How far each slot must sit from the center so neighboring blocks do not meet. */
function blockRooms(state: SimState, own: readonly Division[]): Map<number, number> {
  const half = new Map<number, number>()
  const ships = state.ships
  for (const division of own) {
    const index = state.divisions.indexOf(division)
    let reach = hullRadius(classIndex(division.classId))
    for (let i = 0; i < ships.count; i++) {
      if (ships.alive[i] !== 1 || ships.division[i] !== index) continue
      reach = Math.max(reach, Math.abs(ships.slotX[i] ?? 0) + hullRadius(ships.shipClass[i] ?? 0))
    }
    half.set(division.slot, reach)
  }
  const room = new Map<number, number>()
  room.set(2, 0)
  for (const slot of [0, 1, 3, 4]) {
    const path = slot < 2 ? [1, 0] : [3, 4]
    let dist = 0
    let prev = 2
    for (const next of path) {
      dist += (half.get(prev) ?? 0) + (half.get(next) ?? 0) + 32
      if (next === slot) break
      prev = next
    }
    room.set(slot, dist)
  }
  return room
}

