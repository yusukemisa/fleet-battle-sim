import { CLASS_MODS, CLASS_STATS, classIndex, SHIP_STATS } from './balance.ts'
import { shipUnderFire } from './threat.ts'
import type { CommanderId, Division, SideId, SimState } from './types.ts'

/**
 * Anvil-and-hammer overlay. The opening behaviour keeps hammer wings on the
 * anvil's depth. `main` is the older movement, kept for comparison.
 * One fleet against one fleet, and only a side with at least 400 ships.
 */
export const TACTIC_VARIANTS = ['main', 'table', 'r7a', 'r7b', 'r7c', 'u8a', 'u8b', 'u8c', 'u8d', 'u9a', 'u9b', 'u9c'] as const
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
}

const books = new WeakMap<SimState, Book>()

function bookOf(state: SimState): Book {
  let book = books.get(state)
  if (!book) {
    book = { pin: [-1, -1], cue: [-1, -1], seen: [[], []], unitOf: null, seq: null, placed: null }
    books.set(state, book)
  }
  return book
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
      const goal = place(target, axis, depth, lateral)
      steer(division, goal.x, goal.y, target.ax, target.ay, (angle > 0 ? 20 : 14) * (style?.pace ?? 1), dt)
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
}

const UNIT_STYLE: Partial<Record<TacticVariant, UnitStyle>> = {
  u8a: { ship: 36, rank: 72, file: 48, files: 2, merge: false, shareAim: false, close: 0, spread: 1, crescent: 0, centerAspect: 4, pace: 1, keepCenter: false, alongRanks: false, freeze: false, line: false },
  u8b: { ship: 56, rank: 120, file: 80, files: 1, merge: false, shareAim: false, close: 0, spread: 1, crescent: 0, centerAspect: 4, pace: 1, keepCenter: false, alongRanks: false, freeze: false, line: false },
  u8c: { ship: 36, rank: 72, file: 48, files: 2, merge: true, shareAim: false, close: 0, spread: 1, crescent: 0, centerAspect: 4, pace: 1, keepCenter: false, alongRanks: false, freeze: false, line: false },
  u8d: { ship: 40, rank: 84, file: 56, files: 3, merge: false, shareAim: true, close: 0, spread: 1, crescent: 0, centerAspect: 4, pace: 1, keepCenter: false, alongRanks: false, freeze: false, line: false },
  u9a: { ship: 32, rank: 72, file: 48, files: 2, merge: false, shareAim: true, close: 0, spread: 1, crescent: 0, centerAspect: 4, pace: 1, keepCenter: false, alongRanks: false, freeze: true, line: true },
  u9b: { ship: 36, rank: 72, file: 48, files: 2, merge: false, shareAim: true, close: 0, spread: 1, crescent: 0, centerAspect: 4, pace: 1, keepCenter: false, alongRanks: false, freeze: false, line: true },
  u9c: { ship: 32, rank: 72, file: 48, files: 2, merge: false, shareAim: true, close: 0, spread: 1, crescent: 0, centerAspect: 4, pace: 1, keepCenter: false, alongRanks: true, freeze: false, line: true },
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
    layoutRanks(division, members, style, placed, ships)
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
    if (shipUnderFire(ship) && ships.falling[ship] !== 1) continue
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
      if (shipUnderFire(ship) && ships.falling[ship] !== 1) continue
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
    if (shipUnderFire(i) && ships.falling[i] !== 1) continue
    const side: SideId = ships.side[i] === 1 ? 1 : 0
    if (!UNIT_STYLE[variants[side]]) continue
    const division = state.divisions[ships.division[i] ?? 0]
    if (!division) continue
    const tx = division.ax + division.rx * (ships.slotX[i] ?? 0) + division.fx * (ships.slotY[i] ?? 0)
    const ty = division.ay + division.ry * (ships.slotX[i] ?? 0) + division.fy * (ships.slotY[i] ?? 0)
    const dx = tx - (ships.x[i] ?? 0)
    const dy = ty - (ships.y[i] ?? 0)
    const dist = Math.hypot(dx, dy)
    if (dist < 0.5) continue
    const step = Math.min(pace, dist)
    ships.x[i] = (ships.x[i] ?? 0) + (dx / dist) * step
    ships.y[i] = (ships.y[i] ?? 0) + (dy / dist) * step
  }
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
