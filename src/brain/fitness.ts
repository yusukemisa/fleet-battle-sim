/**
 * How each personality is scored. Every shaped term is 0..1.
 * Winning is always present. The other terms are what makes two winning
 * lines look like different commanders.
 *
 * 常勝 does not average its games. `cvar` blends the mean with the mean of
 * the worst quartile, so a weak formation or opponent still moves the weights.
 */
export const REWARD = {
  fierce: {
    win: 1,
    earlyContact: 0.35,
    damageShare: 0.3,
    assault: 0.25,
  },
  cunning: {
    win: 0.85,
    exchange: 0.45,
    flank: 0.3,
    destroyer: 0.25,
  },
  guard: {
    win: 0.65,
    survive: 0.45,
    cover: 0.35,
    cohesion: 0.25,
  },
  balanced: {
    win: 1,
    alive: 0.15,
    cvar: 0.6,
  },
} as const

/** Added to a fresh policy's output bias, once, before the first generation. */
export const INITIAL_BIAS = {
  fierce: { charge: 0.45, breakthrough: 0.35 },
  cunning: { flank: 0.4, rear: 0.4 },
  guard: { hold: 0.4, pin: 0.3 },
  balanced: {},
} as const

export const PERSONALITIES = ['fierce', 'cunning', 'guard', 'balanced'] as const
export type Personality = (typeof PERSONALITIES)[number]

export interface BattleReport {
  won: boolean
  /** Ships still alive, over the fleet's starting roster. */
  alive: number
  /** Sim seconds until the fleets are in range. The timeout if they never meet. */
  contactTime: number
  /** 1 at the opening, 0 at 45s or if contact never happens. */
  contact: number
  dealt: number
  taken: number
  /** dealt / taken. A fleet that is never hit and deals damage is treated as 2. */
  exchange: number
  /** Side and rear hits landed, over every hit landed. */
  flank: number
  /** Side and rear hits received, over every hit received. 0 if nothing hit. */
  exposure: number
  hitsDealt: number
  hitsTaken: number
  destroyerDealt: number
  /** Share of living-division samples on charge, breakthrough, or a rear rush. */
  assault: number
  /** 1 when the divisions stay near the fleet centre. */
  cohesion: number
  time: number
}

export function scoreBattle(personality: Personality, report: BattleReport): number {
  const win = report.won ? 1 : 0
  if (personality === 'fierce') {
    const share = report.dealt / Math.max(1, report.dealt + report.taken)
    const weights = REWARD.fierce
    return weights.win * win + weights.earlyContact * report.contact + weights.damageShare * share + weights.assault * report.assault
  }
  if (personality === 'cunning') {
    const ratio = report.exchange
    const exchange = ratio / (1 + ratio)
    const destroyerShare = report.destroyerDealt / Math.max(1, report.dealt)
    const weights = REWARD.cunning
    return weights.win * win + weights.exchange * exchange + weights.flank * report.flank + weights.destroyer * destroyerShare * exchange
  }
  if (personality === 'guard') {
    const cover = 1 - report.exposure
    const weights = REWARD.guard
    return weights.win * win + weights.survive * report.alive + weights.cover * cover + weights.cohesion * report.cohesion
  }
  return REWARD.balanced.win * win + REWARD.balanced.alive * report.alive
}

/** Mean for the three personalities. 常勝 mixes that mean with its worst quartile. */
export function scoreSuite(personality: Personality, games: readonly number[]): number {
  if (games.length === 0) return 0
  const mean = games.reduce((sum, value) => sum + value, 0) / games.length
  if (personality !== 'balanced') return mean
  const sorted = [...games].sort((a, b) => a - b)
  const count = Math.max(1, Math.ceil(sorted.length * 0.25))
  let worst = 0
  for (let i = 0; i < count; i++) worst += sorted[i] ?? 0
  worst /= count
  const mix = REWARD.balanced.cvar
  return (1 - mix) * mean + mix * worst
}
