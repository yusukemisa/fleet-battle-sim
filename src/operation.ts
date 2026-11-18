import { BLAST, CLASS_MODS, CLASS_STATS, classIndex, hullRadius, SHIP_STATS } from './balance.ts'
import { collectNear } from './spatial.ts'
import { shipUnderFire } from './threat.ts'
import type { CommanderId, Division, SideId, SimState } from './types.ts'

/**
 * Anvil-and-hammer overlay. The opening behaviour keeps hammer wings on the
 * anvil's depth. `main` is the older movement, kept for comparison.
 * One fleet against one fleet, and only a side with at least 400 ships.
 */
export const TACTIC_VARIANTS = ['main', 'table', 'r7a', 'r7b', 'r7c', 'u8a', 'u8b', 'u8c', 'u8d', 'u9a', 'u9b', 'u9c', 'u10a', 'u10b', 'u10c'] as const
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
  {
    id: 'u8a',
    label: '10隻、間隔36',
    title: '槌は列に残したうえで、生きている艦を10隻の横隊にします。艦の間隔は36、列の間隔は72です。欠けた列は短くなります。',
  },
  {
    id: 'u8b',
    label: '10隻、広い間隔',
    title: '同じ横隊です。艦の間隔は56、列の間隔は120、横には1列だけ並びます。',
  },
  {
    id: 'u8c',
    label: '10隻、欠けたら合流',
    title: '間隔は案aと同じです。5隻を切った列は、隣の列に空席があればそこへ入ります。',
  },
  {
    id: 'u8d',
    label: '10隻、同じ的',
    title: '横に3列。艦の間隔は40、列の間隔は84です。一つの列は同じ敵艦を狙います。',
  },
  {
    id: 'u9a',
    label: '開戦の位置のまま',
    title: '艦は初期配置から動かしません。10隻が同じ敵を狙い、隊は槌の間隔のまま前へ出ます。',
  },
  {
    id: 'u9b',
    label: '横に広い塊',
    title: '各隊を横長の塊にし、隊の間隔は槌のままにします。10隻が同じ敵を狙います。欠けた席は隣へ1艦分だけ詰めます。',
  },
  {
    id: 'u9c',
    label: '列を揃えて同じ的',
    title: '開戦の列を横に揃え、10隻が同じ敵を狙います。隊は槌の間隔のまま進み、開戦時に隊列を組み直しません。',
  },
  {
    id: 'u10a',
    label: '10隻、接触を避ける',
    title: '10隻の横隊です。隣の艦とは船体と、曲がって止まる分だけ空けます。開戦の並びのまま、その後は席を動かしません。',
  },
  {
    id: 'u10b',
    label: '10隻、爆風を止める',
    title: '同じ横隊です。10隻の列と列のあいだは、戦艦の爆発が届かないだけ空けます。隊が重なるときは横へ開きます。',
  },
  {
    id: 'u10c',
    label: '10隻、砲下は直進',
    title: '爆風の隙間は同じです。敵の砲の下では席を横に追わず、針路のまま進むか止まります。味方の船体には踏み込みません。',
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
  u8a: 'u8a',
  u8b: 'u8b',
  u8c: 'u8c',
  u8d: 'u8d',
  u9a: 'u9a',
  u9b: 'u9b',
  u9c: 'u9c',
  u10a: 'u10a',
  u10b: 'u10b',
  u10c: 'u10c',
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
  unitOf: Int16Array | null
  seq: Int16Array | null
  placed: Uint8Array | null
  /** Lateral floor so a cleared line is not pulled back into the next division. */
  span: Float32Array | null
  fitted: [boolean, boolean]
}

const books = new WeakMap<SimState, Book>()

function bookOf(state: SimState): Book {
  let book = books.get(state)
  if (!book) {
    book = { pin: [-1, -1], cue: [-1, -1], seen: [[], []], unitOf: null, seq: null, placed: null, span: null, fitted: [false, false] }
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

/** Outside gun range, keep the approach slower than the lateral dress. */
export function limitApproach(state: SimState, div: Division): void {
  if (enemyInRange(state, div)) return
  let nx = 0
  let ny = 0
  let best = Infinity
  for (const other of state.divisions) {
    if (other.side === div.side || other.alive <= 0) continue
    const dx = other.ax - div.ax
    const dy = other.ay - div.ay
    const dist = hypot(dx, dy)
    if (dist < best && dist > 1) {
      best = dist
      nx = dx / dist
      ny = dy / dist
    }
  }
  if (best === Infinity) return
  const closing = div.vx * nx + div.vy * ny
  const cap = 10
  if (closing > cap) {
    div.vx -= (closing - cap) * nx
    div.vy -= (closing - cap) * ny
  }
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

function lateralFrom(
  state: SimState,
  division: Division,
  anvil: Division,
  axis: { lx: number; ly: number },
  hammer: number,
  style: UnitStyle | undefined,
): number {
  if (!style?.fit) return hammer
  const book = bookOf(state)
  const span = book.span
  const index = state.divisions.indexOf(division)
  const floor = span && index >= 0 ? (span[index] ?? 0) : 0
  const sign = hammer !== 0 ? Math.sign(hammer) : Math.sign((division.ax - anvil.ax) * axis.lx + (division.ay - anvil.ay) * axis.ly) || 1
  return sign * Math.max(Math.abs(hammer), floor)
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
    for (const division of own) {
      const acrossNow = (division.ax - target.ax) * axis.lx + (division.ay - target.ay) * axis.ly
      let keep = acrossNow >= 0 ? 1 : -1
      if (Math.abs(acrossNow) < 30) keep = division.slot < 2 ? -1 : 1
      const outer = Math.abs(division.slot - 2) >= 2
      const style = UNIT_STYLE[variant]
      const hold = Math.min(820, Math.max(620, persona.range - 80))
      let lateral = 0
      let depth = hold - (style?.close ?? 0)
      let angle = 0
      if (outer && triggered && (persona.wings === 'both' || keep === thin)) {
        angle = persona.angle
        if (persona.abort && outflanked(state, side, division, axis, target)) angle = 0
      }
      if (style?.line) {
        const span = 740
        const wing = Math.abs(division.slot - 2)
        if (wing >= 2) {
          const rad = (angle * Math.PI) / 180
          lateral = keep * span * Math.cos(rad)
          depth -= style.crescent
        } else if (wing === 1) {
          lateral = keep * 380
          depth -= style.crescent * 0.5
        }
      } else if (style) {
        const aspect = division.slot === 2 ? style.centerAspect : 4
        const grid = wideGrid(Math.max(1, division.roster || division.alive), aspect)
        const pitch = (Math.max(0, grid.across - 1) * style.ship + style.file) * style.spread
        lateral = (division.slot - 2) * pitch
        if (angle > 0) lateral *= Math.cos((angle * Math.PI) / 180)
        const wing = Math.abs(division.slot - 2)
        if (wing >= 2) depth -= style.crescent
        else if (wing === 1) depth -= style.crescent * 0.5
      } else if (Math.abs(division.slot - 2) >= 1) {
        const span = 740
        const reach = Math.abs(division.slot - 2) >= 2 ? span : 380
        lateral = keep * reach
        if (outer) {
          const rad = (angle * Math.PI) / 180
          lateral = keep * span * Math.cos(rad)
          depth = holdsRank(variant) ? hold : hold - span * Math.sin(rad)
        }
      }
      const goal = place(target, axis, depth, lateralFrom(state, division, anvil, axis, lateral, style))
      steer(division, goal.x, goal.y, target.ax, target.ay, (angle > 0 ? 20 : 14) * (style?.pace ?? 1), dt, !enemyInRange(state, division))
      if (style) limitApproach(state, division)
      division.hunt = targetId
      division.focus = true
      division.focusX = target.ax
      division.focusY = target.ay
    }
  }
}

function holdsRank(variant: TacticVariant): boolean {
  return variant === 'r7b' || variant === 'u8a' || variant === 'u8b' || variant === 'u8c' || variant === 'u8d'
}

interface UnitStyle {
  ship: number
  rank: number
  file: number
  files: number
  merge: boolean
  shareAim: boolean
  /** Pull the whole front this far inside the usual hold. */
  close: number
  /** Fraction of the full division spacing. 1 keeps the widest fan. */
  spread: number
  /** How far the outer wings sit ahead of the center. */
  crescent: number
  /** Width/depth target for the center division. Smaller is thicker. */
  centerAspect: number
  /** Multiplier on the division's closing speed. */
  pace: number
  /** Leave the center division on the opening formation. */
  keepCenter: boolean
  /** Even out each existing rank instead of building a new grid. */
  alongRanks: boolean
  /** Keep every ship on the station it had when the battle opened. */
  freeze: boolean
  /** Keep division goals on the hammer line (380 / 740) instead of the block width. */
  line: boolean
  /** `class` spaces hulls by radius plus the turn-and-stop room. `blast` also separates each rank by an explosion. */
  clear?: 'class' | 'blast'
  /** Under fire, follow the bow instead of sliding toward a seat. */
  straight?: boolean
  /** Do not step a ship into a friendly hull while it returns to its seat. */
  yield?: boolean
  /** Remember a wider lateral gap when the cleared ranks would otherwise meet. */
  fit?: boolean
}

const UNIT_STYLE: Partial<Record<TacticVariant, UnitStyle>> = {
  u8a: { ship: 36, rank: 72, file: 48, files: 2, merge: false, shareAim: false, close: 0, spread: 1, crescent: 0, centerAspect: 4, pace: 1, keepCenter: false, alongRanks: false, freeze: false, line: false },
  u8b: { ship: 56, rank: 120, file: 80, files: 1, merge: false, shareAim: false, close: 0, spread: 1, crescent: 0, centerAspect: 4, pace: 1, keepCenter: false, alongRanks: false, freeze: false, line: false },
  u8c: { ship: 36, rank: 72, file: 48, files: 2, merge: true, shareAim: false, close: 0, spread: 1, crescent: 0, centerAspect: 4, pace: 1, keepCenter: false, alongRanks: false, freeze: false, line: false },
  u8d: { ship: 40, rank: 84, file: 56, files: 3, merge: false, shareAim: true, close: 0, spread: 1, crescent: 0, centerAspect: 4, pace: 1, keepCenter: false, alongRanks: false, freeze: false, line: false },
  u9a: { ship: 32, rank: 72, file: 48, files: 2, merge: false, shareAim: true, close: 0, spread: 1, crescent: 0, centerAspect: 4, pace: 1, keepCenter: false, alongRanks: false, freeze: true, line: true },
  u9b: { ship: 36, rank: 72, file: 48, files: 2, merge: false, shareAim: true, close: 0, spread: 1, crescent: 0, centerAspect: 4, pace: 1, keepCenter: false, alongRanks: false, freeze: false, line: true },
  u9c: { ship: 32, rank: 72, file: 48, files: 2, merge: false, shareAim: true, close: 0, spread: 1, crescent: 0, centerAspect: 4, pace: 1, keepCenter: false, alongRanks: true, freeze: false, line: true },
  u10a: { ship: 24, rank: 40, file: 48, files: 1, merge: false, shareAim: true, close: 0, spread: 1, crescent: 0, centerAspect: 4, pace: 1, keepCenter: false, alongRanks: false, freeze: true, line: true, clear: 'class', yield: true, fit: true },
  u10b: { ship: 24, rank: 42, file: 48, files: 1, merge: false, shareAim: true, close: 0, spread: 1, crescent: 0, centerAspect: 4, pace: 1, keepCenter: false, alongRanks: false, freeze: true, line: true, clear: 'blast', yield: true, fit: true },
  u10c: { ship: 24, rank: 42, file: 48, files: 1, merge: false, shareAim: true, close: 0, spread: 1, crescent: 0, centerAspect: 4, pace: 1, keepCenter: false, alongRanks: false, freeze: true, line: true, clear: 'blast', straight: true, yield: true, fit: true },
}

export function wideGrid(count: number, aspect = 4): { across: number; depth: number } {
  if (count <= 1) return { across: Math.max(1, count), depth: 1 }
  let depth = Math.max(1, Math.round(Math.sqrt(count / aspect)))
  let across = Math.ceil(count / depth)
  while (depth > 1 && across / depth < aspect) {
    depth -= 1
    across = Math.ceil(count / depth)
  }
  return { across, depth }
}

export function seatUnits(state: SimState): void {
  if (!UNIT_STYLE[variants[0]] && !UNIT_STYLE[variants[1]]) return
  const book = bookOf(state)
  const count = state.ships.count
  if (!book.unitOf || book.unitOf.length < count || !book.seq || !book.placed) {
    const unitOf = new Int16Array(count)
    const seq = new Int16Array(count)
    const placed = new Uint8Array(count)
    unitOf.fill(-1)
    seq.fill(-1)
    if (book.unitOf) unitOf.set(book.unitOf)
    if (book.seq) seq.set(book.seq)
    if (book.placed) placed.set(book.placed)
    book.unitOf = unitOf
    book.seq = seq
    book.placed = placed
  }
  const unitOf = book.unitOf
  const seq = book.seq
  const placed = book.placed
  if (!unitOf || !seq || !placed) return
  for (const side of [0, 1] as const) {
    const style = UNIT_STYLE[variants[side]]
    if (!style) continue
    const fleet = state.fleets[side]
    if (!fleet || fleet.commanderId === 'manual' || fleet.ships < 400) continue
    for (let index = 0; index < state.divisions.length; index++) {
      const division = state.divisions[index]
      if (!division || division.side !== side || division.alive <= 0) continue
      seatDivision(state, division, index, style, unitOf, seq, placed)
    }
    if (style.fit && !bookOf(state).fitted[side]) {
      rememberSpan(state, side)
      bookOf(state).fitted[side] = true
    }
  }
}

function seatDivision(
  state: SimState,
  division: Division,
  divisionIndex: number,
  style: UnitStyle,
  unitOf: Int16Array,
  seq: Int16Array,
  placed: Uint8Array,
): void {
  const ships = state.ships
  const members: number[] = []
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] !== 1 || ships.division[i] !== divisionIndex) continue
    members.push(i)
  }
  if (members.length === 0) return
  if (style.clear) {
    openClear(division, members, style, unitOf, seq, placed, ships)
    if (style.shareAim) aimGroups(state, division, members, unitOf, ships)
    return
  }
  if (style.keepCenter && division.slot === 2) return
  const fresh = members.filter((ship) => (seq[ship] ?? -1) < 0)
  fresh.sort((a, b) => (ships.slotX[a] ?? 0) - (ships.slotX[b] ?? 0) || (ships.slotY[a] ?? 0) - (ships.slotY[b] ?? 0) || a - b)
  let nextSeq = -1
  let maxUnit = -1
  for (const ship of members) {
    if ((seq[ship] ?? -1) > nextSeq) nextSeq = seq[ship] ?? -1
    if ((unitOf[ship] ?? -1) > maxUnit) maxUnit = unitOf[ship] ?? -1
  }
  let fill = 0
  let unit = maxUnit < 0 ? 0 : maxUnit
  if (maxUnit >= 0) {
    for (const ship of members) if ((unitOf[ship] ?? -1) === unit) fill += 1
  }
  for (const ship of fresh) {
    if (fill >= 10 || maxUnit < 0) {
      unit = maxUnit + 1
      maxUnit = unit
      fill = 0
    }
    unitOf[ship] = unit
    nextSeq += 1
    seq[ship] = nextSeq
    fill += 1
  }
  if (style.merge) mergeShort(members, unitOf)
  if (style.freeze) {
    for (const ship of members) {
      if (placed[ship] === 0) {
        placed[ship] = 1
        snapShip(division, ships, ship)
      }
      ships.homeX[ship] = ships.slotX[ship] ?? 0
      ships.homeY[ship] = ships.slotY[ship] ?? 0
    }
    if (style.shareAim) aimGroups(state, division, members, unitOf, ships)
    return
  }
  if (style.alongRanks) {
    layoutRanks(division, members, style, placed, ships, enemyInRange(state, division))
    if (style.shareAim) aimGroups(state, division, members, unitOf, ships)
    return
  }
  members.sort((a, b) => (seq[a] ?? 0) - (seq[b] ?? 0) || a - b)
  const aspect = division.slot === 2 ? style.centerAspect : 4
  const grid = wideGrid(members.length, aspect)
  const depthGap = style.ship * 1.4
  for (let i = 0; i < members.length; i++) {
    const ship = members[i]
    if (ship === undefined) continue
    const waiting = placed[ship] !== 0 && (!enemyInRange(state, division) || (shipUnderFire(ship) && ships.falling[ship] !== 1))
    if (waiting) continue
    const col = i % grid.across
    const row = Math.floor(i / grid.across)
    const idealX = (col - (grid.across - 1) / 2) * style.ship
    const idealY = (row - (grid.depth - 1) / 2) * depthGap
    if (placed[ship] === 0) {
      ships.slotX[ship] = idealX
      ships.slotY[ship] = idealY
      placed[ship] = 1
      snapShip(division, ships, ship)
    } else {
      const dx = Math.max(-style.ship, Math.min(style.ship, idealX - (ships.slotX[ship] ?? 0)))
      const dy = Math.max(-depthGap, Math.min(depthGap, idealY - (ships.slotY[ship] ?? 0)))
      ships.slotX[ship] = (ships.slotX[ship] ?? 0) + dx
      ships.slotY[ship] = (ships.slotY[ship] ?? 0) + dy
    }
    ships.homeX[ship] = ships.slotX[ship] ?? 0
    ships.homeY[ship] = ships.slotY[ship] ?? 0
  }
  if (style.shareAim) {
    const groups = new Map<number, number[]>()
    for (const ship of members) {
      const id = unitOf[ship] ?? 0
      const list = groups.get(id)
      if (list) list.push(ship)
      else groups.set(id, [ship])
    }
    for (const list of groups.values()) {
      let sx = 0
      let sy = 0
      for (const ship of list) {
        sx += ships.slotX[ship] ?? 0
        sy += ships.slotY[ship] ?? 0
      }
      aimUnit(state, division, list, sx / list.length, sy / list.length)
    }
  }
}

function stopRoom(radius: number): number {
  if (radius >= 7) return 10
  if (radius >= 4) return 6
  return 4
}

function pairPitch(classA: number, classB: number, blast: boolean): number {
  const left = hullRadius(classA)
  const right = hullRadius(classB)
  const touch = left + right + Math.max(stopRoom(left), stopRoom(right))
  if (!blast) return touch
  return Math.max(touch, Math.max(left, right) * BLAST.reach + 2)
}

function heaviest(ships: SimState['ships'], list: readonly number[]): number {
  let best = 0
  let radius = 0
  for (const ship of list) {
    const klass = ships.shipClass[ship] ?? 0
    const size = hullRadius(klass)
    if (size > radius) {
      radius = size
      best = klass
    }
  }
  return best
}

function openClear(
  division: Division,
  members: number[],
  style: UnitStyle,
  unitOf: Int16Array,
  seq: Int16Array,
  placed: Uint8Array,
  ships: SimState['ships'],
): void {
  if (members.every((ship) => placed[ship] !== 0)) {
    for (const ship of members) {
      ships.slotX[ship] = ships.homeX[ship] ?? 0
      if (ships.falling[ship] !== 1) ships.slotY[ship] = ships.homeY[ship] ?? 0
    }
    return
  }
  const ordered = members.slice().sort((a, b) => (ships.homeY[b] ?? 0) - (ships.homeY[a] ?? 0) || (ships.homeX[a] ?? 0) - (ships.homeX[b] ?? 0) || a - b)
  const units: number[][] = []
  for (let i = 0; i < ordered.length; i += 10) units.push(ordered.slice(i, i + 10))
  const blast = style.clear === 'blast'
  const seats: { ship: number; x: number; y: number }[] = []
  let depth = 0
  for (let row = 0; row < units.length; row++) {
    const unit = units[row]
    if (!unit || unit.length === 0) continue
    const along: number[] = [0]
    for (let col = 1; col < unit.length; col++) {
      const prev = unit[col - 1]
      const ship = unit[col]
      if (prev === undefined || ship === undefined) continue
      along.push((along[col - 1] ?? 0) + pairPitch(ships.shipClass[prev] ?? 0, ships.shipClass[ship] ?? 0, false))
    }
    const mid = ((along[0] ?? 0) + (along[unit.length - 1] ?? 0)) / 2
    for (let col = 0; col < unit.length; col++) {
      const ship = unit[col]
      if (ship === undefined) continue
      seats.push({ ship, x: (along[col] ?? 0) - mid, y: depth })
    }
    const next = units[row + 1]
    if (next && next.length > 0) depth -= pairPitch(heaviest(ships, unit), heaviest(ships, next), blast)
  }
  let meanY = 0
  for (const seat of seats) meanY += seat.y
  meanY /= Math.max(1, seats.length)
  let nextSeq = 0
  for (let row = 0; row < units.length; row++) {
    const unit = units[row]
    if (!unit) continue
    for (const ship of unit) {
      unitOf[ship] = row
      seq[ship] = nextSeq
      nextSeq += 1
    }
  }
  for (const seat of seats) {
    ships.slotX[seat.ship] = seat.x
    ships.slotY[seat.ship] = seat.y - meanY
    ships.homeX[seat.ship] = seat.x
    ships.homeY[seat.ship] = seat.y - meanY
    placed[seat.ship] = 1
    snapShip(division, ships, seat.ship)
  }
}

function rememberSpan(state: SimState, side: SideId): void {
  const own = state.divisions.filter((division) => division.side === side && division.alive > 0)
  if (own.length === 0) return
  const anvil = own.find((division) => division.slot === 2) ?? own[0]
  if (!anvil) return
  const lateralOf = (division: Division) => division.ax * anvil.rx + division.ay * anvil.ry
  const halfOf = (division: Division) => {
    const index = state.divisions.indexOf(division)
    let half = hullRadius(classIndex(division.classId))
    const ships = state.ships
    for (let i = 0; i < ships.count; i++) {
      if (ships.alive[i] !== 1 || ships.division[i] !== index) continue
      half = Math.max(half, Math.abs(ships.slotX[i] ?? 0) + hullRadius(ships.shipClass[i] ?? 0))
    }
    return half
  }
  const ordered = own.slice().sort((a, b) => lateralOf(a) - lateralOf(b))
  const seam = (left: Division, right: Division) => pairPitch(classIndex(left.classId), classIndex(right.classId), true)
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]
    const cur = ordered[i]
    if (!prev || !cur) continue
    const need = halfOf(prev) + halfOf(cur) + seam(prev, cur) - (lateralOf(cur) - lateralOf(prev))
    if (need <= 0) continue
    for (let j = i; j < ordered.length; j++) {
      const division = ordered[j]
      if (!division) continue
      division.ax += anvil.rx * need
      division.ay += anvil.ry * need
      const index = state.divisions.indexOf(division)
      const ships = state.ships
      for (let ship = 0; ship < ships.count; ship++) {
        if (ships.alive[ship] !== 1 || ships.division[ship] !== index) continue
        snapShip(division, ships, ship)
      }
    }
  }
  const book = bookOf(state)
  if (!book.span || book.span.length < state.divisions.length) book.span = new Float32Array(state.divisions.length)
  for (const division of own) {
    const index = state.divisions.indexOf(division)
    if (index < 0 || !book.span) continue
    book.span[index] = Math.abs(lateralOf(division) - lateralOf(anvil))
  }
}

function snapShip(division: Division, ships: SimState['ships'], ship: number): void {
  const sx = ships.slotX[ship] ?? 0
  const sy = ships.slotY[ship] ?? 0
  ships.x[ship] = division.ax + division.rx * sx + division.fx * sy
  ships.y[ship] = division.ay + division.ry * sx + division.fy * sy
  ships.vx[ship] = division.vx
  ships.vy[ship] = division.vy
}

function layoutRanks(
  division: Division,
  members: number[],
  style: UnitStyle,
  placed: Uint8Array,
  ships: SimState['ships'],
  inRange: boolean,
): void {
  const ordered = members.slice().sort((a, b) => (ships.slotY[a] ?? 0) - (ships.slotY[b] ?? 0) || (ships.slotX[a] ?? 0) - (ships.slotX[b] ?? 0) || a - b)
  const rows: number[][] = []
  let row: number[] = []
  let lastY: number | null = null
  for (const ship of ordered) {
    const y = ships.slotY[ship] ?? 0
    if (lastY !== null && Math.abs(y - lastY) > 18 && row.length > 0) {
      rows.push(row)
      row = []
    }
    row.push(ship)
    lastY = y
  }
  if (row.length > 0) rows.push(row)
  for (const group of rows) {
    group.sort((a, b) => (ships.slotX[a] ?? 0) - (ships.slotX[b] ?? 0) || a - b)
    let sx = 0
    let sy = 0
    for (const ship of group) {
      sx += ships.slotX[ship] ?? 0
      sy += ships.slotY[ship] ?? 0
    }
    const meanX = sx / group.length
    const meanY = sy / group.length
    const fresh = group.every((ship) => placed[ship] === 0)
    for (let i = 0; i < group.length; i++) {
      const ship = group[i]
      if (ship === undefined) continue
      const waiting = placed[ship] !== 0 && (!inRange || (shipUnderFire(ship) && ships.falling[ship] !== 1))
      if (waiting) continue
      const idealX = meanX + (i - (group.length - 1) / 2) * style.ship
      if (fresh) {
        ships.slotX[ship] = idealX
        ships.slotY[ship] = meanY
        placed[ship] = 1
        snapShip(division, ships, ship)
      } else {
        const dx = Math.max(-style.ship, Math.min(style.ship, idealX - (ships.slotX[ship] ?? 0)))
        ships.slotX[ship] = (ships.slotX[ship] ?? 0) + dx
        ships.slotY[ship] = meanY
      }
      ships.homeX[ship] = ships.slotX[ship] ?? 0
      ships.homeY[ship] = ships.slotY[ship] ?? 0
    }
  }
}

function aimGroups(state: SimState, division: Division, members: number[], unitOf: Int16Array, ships: SimState['ships']): void {
  const groups = new Map<number, number[]>()
  for (const ship of members) {
    const id = unitOf[ship] ?? 0
    const list = groups.get(id)
    if (list) list.push(ship)
    else groups.set(id, [ship])
  }
  for (const list of groups.values()) {
    let sx = 0
    let sy = 0
    for (const ship of list) {
      sx += ships.slotX[ship] ?? 0
      sy += ships.slotY[ship] ?? 0
    }
    aimUnit(state, division, list, sx / list.length, sy / list.length)
  }
}

function mergeShort(members: number[], unitOf: Int16Array): void {
  const counts = new Map<number, number>()
  for (const ship of members) {
    const id = unitOf[ship] ?? 0
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const ids = [...counts.keys()].sort((a, b) => a - b)
  for (const id of ids) {
    const alive = counts.get(id) ?? 0
    if (alive === 0 || alive >= 5) continue
    let host = -1
    let nearest = Infinity
    for (const other of ids) {
      if (other === id) continue
      const space = 10 - (counts.get(other) ?? 0)
      if (space <= 0) continue
      const dist = Math.abs(other - id)
      if (dist < nearest) {
        nearest = dist
        host = other
      }
    }
    if (host < 0) continue
    let moved = 0
    const room = 10 - (counts.get(host) ?? 0)
    for (const ship of members) {
      if ((unitOf[ship] ?? 0) !== id || moved >= room) continue
      unitOf[ship] = host
      moved += 1
    }
    counts.set(host, (counts.get(host) ?? 0) + moved)
    counts.set(id, alive - moved)
  }
}

export function holdUnitStations(state: SimState, dt: number): void {
  if (!UNIT_STYLE[variants[0]] && !UNIT_STYLE[variants[1]]) return
  const ships = state.ships
  const pace = 90 * dt
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] !== 1) continue
    const side: SideId = ships.side[i] === 1 ? 1 : 0
    const style = UNIT_STYLE[variants[side]]
    if (!style) continue
    const division = state.divisions[ships.division[i] ?? 0]
    if (!division) continue
    let dx = division.ax + division.rx * (ships.slotX[i] ?? 0) + division.fx * (ships.slotY[i] ?? 0) - (ships.x[i] ?? 0)
    let dy = division.ay + division.ry * (ships.slotX[i] ?? 0) + division.fy * (ships.slotY[i] ?? 0) - (ships.y[i] ?? 0)
    if (style.straight && shipUnderFire(i)) {
      const hx = Math.cos(ships.heading[i] ?? 0)
      const hy = Math.sin(ships.heading[i] ?? 0)
      const along = dx * hx + dy * hy
      if (along <= 0.5) continue
      dx = hx * along
      dy = hy * along
    }
    const dist = Math.hypot(dx, dy)
    if (dist < 0.5) continue
    let step = Math.min(pace, dist)
    if (style.yield) step = clearStep(state, i, dx, dy, step)
    if (step <= 0) continue
    ships.x[i] = (ships.x[i] ?? 0) + (dx / dist) * step
    ships.y[i] = (ships.y[i] ?? 0) + (dy / dist) * step
  }
}

function clearStep(state: SimState, ship: number, dx: number, dy: number, step: number): number {
  const ships = state.ships
  const x = ships.x[ship] ?? 0
  const y = ships.y[ship] ?? 0
  const dist = Math.hypot(dx, dy) || 1
  const nx = dx / dist
  const ny = dy / dist
  const radius = hullRadius(ships.shipClass[ship] ?? 0)
  const found = collectNear(state.scratch.collide, x, y, radius + 7.1 + step + 2, ships.x, ships.y)
  let allow = step
  for (let k = 0; k < found; k++) {
    const other = state.scratch.collide.found[k] ?? -1
    if (other < 0 || other === ship || ships.alive[other] !== 1 || ships.side[other] !== ships.side[ship]) continue
    const gap = radius + hullRadius(ships.shipClass[other] ?? 0) + 1.5
    const ox = (ships.x[other] ?? 0) - x
    const oy = (ships.y[other] ?? 0) - y
    const along = ox * nx + oy * ny
    if (along <= 0) continue
    const latSq = ox * ox + oy * oy - along * along
    if (latSq >= gap * gap) continue
    const clear = Math.sqrt(Math.max(0, gap * gap - latSq))
    allow = Math.min(allow, Math.max(0, along - clear))
  }
  return allow
}

let aimPool: number[] = []
let aimKey = ''

function aimUnit(state: SimState, division: Division, list: number[], originX: number, originY: number): void {
  const ships = state.ships
  const hunt = division.hunt
  const key = `${division.side}:${hunt}:${state.time}`
  if (aimKey !== key) {
    aimKey = key
    aimPool = []
    for (let i = 0; i < ships.count; i++) {
      if (ships.alive[i] !== 1 || ships.side[i] === division.side) continue
      if (hunt >= 0 && ships.division[i] !== hunt) continue
      aimPool.push(i)
    }
  }
  const cx = division.ax + division.rx * originX + division.fx * originY
  const cy = division.ay + division.ry * originX + division.fy * originY
  let best = -1
  let bestD = Infinity
  for (const i of aimPool) {
    const dx = (ships.x[i] ?? 0) - cx
    const dy = (ships.y[i] ?? 0) - cy
    const dist = dx * dx + dy * dy
    if (dist < bestD) {
      bestD = dist
      best = i
    }
  }
  if (best < 0) return
  for (const ship of list) ships.target[ship] = best
}
