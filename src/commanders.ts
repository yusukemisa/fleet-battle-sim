import type { CommanderId, DivisionSlot, FormationId, TacticId } from './types.ts'

export interface DivisionFact {
  alive: number
  tacticId: TacticId
  phase: number
  ax: number
  ay: number
}

export type Bearing = 'front' | 'side' | 'rear'

export interface BattleFacts {
  ownAlive: number
  enemyAlive: number
  ownLost: number
  enemyLost: number
  enemyFormation: FormationId
  ownX: number
  ownY: number
  slot: DivisionSlot
  enemy: readonly DivisionFact[]
  enemyOnUs: Bearing
  usOnEnemy: Bearing
}

interface TacticWeights {
  charge: number
  hold: number
  flank: number
  encircle: number
  breakthrough: number
  feint: number
  focus: number
}

interface WeightRule {
  id: string
  test(facts: BattleFacts, read: Read): boolean
  add: Partial<TacticWeights>
}

export interface Commander {
  id: CommanderId
  name: string
  summary: string
  auto: boolean
  base: TacticWeights
  prefer: readonly TacticId[]
  rules: readonly WeightRule[]
}

interface Read {
  wing: boolean
  center: boolean
  strength: number
  enemyLoss: number
  enemyFlanking: boolean
}

const EMPTY: TacticWeights = {
  charge: 0,
  hold: 0,
  flank: 0,
  encircle: 0,
  breakthrough: 0,
  feint: 0,
  focus: 0,
}

export const COMMANDERS = {
  manual: {
    id: 'manual',
    name: '手動',
    summary: '戦術は自分で指定する。',
    auto: false,
    base: EMPTY,
    prefer: ['charge'],
    rules: [],
  },
  fierce: {
    id: 'fierce',
    name: '猛将',
    summary: '正面と突破を好み、有利ならさらに押す。',
    auto: true,
    base: { ...EMPTY, charge: 5, breakthrough: 4, flank: 1 },
    prefer: ['breakthrough', 'charge', 'flank', 'focus', 'encircle', 'feint', 'hold'],
    rules: [
      { id: 'center', test: (_facts, read) => read.center, add: { breakthrough: 3 } },
      { id: 'wing', test: (_facts, read) => read.wing, add: { charge: 2 } },
      { id: 'advantage', test: (_facts, read) => read.strength >= 1.2, add: { breakthrough: 4 } },
      {
        id: 'exposed-enemy',
        test: (facts) => facts.usOnEnemy === 'side' || facts.usOnEnemy === 'rear',
        add: { breakthrough: 3 },
      },
    ],
  },
  cunning: {
    id: 'cunning',
    name: '智将',
    summary: '偽装、迂回、包囲で隙を突く。',
    auto: true,
    base: { ...EMPTY, feint: 3, flank: 2, encircle: 2 },
    prefer: ['encircle', 'feint', 'flank', 'breakthrough', 'focus', 'hold', 'charge'],
    rules: [
      { id: 'flanked', test: (_facts, read) => read.enemyFlanking, add: { encircle: 4 } },
      {
        id: 'arrow',
        test: (facts, read) => facts.enemyFormation === 'hoshi' && !read.enemyFlanking,
        add: { flank: 4 },
      },
      {
        id: 'wing',
        test: (facts, read) => read.wing && !read.enemyFlanking && facts.enemyFormation !== 'hoshi',
        add: { flank: 3 },
      },
      { id: 'opening', test: (_facts, read) => read.enemyLoss >= 0.35, add: { encircle: 3 } },
      {
        id: 'their-armor',
        test: (facts) => facts.usOnEnemy === 'side' || facts.usOnEnemy === 'rear',
        add: { encircle: 3, flank: 2 },
      },
    ],
  },
  guard: {
    id: 'guard',
    name: '守将',
    summary: 'その場を守り、敵が削れたら反撃する。',
    auto: true,
    base: { ...EMPTY, hold: 5, focus: 4 },
    prefer: ['charge', 'focus', 'hold', 'breakthrough', 'flank', 'encircle', 'feint'],
    rules: [
      { id: 'flanked', test: (_facts, read) => read.enemyFlanking, add: { focus: 3 } },
      {
        id: 'protect',
        test: (facts) => facts.enemyOnUs === 'side' || facts.enemyOnUs === 'rear',
        add: { focus: 4, hold: 1 },
      },
      {
        id: 'counter',
        test: (_facts, read) => read.enemyLoss >= 0.35 && read.strength >= 1,
        add: { charge: 8 },
      },
    ],
  },
  balanced: {
    id: 'balanced',
    name: '常勝',
    summary: '戦力と敵の動きを見て陣を変える。',
    auto: true,
    base: { ...EMPTY, charge: 3, hold: 1, flank: 1, focus: 1, breakthrough: 1 },
    prefer: ['breakthrough', 'encircle', 'hold', 'charge', 'focus', 'flank', 'feint'],
    rules: [
      { id: 'ahead', test: (_facts, read) => read.strength >= 1.25, add: { breakthrough: 4 } },
      { id: 'behind', test: (_facts, read) => read.strength <= 0.8, add: { hold: 5 } },
      {
        id: 'flanked',
        test: (_facts, read) => read.enemyFlanking && read.strength > 0.8 && read.strength < 1.25,
        add: { encircle: 4 },
      },
      {
        id: 'their-armor',
        test: (facts, read) => (facts.usOnEnemy === 'side' || facts.usOnEnemy === 'rear') && read.strength > 0.8,
        add: { encircle: 4, flank: 2 },
      },
      {
        id: 'protect',
        test: (facts) => facts.enemyOnUs === 'side' || facts.enemyOnUs === 'rear',
        add: { focus: 3, hold: 2 },
      },
    ],
  },
} satisfies Record<CommanderId, Commander>

export function chooseTactic(commander: Commander, facts: BattleFacts): TacticId | null {
  if (!commander.auto) return null
  const read = readFacts(facts)
  const weights = { ...commander.base }
  for (const rule of commander.rules) {
    if (!rule.test(facts, read)) continue
    for (const id of commander.prefer) {
      const extra = rule.add[id]
      if (extra) weights[id] += extra
    }
  }
  let pick: TacticId = commander.prefer[0] ?? 'charge'
  let best = -Infinity
  for (const id of commander.prefer) {
    if (weights[id] > best) {
      best = weights[id]
      pick = id
    }
  }
  return pick
}

function readFacts(facts: BattleFacts): Read {
  const strength = facts.ownAlive / Math.max(1, facts.enemyAlive)
  const enemyShips = facts.enemyAlive + facts.enemyLost
  return {
    wing: facts.slot === 0 || facts.slot === 4,
    center: facts.slot === 2,
    strength,
    enemyLoss: facts.enemyLost / Math.max(1, enemyShips),
    enemyFlanking: facts.enemy.some((division) => flanking(division, facts.ownY)),
  }
}

function flanking(division: DivisionFact, ownY: number): boolean {
  if (division.alive === 0) return false
  const ordered =
    division.tacticId === 'flank' ||
    division.tacticId === 'encircle' ||
    (division.tacticId === 'feint' && division.phase > 0)
  return ordered && Math.abs(division.ay - ownY) > 110
}
