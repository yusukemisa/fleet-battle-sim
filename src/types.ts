import type { ShipStats } from './balance.ts'
import type { CombatScratch } from './spatial.ts'

export const SHIP_COUNTS = [100, 1000, 10000] as const
export type ShipCount = (typeof SHIP_COUNTS)[number]

export const FORMATION_IDS = ['oujin', 'kakuyoku', 'engetsu', 'gyorin', 'hoshi', 'houen'] as const
export type FormationId = (typeof FORMATION_IDS)[number]

export const TACTIC_IDS = [
  'charge',
  'hold',
  'flank',
  'broadside',
  'rear',
  'pin',
  'encircle',
  'breakthrough',
  'feint',
  'focus',
] as const
export type TacticId = (typeof TACTIC_IDS)[number]

export const COMMANDER_IDS = ['manual', 'fierce', 'cunning', 'guard', 'balanced'] as const
export type CommanderId = (typeof COMMANDER_IDS)[number]
export const DEFAULT_COMMANDER: CommanderId = 'balanced'

export const DIVISION_NAMES = ['左翼', '左衛', '中軍', '右衛', '右翼'] as const
export const DIVISIONS_PER_SIDE = DIVISION_NAMES.length

export type SideId = 0 | 1
export type Speed = 1 | 2 | 4
export type DivisionSlot = 0 | 1 | 2 | 3 | 4

export const DEFAULT_SHIP_COUNT: ShipCount = 1000
export const DEFAULT_FORMATION: FormationId = 'oujin'

export type GunneryMode = 'legacy' | 'aimed'

/** Shot quality gathered during one battle. Times are summed sim-seconds. */
export interface GunneryTally {
  shots: number
  hits: number
  damage: number
  overkill: number
  /** Ready guns that did not fire. */
  idle: number
  /** Ready guns that had a living target inside arc and range, and still did not fire. */
  held: number
  /** Ready guns whose current target sat outside the arc or the range. */
  wide: number
  deaths: number
  deathTime: number
}

export type BattlePhase =
  | { kind: 'setup'; speed: Speed }
  | { kind: 'running'; speed: Speed }
  | { kind: 'paused'; speed: Speed }
  | { kind: 'finished'; winner: SideId | 'draw' }

/** A ship is an index into {@link Ships}. The sim never allocates one object per ship. */
export type Ship = number

export interface Ships {
  count: number
  x: Float32Array
  y: Float32Array
  vx: Float32Array
  vy: Float32Array
  hp: Float32Array
  flash: Float32Array
  cooldown: Float32Array
  slotX: Float32Array
  slotY: Float32Array
  homeX: Float32Array
  homeY: Float32Array
  /** 1 when this ship has dropped behind its division. */
  falling: Uint8Array
  heading: Float32Array
  alive: Uint8Array
  side: Uint8Array
  division: Uint8Array
  command: Uint8Array
  target: Int32Array
}

export interface Fleet {
  side: SideId
  name: string
  formationId: FormationId
  commanderId: CommanderId
  centerX: number
  centerY: number
  facingX: number
  facingY: number
  /** 0 while closing in, 1 while sliding past. Shared by the sweeping divisions. */
  sweepLeg: 0 | 1
}

export interface Division {
  side: SideId
  slot: DivisionSlot
  name: string
  tacticId: TacticId
  ax: number
  ay: number
  fx: number
  fy: number
  rx: number
  ry: number
  vx: number
  vy: number
  phase: number
  phaseT: number
  holdX: number
  holdY: number
  holdArmed: boolean
  flankSign: number
  orbitBase: number
  focus: boolean
  focusX: number
  focusY: number
  /** Point this division is steering toward. */
  markX: number
  markY: number
  sweepAlong: number
  sweepOut: number
  sweepLocked: boolean
  sweeping: boolean
  alive: number
  roster: number
}

export interface FormationLayout {
  count: number
  x: Float32Array
  y: Float32Array
  division: Uint8Array
}

export interface Formation {
  id: FormationId
  name: string
  summary: string
  place(layout: FormationLayout): void
}

export interface TacticContext {
  ownX: number
  ownY: number
  enemyX: number
  enemyY: number
  sweepLeg: 0 | 1
  divisions: readonly Division[]
}

export interface Tactic {
  id: TacticId
  name: string
  summary: string
  focus: boolean
  /** Ships point the bow at the enemy instead of along the path to the slot. */
  guns: boolean
  /**
   * Join the clockwise fleet wheel inside engagement range.
   * 定点射撃 leaves this false and stays on its point.
   */
  sweep: boolean
  step(div: Division, ctx: TacticContext, dt: number): void
}

export type Command =
  | { type: 'set-ship-count'; count: ShipCount }
  | { type: 'set-formation'; side: SideId; formationId: FormationId }
  | { type: 'set-tactic'; division: number; tacticId: TacticId }
  | { type: 'set-side-tactic'; side: SideId; tacticId: TacticId }
  | { type: 'set-commander'; side: SideId; commanderId: CommanderId }
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'set-speed'; speed: Speed }
  | { type: 'reset' }
  | { type: 'tick'; dt: number }

export interface SimConfig {
  shipCount: ShipCount
  formations?: readonly [FormationId, FormationId]
  tactics?: readonly TacticId[]
  commanders?: readonly [CommanderId, CommanderId]
  hp?: number
  damage?: readonly [number, number]
  gunnery?: GunneryMode
  /** Per side. False keeps every ship on the station it was given. */
  withdraw?: readonly [boolean, boolean]
}

export interface Beams {
  life: Float32Array
  x1: Float32Array
  y1: Float32Array
  x2: Float32Array
  y2: Float32Array
  side: Uint8Array
  head: number
}

export interface Booms {
  life: Float32Array
  x: Float32Array
  y: Float32Array
  side: Uint8Array
  head: number
}

/** Hits landed by each side, split by the armor they struck. */
export interface ArmorHits {
  front: [number, number]
  side: [number, number]
  rear: [number, number]
}

export interface SimState {
  shipCount: ShipCount
  phase: BattlePhase
  ships: Ships
  fleets: [Fleet, Fleet]
  divisions: Division[]
  alive: [number, number]
  lost: [number, number]
  centroidX: [number, number]
  centroidY: [number, number]
  time: number
  frame: number
  rng: number
  stats: ShipStats
  damage: [number, number]
  commandAt: number
  log: string[]
  hits: ArmorHits
  beams: Beams
  booms: Booms
  gunnery: GunneryMode
  withdrawSides: readonly [boolean, boolean]
  tally: GunneryTally
  scratch: CombatScratch
  rankAt: number
  fallingN: number
}
