/** Numbers that belong to a ship. A later ship-type table is one of these per type. */
export interface ShipStats {
  hp: number
  damage: number
  range: number
  acquire: number
  cooldown: number
  hitChance: number
  maxSpeed: number
  response: number
  turnRate: number
  reverse: number
  arc: number
  armorFront: number
  armorSide: number
  armorRear: number
  armorBow: number
  armorStern: number
  /** Bow, then port, then starboard. Rear has no battery. */
  batteries: readonly BatterySpec[]
}

export interface BatterySpec {
  id: 'bow' | 'port' | 'starboard'
  guns: number
  /** Damage per gun before armor and hit chance. A volley is guns × power. */
  power: number
  /** Arc center relative to the bow, radians. Port is positive. */
  center: number
  /** Half-width of the arc. */
  half: number
  minRange: number
  maxRange: number
  cooldown: number
}

const DEG = Math.PI / 180

/**
 * One battery fires about every 4s. The gap is the base plus a seeded ±10% so volleys
 * do not land on the same tick. 3.6s to 4.4s.
 */
export const FIRE = {
  cooldown: 4,
  jitter: 0.1,
} as const

/** Next gap for one battery. Hashed from the seed so it does not consume the hit rolls. */
export function volleyGap(seed: number, ship: number, battery: number, base: number = FIRE.cooldown): number {
  let x = (seed ^ Math.imul(ship + 1, 0x9e3779b1) ^ Math.imul(battery + 1, 0x85ebca6b)) | 0
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  const unit = (x >>> 0) / 4294967296
  return base * (1 + (unit * 2 - 1) * FIRE.jitter)
}

/**
 * Where a battery that has been waiting sits inside the next window.
 * Spreads a fleet that would otherwise fire on the first frame a target appears.
 */
export function volleyPhase(seed: number, ship: number, battery: number, base: number = FIRE.cooldown): number {
  let x = (seed ^ Math.imul(ship + 1, 0x6c078965) ^ Math.imul(battery + 3, 0x27d4eb2d)) | 0
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  const unit = (x >>> 0) / 4294967296
  const gap = volleyGap(seed, ship, battery, base)
  return gap * (0.08 + 0.84 * unit)
}

/**
 * 40 guns. The bow reaches past the broadsides and cannot fire inside its minimum.
 * Each broadside covers its own side from 40° to 140° off the bow, out to a shorter range.
 * Per-gun power is above the 2s-cooldown values (bow 0.9, broadside 0.32) so a 4s
 * interval does not stretch a battle past about 1.5× its old length.
 */
export const BATTERIES = [
  { id: 'bow', guns: 8, power: 1.4, center: 0, half: 40 * DEG, minRange: 280, maxRange: 900, cooldown: FIRE.cooldown },
  { id: 'port', guns: 16, power: 0.5, center: 90 * DEG, half: 50 * DEG, minRange: 0, maxRange: 420, cooldown: FIRE.cooldown },
  { id: 'starboard', guns: 16, power: 0.5, center: -90 * DEG, half: 50 * DEG, minRange: 0, maxRange: 420, cooldown: FIRE.cooldown },
] as const satisfies readonly BatterySpec[]

export const SHIP_STATS = {
  hp: 54,
  damage: 7,
  range: 900,
  acquire: 980,
  cooldown: FIRE.cooldown,
  hitChance: 0.86,
  maxSpeed: 70,
  response: 5.2,
  turnRate: 1.5,
  reverse: 0.22,
  arc: (40 * Math.PI) / 180,
  armorFront: 0.5,
  armorSide: 1,
  armorRear: 1.5,
  armorBow: (50 * Math.PI) / 180,
  armorStern: (50 * Math.PI) / 180,
  batteries: BATTERIES,
} satisfies ShipStats

export const SHIP_CLASS_IDS = ['battleship', 'cruiser', 'destroyer'] as const
export type ShipClassId = (typeof SHIP_CLASS_IDS)[number]

/**
 * Multipliers on the battleship. Gun counts are rounded, ranges are rounded,
 * and a battery never drops below one gun. `wing` pushes a division off the fleet axis.
 */
export interface ClassMods {
  id: ShipClassId
  name: string
  summary: string
  hp: number
  armor: number
  speed: number
  accel: number
  turn: number
  wing: number
  bowGuns: number
  bowPower: number
  bowRange: number
  bowArc: number
  sideGuns: number
  sidePower: number
  sideRange: number
  sideArc: number
  girth: number
  length: number
}

export const CLASS_MODS = {
  battleship: {
    id: 'battleship',
    name: '戦艦',
    summary: '耐久と艦首砲の射程で戦線を支える。',
    hp: 1,
    armor: 1,
    speed: 1,
    accel: 1,
    turn: 1,
    wing: 0.82,
    bowGuns: 1,
    bowPower: 1,
    bowRange: 1,
    bowArc: 1,
    sideGuns: 1,
    sidePower: 1,
    sideRange: 1,
    sideArc: 1,
    girth: 1.45,
    length: 1.15,
  },
  cruiser: {
    id: 'cruiser',
    name: '巡航艦',
    summary: '戦艦より軽く、速く、よく曲がる。射程と威力は一回り小さい。',
    hp: 0.64,
    armor: 1.2,
    speed: 1.28,
    accel: 1.4,
    turn: 1.6,
    wing: 1.08,
    bowGuns: 0.75,
    bowPower: 0.85,
    bowRange: 0.86,
    bowArc: 1,
    sideGuns: 0.75,
    sidePower: 0.85,
    sideRange: 0.9,
    sideArc: 1,
    girth: 0.62,
    length: 1.7,
  },
  destroyer: {
    id: 'destroyer',
    name: '駆逐艦',
    summary: '脆い代わりに速く、舷側砲を近づけて撃つ。',
    hp: 0.34,
    armor: 1.45,
    speed: 1.58,
    accel: 1.8,
    turn: 2.2,
    wing: 1.38,
    bowGuns: 0.5,
    bowPower: 0.55,
    bowRange: 0.52,
    bowArc: 0.8,
    sideGuns: 0.75,
    sidePower: 1.1,
    sideRange: 0.82,
    sideArc: 1.16,
    girth: 0.32,
    length: 2.35,
  },
} as const satisfies Record<ShipClassId, ClassMods>

/** Wings, then the guards, battleships in the center. Both fleets use this unless told otherwise. */
export const DEFAULT_LINE: readonly ShipClassId[] = ['destroyer', 'cruiser', 'battleship', 'cruiser', 'destroyer']

function scaleBattery(base: BatterySpec, mods: ClassMods, bow: boolean): BatterySpec {
  const guns = Math.max(1, Math.round(base.guns * (bow ? mods.bowGuns : mods.sideGuns)))
  const power = base.power * (bow ? mods.bowPower : mods.sidePower)
  const range = bow ? mods.bowRange : mods.sideRange
  const arc = bow ? mods.bowArc : mods.sideArc
  return {
    id: base.id,
    guns,
    power,
    center: base.center,
    half: base.half * arc,
    minRange: bow ? Math.round(base.minRange * mods.bowRange) : 0,
    maxRange: Math.round(base.maxRange * range),
    cooldown: base.cooldown,
  }
}

function deriveClass(id: ShipClassId): ShipStats {
  const mods = CLASS_MODS[id]
  const bow = BATTERIES[0]
  const port = BATTERIES[1]
  const starboard = BATTERIES[2]
  if (!bow || !port || !starboard) return SHIP_STATS
  return {
    hp: Math.max(1, Math.round(SHIP_STATS.hp * mods.hp)),
    damage: SHIP_STATS.damage,
    range: Math.round(bow.maxRange * mods.bowRange),
    acquire: Math.round(SHIP_STATS.acquire * mods.bowRange),
    cooldown: SHIP_STATS.cooldown,
    hitChance: SHIP_STATS.hitChance,
    maxSpeed: SHIP_STATS.maxSpeed * mods.speed,
    response: SHIP_STATS.response * mods.accel,
    turnRate: SHIP_STATS.turnRate * mods.turn,
    reverse: SHIP_STATS.reverse,
    arc: SHIP_STATS.arc * mods.bowArc,
    armorFront: SHIP_STATS.armorFront * mods.armor,
    armorSide: SHIP_STATS.armorSide * mods.armor,
    armorRear: SHIP_STATS.armorRear * mods.armor,
    armorBow: SHIP_STATS.armorBow,
    armorStern: SHIP_STATS.armorStern,
    batteries: [scaleBattery(bow, mods, true), scaleBattery(port, mods, false), scaleBattery(starboard, mods, false)],
  }
}

export const CLASS_STATS: readonly ShipStats[] = SHIP_CLASS_IDS.map((id) => deriveClass(id))

export function classIndex(id: ShipClassId): number {
  const index = SHIP_CLASS_IDS.indexOf(id)
  return index < 0 ? 0 : index
}

export function classMods(index: number): ClassMods {
  const id = SHIP_CLASS_IDS[index] ?? 'battleship'
  return CLASS_MODS[id]
}

/** Five classes are copied onto both fleets. Ten classes assign each division. */
export function fleetLine(classes: readonly ShipClassId[] | undefined): ShipClassId[] {
  const row = DEFAULT_LINE.map((id, index) => classes?.[index] ?? id)
  if (classes && classes.length >= 10) return classes.slice(0, 10)
  return [...row, ...row]
}

/** Hull points when a scenario scales every battleship, and the other classes follow. */
export function hullHp(index: number, battleshipHp: number): number {
  const base = CLASS_STATS[index]?.hp ?? SHIP_STATS.hp
  if (battleshipHp === SHIP_STATS.hp) return base
  return Math.max(1, Math.round((base * battleshipHp) / SHIP_STATS.hp))
}

/** Division anchors take part of the class speed so a wing leads without leaving the fleet. */
export function anchorPace(id: ShipClassId): number {
  return 1 + (CLASS_MODS[id].speed - 1) * 0.45
}

/**
 * Sim seconds advanced per wall-clock second at ×1.
 * ×2 and ×4 still speed the battle up. Fire cooldown stays in sim seconds.
 */
export const SIM_TIME_SCALE = 0.5

/**
 * Close-range wheel. The map's +Y is up, so `turn: -1` is clockwise from above.
 * A fleet inside `engage` keeps forward speed and slides clockwise around the enemy.
 * Inside `pass` the bow swings ahead of the enemy so the fleet does not stop on top of it.
 * 定点射撃 opts out via `Tactic.sweep`.
 */
export const SWEEP = {
  turn: -1,
  engage: 900,
  pass: 420,
  resume: 520,
  off: (28 * Math.PI) / 180,
  passOff: (125 * Math.PI) / 180,
  speed: 50,
  lead: 240,
} as const

export const FIELD = {
  fleetCenter: 580,
  beamLife: 0.16,
  beamLifeSide: 0.08,
  beamAlpha: 0.38,
  beamAlphaSide: 0.2,
  boomLife: 0.4,
  maxBeams: 1600,
  maxBooms: 360,
  stagger: 3,
  sampleStep: 28,
  commandInterval: 6,
  logLimit: 6,
} as const

export function rangeSq(stats: ShipStats): number {
  return stats.range * stats.range
}

export function acquireSq(stats: ShipStats): number {
  return stats.acquire * stats.acquire
}

/**
 * Fire-control weights. Expected damage prefers exposed armor and a hull one
 * shot can finish. `near` is subtracted per unit of range, so a closer ship
 * screens one that has fallen back. `falloff` stays 0 while hit chance does
 * not decay with range.
 */
export const GUNNERY = {
  finish: 1.45,
  lowHp: 0.4,
  focus: 0.007,
  near: 0.016,
  falloff: 0,
  falloffFloor: 0.55,
  reserve: 1,
  cell: 180,
  /** Keep the current target unless a new one scores this much higher. */
  stick: 1.35,
} as const

/** How often a division reorders wounded ships behind healthy ones. */
export const RANKS = {
  interval: 0.25,
  /** Shaped fleets keep the same ranks long enough that ships can arrive. */
  shapedInterval: 2.5,
} as const

/** Distances for a fleet maneuver. The clockwise wheel is one option, not the default. */
export const MANEUVER = {
  station: 420,
  lane: 130,
  reform: 560,
  breakOut: 880,
  contact: 900,
  stick: 1.15,
} as const
