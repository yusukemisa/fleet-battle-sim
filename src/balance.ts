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
}

export const SHIP_STATS = {
  hp: 54,
  damage: 7,
  range: 760,
  acquire: 820,
  cooldown: 2,
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
} satisfies ShipStats

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
  beamLife: 0.22,
  boomLife: 0.4,
  maxBeams: 720,
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
} as const

/** How often a division reorders wounded ships behind healthy ones. */
export const RANKS = {
  interval: 0.25,
} as const
