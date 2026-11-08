import type { Division, Tactic, TacticContext, TacticId } from './types.ts'

function hypot(x: number, y: number): number {
  return Math.hypot(x, y)
}

function steer(div: Division, mx: number, my: number, speed: number, dt: number): void {
  const len = hypot(mx, my)
  let tvx = 0
  let tvy = 0
  if (len > 0.8 && speed > 0) {
    tvx = (mx / len) * speed
    tvy = (my / len) * speed
  }
  const a = 1 - Math.exp(-1.7 * dt)
  div.vx += (tvx - div.vx) * a
  div.vy += (tvy - div.vy) * a
  div.ax += div.vx * dt
  div.ay += div.vy * dt
}

function face(div: Division, tx: number, ty: number, dt: number): void {
  let fx = tx - div.ax
  let fy = ty - div.ay
  const len = hypot(fx, fy)
  if (len < 1e-4) return
  fx /= len
  fy /= len
  const a = 1 - Math.exp(-1.5 * dt)
  div.fx += (fx - div.fx) * a
  div.fy += (fy - div.fy) * a
  const fl = hypot(div.fx, div.fy) || 1
  div.fx /= fl
  div.fy /= fl
  div.rx = div.fy
  div.ry = -div.fx
}

function aim(div: Division, ctx: TacticContext): void {
  let bestX = ctx.enemyX
  let bestY = ctx.enemyY
  let best = Infinity
  for (const other of ctx.divisions) {
    if (other.side === div.side || other.alive === 0) continue
    const d = hypot(other.ax - div.ax, other.ay - div.ay) - other.alive * 0.03
    if (d < best) {
      best = d
      bestX = other.ax
      bestY = other.ay
    }
  }
  div.focusX = bestX
  div.focusY = bestY
}

function charge(div: Division, ctx: TacticContext, dt: number, speed: number): void {
  steer(div, ctx.enemyX - div.ax, ctx.enemyY - div.ay, speed, dt)
  face(div, ctx.enemyX, ctx.enemyY, dt)
}

function hold(div: Division, ctx: TacticContext, dt: number): void {
  if (!div.holdArmed) {
    div.holdX = div.ax
    div.holdY = div.ay
    div.holdArmed = true
  }
  const dx = div.holdX - div.ax
  const dy = div.holdY - div.ay
  const dist = hypot(dx, dy)
  steer(div, dx, dy, dist < 3 ? 0 : Math.min(30, dist), dt)
  face(div, ctx.enemyX, ctx.enemyY, dt)
}

function flank(div: Division, ctx: TacticContext, dt: number, speed: number, offset: number): void {
  const wx = ctx.enemyX
  const wy = ctx.enemyY + div.flankSign * offset
  const dist = hypot(wx - div.ax, wy - div.ay)
  if (dist > 56) {
    steer(div, wx - div.ax, wy - div.ay, speed, dt)
    face(div, wx, wy, dt)
    return
  }
  charge(div, ctx, dt, speed * 1.05)
}

function orbit(div: Division, ctx: TacticContext, dt: number, speed: number, radius: number, rate: number): void {
  div.phaseT += dt
  const dir = div.flankSign === 0 ? 1 : div.flankSign
  const ang = div.orbitBase + div.phaseT * rate * dir
  const ox = ctx.enemyX + Math.cos(ang) * radius
  const oy = ctx.enemyY + Math.sin(ang) * radius
  steer(div, ox - div.ax, oy - div.ay, speed, dt)
  face(div, ctx.enemyX, ctx.enemyY, dt)
}

function pierce(div: Division, ctx: TacticContext, dt: number, speed: number): void {
  let dx = ctx.enemyX - ctx.ownX
  let dy = ctx.enemyY - ctx.ownY
  const len = hypot(dx, dy) || 1
  dx /= len
  dy /= len
  const bx = ctx.enemyX + dx * 320
  const by = ctx.enemyY + dy * 320
  steer(div, bx - div.ax, by - div.ay, speed, dt)
  face(div, bx, by, dt)
}

function feint(div: Division, ctx: TacticContext, dt: number, speed: number, offset: number, seconds: number): void {
  if (div.phase === 0) {
    div.phaseT += dt
    const awayX = div.ax - ctx.enemyX
    const awayY = div.ay - ctx.enemyY
    steer(div, awayX, awayY, speed, dt)
    face(div, div.ax + awayX, div.ay + awayY, dt)
    if (div.phaseT > seconds) {
      div.phase = 1
      div.phaseT = 0
    }
    return
  }
  flank(div, ctx, dt, speed, offset)
}

function tagged(div: Division, focus: boolean, ctx: TacticContext): void {
  div.focus = focus
  if (focus) aim(div, ctx)
}

export const TACTICS = {
  charge: {
    id: 'charge',
    name: '正面突撃',
    summary: '艦首を進路上に向け、敵の正面へ進む。',
    focus: false,
    guns: false,
    step(div, ctx, dt) {
      tagged(div, false, ctx)
      charge(div, ctx, dt, 34)
    },
  },
  hold: {
    id: 'hold',
    name: '定点射撃',
    summary: 'その場で艦首を敵へ向けて撃つ。',
    focus: false,
    guns: true,
    step(div, ctx, dt) {
      tagged(div, false, ctx)
      hold(div, ctx, dt)
    },
  },
  flank: {
    id: 'flank',
    name: '側面迂回',
    summary: '外側へ回り、敵の側面から艦首を向ける。',
    focus: false,
    guns: false,
    step(div, ctx, dt) {
      tagged(div, false, ctx)
      flank(div, ctx, dt, 36, 280)
    },
  },
  encircle: {
    id: 'encircle',
    name: '包囲',
    summary: '敵の周囲を回り、側面と背面を撃つ。',
    focus: false,
    guns: false,
    step(div, ctx, dt) {
      tagged(div, false, ctx)
      orbit(div, ctx, dt, 32, 210, 0.11)
    },
  },
  breakthrough: {
    id: 'breakthrough',
    name: '中央突破',
    summary: '艦首を向けたまま中央を突き抜ける。',
    focus: false,
    guns: false,
    step(div, ctx, dt) {
      tagged(div, false, ctx)
      pierce(div, ctx, dt, 42)
    },
  },
  feint: {
    id: 'feint',
    name: '偽装退却',
    summary: 'いったん反転して下がり、側面へ回り込む。',
    focus: false,
    guns: false,
    step(div, ctx, dt) {
      tagged(div, false, ctx)
      feint(div, ctx, dt, 32, 260, 12)
    },
  },
  focus: {
    id: 'focus',
    name: '集中砲火',
    summary: '艦首を一点へ向け、そこへ弾を集める。',
    focus: true,
    guns: true,
    step(div, ctx, dt) {
      tagged(div, true, ctx)
      charge(div, ctx, dt, 18)
    },
  },
} satisfies Record<TacticId, Tactic>

export function tacticById(id: TacticId): Tactic {
  return TACTICS[id]
}
