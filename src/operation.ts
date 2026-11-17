import { CLASS_MODS } from './balance.ts'
import type { CommanderId, Division, SideId, SimState } from './types.ts'

/**
 * Optional anvil-and-hammer overlay. `main` leaves the shipped movement alone.
 * The other ids are the fixed round-5 table and the three round-7 trials.
 * One fleet against one fleet, and only a side with at least 400 ships.
 */
export const TACTIC_VARIANTS = ['main', 'table', 'r7a', 'r7b', 'r7c'] as const
export type TacticVariant = (typeof TACTIC_VARIANTS)[number]

export const VARIANT_CHOICES: readonly { id: TacticVariant; label: string; title: string }[] = [
  { id: 'main', label: '今の動き', title: '上書きしません。開いたときの艦隊のままです。' },
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
    id: 'r7b',
    label: '槌は列に残す',
    title: '第5回の表の角度で横へ滑ります。翼は金床の深さから前へ出ません。',
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

let variants: [TacticVariant, TacticVariant] = ['main', 'main']

export function tacticVariants(): readonly [TacticVariant, TacticVariant] {
  return variants
}

export function setTacticVariant(side: SideId, variant: TacticVariant): void {
  variants = side === 0 ? [variant, variants[1]] : [variants[0], variant]
}

export function resetTacticVariants(): void {
  variants = ['main', 'main']
}

export function parseTacticVariant(value: string): TacticVariant | null {
  return ALIAS[value.trim().toLowerCase()] ?? null
}

interface Mark {
  x: number
  y: number
  gx: number
  gy: number
  text: string
  side: SideId
}

interface Book {
  pin: [number, number]
  cue: [number, number]
  seen: [number[], number[]]
  marks: Mark[]
  targets: { x: number; y: number; side: SideId }[]
}

const books = new WeakMap<SimState, Book>()

function bookOf(state: SimState): Book {
  let book = books.get(state)
  if (!book) {
    book = { pin: [-1, -1], cue: [-1, -1], seen: [[], []], marks: [], targets: [] }
    books.set(state, book)
  }
  return book
}

export function operationMarks(state: SimState): { marks: Mark[]; targets: { x: number; y: number; side: SideId }[] } | null {
  if (variants[0] === 'main' && variants[1] === 'main') return null
  const book = books.get(state)
  if (!book || book.marks.length === 0) return null
  return { marks: book.marks, targets: book.targets }
}

function hypot(x: number, y: number): number {
  return Math.hypot(x, y)
}

function steer(div: Division, gx: number, gy: number, faceX: number, faceY: number, speed: number, dt: number): void {
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
  const turn = 1 - Math.exp(-2 * dt)
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
  book.marks = []
  book.targets = []
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
    const triggered = dist <= persona.range
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
    book.targets.push({ x: target.ax, y: target.ay, side })
    const own = state.divisions.filter((division) => division.side === side && division.alive > 0)
    for (const division of own) {
      const acrossNow = (division.ax - target.ax) * axis.lx + (division.ay - target.ay) * axis.ly
      let keep = acrossNow >= 0 ? 1 : -1
      if (Math.abs(acrossNow) < 30) keep = division.slot < 2 ? -1 : 1
      const outer = Math.abs(division.slot - 2) >= 2
      const shoulder = Math.abs(division.slot - 2) === 1
      const hold = Math.min(820, Math.max(620, persona.range - 80))
      let lateral = shoulder || outer ? keep * (shoulder ? 380 : 740) : 0
      let depth = hold
      let text = '金床'
      let angle = 0
      if (outer && triggered && (persona.wings === 'both' || keep === thin)) {
        text = '槌'
        angle = persona.angle
        if (persona.abort && outflanked(state, side, division, axis, target)) angle = 0
      }
      if (outer) {
        const rad = (angle * Math.PI) / 180
        const span = 740
        lateral = keep * span * Math.cos(rad)
        depth = variant === 'r7b' ? hold : hold - span * Math.sin(rad)
      }
      const goal = place(target, axis, depth, lateral)
      steer(division, goal.x, goal.y, target.ax, target.ay, text === '槌' ? 20 : 14, dt)
      division.hunt = targetId
      division.focus = true
      division.focusX = target.ax
      division.focusY = target.ay
      book.marks.push({ x: division.ax, y: division.ay, gx: goal.x, gy: goal.y, text, side })
    }
  }
}
