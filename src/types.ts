import type { ShipClassId, ShipStats } from './balance.ts'
import type { CombatScratch } from './spatial.ts'

export const SHIP_COUNTS = [100, 1000, 10000, 20000] as const
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

/** `rule` is the code commander. `ai` asks a model and keeps the last valid orders. */
export type BrainMode = 'rule' | 'ai' | 'dt'

export interface BrainMove {
  x: number
  y: number
  heading: number
}

/** High-level order. Tactics and move points are the same vocabulary as the rule commanders and manual orders. */
export interface BrainOrder {
  division: number
  tacticId: TacticId
  /** Enemy division index to prefer. */
  target?: number
  move?: BrainMove
}

export interface AiFleetState {
  status: 'idle' | 'thinking' | 'ready' | 'fallback'
  latencyMs: number
  fallbacks: number
  note: string
  /** Sim time when the current orders were accepted. */
  decidedAt: number
}

export function idleAi(): AiFleetState {
  return { status: 'idle', latencyMs: 0, fallbacks: 0, note: '', decidedAt: -999 }
}

export const DIVISION_NAMES = ['左翼', '左衛', '中軍', '右衛', '右翼'] as const
export const DIVISIONS_PER_SIDE = DIVISION_NAMES.length

export type SideId = 0 | 1
export type Speed = 1 | 2 | 4
export type DivisionSlot = 0 | 1 | 2 | 3 | 4

export const DEFAULT_SHIP_COUNT: ShipCount = 1000
export const DEFAULT_FORMATION: FormationId = 'oujin'

export type GunneryMode = 'legacy' | 'aimed'

export type ManeuverMode = 'legacy' | 'shaped'

export const MANEUVER_IDS = ['press', 'seize', 'envelop', 'wheel', 'breakout', 'refuse', 'reform'] as const
export type ManeuverId = (typeof MANEUVER_IDS)[number]

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
  /** Port and starboard cooldowns, packed as ship * 2 + side. The bow stays in `cooldown`. */
  gunCd: Float32Array
  slotX: Float32Array
  slotY: Float32Array
  homeX: Float32Array
  homeY: Float32Array
  /** 1 when this ship has dropped behind its division. */
  falling: Uint8Array
  /** 1 while the ship is still sailing to its station. */
  approach: Uint8Array
  heading: Float32Array
  /** Current yaw rate, radians per second. */
  yaw: Float32Array
  alive: Uint8Array
  side: Uint8Array
  /** Index into {@link CLASS_STATS}. Every ship in a division shares one. */
  shipClass: Uint8Array
  division: Uint8Array
  command: Uint8Array
  target: Int32Array
}

export interface FleetSetup {
  side: SideId
  ships: number
  formationId?: FormationId
  commanderId?: CommanderId
  brain?: BrainMode
  classes?: readonly ShipClassId[]
}

export interface Fleet {
  /** Stable index. 0 and 1 are the original fleets of each side. */
  index: number
  /** 0, 1, or 2 within the side. */
  ordinal: number
  side: SideId
  name: string
  ships: number
  /** Count asked for in setup. `ships` is what actually deploys after the cap. */
  requested: number
  formationId: FormationId
  commanderId: CommanderId
  /** `rule` runs the existing commander. `ai` holds model orders between decisions. */
  brain: BrainMode
  ai: AiFleetState
  /** Last accepted model orders. Null while the rule commander is driving. */
  orders: BrainOrder[] | null
  centerX: number
  centerY: number
  /** Living centroid, refreshed every step. */
  meanX: number
  meanY: number
  /** Enemy fleet this fleet is steering toward. */
  enemyFleet: number
  /** Latched when the fleet starts as a ring around its battleships. */
  cover: boolean
  /**
   * Formation-scoped answer to an enemy rush. Other formations stay `none`.
   * `ring` flattens 方円 onto the threat axis. `crane` pulls 鶴翼 wings back.
   * `spear` meets 魚鱗 inside bow range. `offset` slides off the 鋒矢 axis.
   * `tip` holds 魚鱗 destroyers behind the battleship against a 横陣 rush.
   * `crescent` does the same for 偃月 against 鶴翼.
   * `steady` is 方円 against a 守将 line, which does not rush.
   */
  plan: 'none' | 'ring' | 'crane' | 'spear' | 'offset' | 'tip' | 'steady' | 'crescent'
  /** Do not switch plans before this time. */
  planUntil: number
  facingX: number
  facingY: number
  /** 0 while closing in, 1 while sliding past. Shared by the sweeping divisions. */
  sweepLeg: 0 | 1
  maneuver: ManeuverId
  maneuverUntil: number
  prey: number
  /** Which side of the enemy the fleet committed to. */
  bias: number
  /** Lateral half-extent at deployment. Friendly fleets stay this far apart. */
  reach: number
}

export interface Division {
  side: SideId
  /** Index into {@link SimState.fleets}. */
  fleet: number
  slot: DivisionSlot
  name: string
  classId: ShipClassId
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
  /** Enemy division index this division has committed to. -1 picks a local target. */
  hunt: number
  /** Battleships of 常勝 hold outside the enemy's close range and shoot the hunted division. */
  standoff: boolean
  /** Light divisions of 常勝 close as soon as the bow arc is clear. */
  rush: boolean
  /** 猛将 destroyers drive straight at the battleship instead of swinging wide. */
  headOn: boolean
  /** Point this division is steering toward. */
  markX: number
  markY: number
  sweepAlong: number
  sweepOut: number
  sweepLocked: boolean
  sweeping: boolean
  /** Shaped steering owns this division: bows follow the division, not a shifting slot. */
  shaped: boolean
  /** Manual move order. The block sails to the point, then yaws onto `orderH`. */
  ordered: boolean
  orderX: number
  orderY: number
  orderH: number
  /** Weight of enemy batteries that currently bear on this division. 0 is clear. */
  guard: number
  guardX: number
  guardY: number
  /** Presenting the broadside beats keeping the bow on the threat. */
  broadsideOk: boolean
  /** Breakout or reform: turning away is the point. */
  yielding: boolean
  /** Envelop or seize: this division may use its own speed. */
  sprint: boolean
  /** 守将 light divisions stay on a shallow flank instead of running to the rear. */
  screen: boolean
  alive: number
  roster: number
  /** Share of sampled ships in this division with a neighbor inside the near-miss range. */
  pack: number
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
  | { type: 'set-fleet-count'; side: SideId; count: 1 | 2 | 3 }
  | { type: 'set-fleet-ships'; fleet: number; ships: number }
  | { type: 'set-fleet-formation'; fleet: number; formationId: FormationId }
  | { type: 'set-fleet-commander'; fleet: number; commanderId: CommanderId }
  | { type: 'set-fleet-brain'; fleet: number; brain: BrainMode }
  | { type: 'brain-thinking'; fleet: number }
  | { type: 'brain-decision'; fleet: number; orders: BrainOrder[]; note: string; latencyMs: number }
  | { type: 'brain-fallback'; fleet: number; latencyMs: number }
  | { type: 'set-formation'; side: SideId; formationId: FormationId }
  | { type: 'set-tactic'; division: number; tacticId: TacticId }
  | { type: 'set-side-tactic'; side: SideId; tacticId: TacticId }
  | { type: 'set-fleet-tactic'; fleet: number; tacticId: TacticId }
  | { type: 'set-commander'; side: SideId; commanderId: CommanderId }
  | { type: 'set-class'; division: number; classId: ShipClassId }
  | { type: 'order-move'; divisions: readonly number[]; x: number; y: number; heading: number }
  | { type: 'order-clear'; divisions: readonly number[] }
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'set-speed'; speed: Speed }
  | { type: 'reset' }
  | { type: 'tick'; dt: number }

export interface SimConfig {
  shipCount: ShipCount
  /** When set, each entry is one fleet. The two sides may differ in length, up to 3 each. */
  groups?: readonly FleetSetup[]
  formations?: readonly [FormationId, FormationId]
  tactics?: readonly TacticId[]
  commanders?: readonly [CommanderId, CommanderId]
  /** Omit to use the commander default: 猛将 and 守将 start on AI, the others on rules. */
  brains?: readonly [BrainMode, BrainMode]
  /** Five entries apply to both fleets. Ten entries assign every division. */
  classes?: readonly ShipClassId[]
  hp?: number
  damage?: readonly [number, number]
  gunnery?: GunneryMode
  /** Per side. False keeps every ship on the station it was given. */
  withdraw?: readonly [boolean, boolean]
  /** `shaped` reads both formations and commits to one fleet maneuver. */
  maneuver?: ManeuverMode
}

export interface Beams {
  life: Float32Array
  x1: Float32Array
  y1: Float32Array
  x2: Float32Array
  y2: Float32Array
  side: Uint8Array
  /** 0 is the bow battery. 1 is either broadside. */
  kind: Uint8Array
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
  shipCount: number
  /** Null keeps the original one-fleet-per-side battle. */
  groups: FleetSetup[] | null
  phase: BattlePhase
  ships: Ships
  fleets: Fleet[]
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
  /** Hit-point damage landed by each side. */
  dealt: [number, number]
  /** Hit points removed by hulls colliding, friend or foe. */
  ram: number
  /** Ships destroyed by a hull collision, per side. */
  collisionDeaths: [number, number]
  /** Of that damage, the share landed by destroyers. */
  destroyerDealt: [number, number]
  commandAt: number
  log: string[]
  hits: ArmorHits
  beams: Beams
  booms: Booms
  gunnery: GunneryMode
  maneuver: ManeuverMode
  withdrawSides: readonly [boolean, boolean]
  tally: GunneryTally
  scratch: CombatScratch
  /** Damage dealt by battleship, cruiser, destroyer. */
  classDamage: [number, number, number]
  /** Damage by shooter class onto victim class, row-major. 0 battleship, 1 cruiser, 2 destroyer. */
  classOnClass: number[]
  rankAt: number
  fallingN: number
  /**
   * Set while setup counts were scaled to {@link MAX_SHIPS}.
   * Null when the requested fleets already fit.
   */
  fitNotice: string | null
}
