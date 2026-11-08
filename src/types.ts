import type { ShipStats } from './balance.ts'

export const SHIP_COUNTS = [100, 1000, 10000] as const
export type ShipCount = (typeof SHIP_COUNTS)[number]

export const FORMATION_IDS = ['kakuyoku', 'engetsu', 'gyorin', 'hoshi', 'houen'] as const
export type FormationId = (typeof FORMATION_IDS)[number]

export const TACTIC_IDS = [
  'charge',
  'hold',
  'flank',
  'encircle',
  'breakthrough',
  'feint',
  'focus',
] as const
export type TacticId = (typeof TACTIC_IDS)[number]

export const DIVISION_NAMES = ['左翼', '左衛', '中軍', '右衛', '右翼'] as const
export const DIVISIONS_PER_SIDE = DIVISION_NAMES.length

export type SideId = 0 | 1
export type Speed = 1 | 2 | 4
export type DivisionSlot = 0 | 1 | 2 | 3 | 4

export const DEFAULT_SHIP_COUNT: ShipCount = 1000
export const DEFAULT_FORMATION: FormationId = 'kakuyoku'

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
  centerX: number
  centerY: number
  facingX: number
  facingY: number
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
  alive: number
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
  divisions: readonly Division[]
}

export interface Tactic {
  id: TacticId
  name: string
  summary: string
  focus: boolean
  step(div: Division, ctx: TacticContext, dt: number): void
}

export type Command =
  | { type: 'set-ship-count'; count: ShipCount }
  | { type: 'set-formation'; side: SideId; formationId: FormationId }
  | { type: 'set-tactic'; division: number; tacticId: TacticId }
  | { type: 'set-side-tactic'; side: SideId; tacticId: TacticId }
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
  hp?: number
  damage?: readonly [number, number]
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
  beams: Beams
  booms: Booms
}
