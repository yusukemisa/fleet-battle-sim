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
}

export const SHIP_STATS = {
  hp: 54,
  damage: 7,
  range: 760,
  acquire: 820,
  cooldown: 0.65,
  hitChance: 0.86,
  maxSpeed: 70,
  response: 5.2,
} satisfies ShipStats

export const FIELD = {
  fleetCenter: 580,
  beamLife: 0.22,
  boomLife: 0.4,
  maxBeams: 720,
  maxBooms: 360,
  stagger: 3,
  sampleStep: 28,
} as const

export function rangeSq(stats: ShipStats): number {
  return stats.range * stats.range
}

export function acquireSq(stats: ShipStats): number {
  return stats.acquire * stats.acquire
}
