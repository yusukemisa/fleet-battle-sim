import type { CommanderId, DivisionSlot, FormationId, ManeuverId, TacticId } from './types.ts'

export interface DivisionFact {
  alive: number
  tacticId: TacticId
  phase: number
  ax: number
  ay: number
  fx: number
  fy: number
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
  ax: number
  ay: number
  fx: number
  fy: number
  slot: DivisionSlot
  enemy: readonly DivisionFact[]
  enemyOnUs: Bearing
  usOnEnemy: Bearing
}

type TacticWeights = Record<TacticId, number>

interface WeightRule {
  id: string
  test(facts: BattleFacts, read: Read): boolean
  add: Partial<TacticWeights>
}

/**
 * Damaged ships drop behind the division and shoot only on a good angle.
 * `hp` is the fraction of max HP where that starts. `reengage` is the share of
 * the living division that stays in the forward ranks anyway.
 * `shot` is the lowest armor multiplier a withdrawing ship will fire into.
 * `threat` is how many enemy guns may bear before it holds fire and keeps the bow on them.
 */
export interface Withdrawal {
  hp: number
  reengage: number
  depth: number
  shot: number
  threat: number
}

export type PostureWeights = Record<ManeuverId, number> & { commit: number }

export interface Commander {
  id: CommanderId
  name: string
  summary: string
  auto: boolean
  base: TacticWeights
  prefer: readonly TacticId[]
  rules: readonly WeightRule[]
  withdraw: Withdrawal
  posture: PostureWeights
}

interface Read {
  wing: boolean
  center: boolean
  strength: number
  enemyLoss: number
  enemyFlanking: boolean
}

const EMPTY = {
  charge: 0,
  hold: 0,
  flank: 0,
  broadside: 0,
  rear: 0,
  pin: 0,
  encircle: 0,
  breakthrough: 0,
  feint: 0,
  focus: 0,
} satisfies TacticWeights

export const COMMANDERS = {
  manual: {
    id: 'manual',
    name: '手動',
    summary: '戦術は自分で指定する。隊をクリックし、地図をドラッグして移動を命じる。',
    auto: false,
    base: EMPTY,
    prefer: ['charge'],
    rules: [],
    withdraw: { hp: 0, reengage: 1, depth: 0, shot: 0.5, threat: 99 },
    posture: { press: 1, seize: 0, envelop: 0, wheel: 1, breakout: 0, refuse: 0, reform: 0, commit: 30 },
  },
  fierce: {
    id: 'fierce',
    name: '猛将',
    summary: '戦艦で正面を突き、巡航艦と駆逐艦は側面と背面へ回す。深手だけ少し下がる。',
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
    withdraw: { hp: 0.22, reengage: 0.88, depth: 60, shot: 0.5, threat: 16 },
    posture: { press: 6, seize: 3, envelop: 2, wheel: 1, breakout: 2, refuse: 0, reform: 0, commit: 6 },
  },
  cunning: {
    id: 'cunning',
    name: '智将',
    summary: '戦艦で正面を釘付けにし、速い隊は艦首射程の外から挟む。傷ついた艦は後ろで機会を待つ。',
    auto: true,
    base: { ...EMPTY, pin: 1, broadside: 1, rear: 1 },
    prefer: ['rear', 'broadside', 'pin', 'focus', 'hold', 'flank', 'charge', 'encircle', 'breakthrough', 'feint'],
    rules: [
      { id: 'pin-center', test: (_facts, read) => read.center, add: { pin: 9 } },
      { id: 'inner-wing', test: (facts) => facts.slot === 1 || facts.slot === 3, add: { broadside: 8 } },
      { id: 'outer-wing', test: (_facts, read) => read.wing, add: { rear: 8 } },
      {
        id: 'exposed-rear',
        test: (facts, read) => !read.center && opening(facts) === 'rear',
        add: { rear: 10 },
      },
      {
        id: 'exposed-side',
        test: (facts) => (facts.slot === 1 || facts.slot === 3) && opening(facts) === 'side',
        add: { broadside: 4 },
      },
    ],
    withdraw: { hp: 0.4, reengage: 0.86, depth: 60, shot: 0.5, threat: 12 },
    posture: { press: 1, seize: 5, envelop: 5, wheel: 1, breakout: 5, refuse: 2, reform: 2, commit: 8 },
  },
  guard: {
    id: 'guard',
    name: '守将',
    summary: '戦艦で陣を守り、軽い隊は側近として敵の回り込みを叩く。傷ついた艦は列の後ろへ下がる。',
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
    withdraw: { hp: 0.58, reengage: 0.7, depth: 90, shot: 0.5, threat: 8 },
    posture: { press: 0, seize: 1, envelop: 0, wheel: 0, breakout: 4, refuse: 5, reform: 6, commit: 9 },
  },
  balanced: {
    id: 'balanced',
    name: '常勝',
    summary: '戦艦で戦列を保ち、側面が空けば速い隊をそこへ送る。傷ついた艦は前の列に隠れる。',
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
    withdraw: { hp: 0.52, reengage: 0.78, depth: 70, shot: 0.5, threat: 8 },
    posture: { press: 2, seize: 4, envelop: 3, wheel: 2, breakout: 4, refuse: 3, reform: 3, commit: 7 },
  },
} satisfies Record<CommanderId, Commander>

const LINE_TACTICS = new Set<TacticId>(['charge', 'hold', 'pin', 'breakthrough', 'focus'])

/** Battleships hold the line. Lighter classes leave it, each commander in its own way. */
export function employClass(commander: Commander, classId: 'battleship' | 'cruiser' | 'destroyer', chosen: TacticId, facts: BattleFacts): TacticId {
  if (!commander.auto) return chosen
  const light = classId !== 'battleship'
  if (!light) {
    if (LINE_TACTICS.has(chosen)) return chosen
    if (commander.id === 'fierce') return 'breakthrough'
    if (commander.id === 'guard') return 'hold'
    if (commander.id === 'cunning') return 'pin'
    return 'charge'
  }
  if (commander.id === 'fierce') return classId === 'destroyer' ? 'rear' : 'broadside'
  if (commander.id === 'cunning') return classId === 'destroyer' ? 'rear' : 'broadside'
  if (commander.id === 'guard') {
    if (facts.enemyOnUs === 'side' || facts.enemyOnUs === 'rear') return 'broadside'
    return 'flank'
  }
  if (facts.usOnEnemy === 'rear') return 'rear'
  if (facts.usOnEnemy === 'side' || facts.enemyOnUs === 'side' || facts.enemyOnUs === 'rear') {
    return classId === 'destroyer' ? 'rear' : 'broadside'
  }
  return 'flank'
}

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

function opening(facts: BattleFacts): Bearing | null {
  let best: Bearing | null = null
  let bestScore = 0
  for (const enemy of facts.enemy) {
    if (enemy.alive === 0) continue
    const dx = facts.ax - enemy.ax
    const dy = facts.ay - enemy.ay
    const len = Math.hypot(dx, dy) || 1
    const dot = (dx / len) * enemy.fx + (dy / len) * enemy.fy
    let bearing: Bearing = 'front'
    if (dot <= -0.3) bearing = 'rear'
    else if (dot < 0.45) bearing = 'side'
    if (bearing === 'front') continue
    const score = (bearing === 'rear' ? 2 : 1) + 140 / len
    if (score > bestScore) {
      bestScore = score
      best = bearing
    }
  }
  return best
}

function flanking(division: DivisionFact, ownY: number): boolean {
  if (division.alive === 0) return false
  const ordered =
    division.tacticId === 'flank' ||
    division.tacticId === 'encircle' ||
    division.tacticId === 'broadside' ||
    division.tacticId === 'rear' ||
    (division.tacticId === 'feint' && division.phase > 0)
  return ordered && Math.abs(division.ay - ownY) > 110
}
