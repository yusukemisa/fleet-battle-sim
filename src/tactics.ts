import { anchorPace, CLASS_MODS, SWEEP } from './balance.ts'
import { aimUnderThreat, wideFlankGoal } from './threat.ts'
import type { Division, Tactic, TacticContext, TacticId } from './types.ts'

function hypot(x: number, y: number): number {
  return Math.hypot(x, y)
}

function steer(div: Division, mx: number, my: number, speed: number, dt: number): void {
  const len = hypot(mx, my)
  let tvx = 0
  let tvy = 0
  const paced = speed * anchorPace(div)
  if (len > 0.8 && paced > 0) {
    tvx = (mx / len) * paced
    tvy = (my / len) * paced
  }
  const a = 1 - Math.exp(-1.7 * dt)
  div.vx += (tvx - div.vx) * a
  div.vy += (tvy - div.vy) * a
  div.ax += div.vx * dt
  div.ay += div.vy * dt
}

function face(div: Division, tx: number, ty: number, dt: number): void {
  const aimed = aimUnderThreat(div, tx, ty)
  faceDirection(div, aimed.x - div.ax, aimed.y - div.ay, dt, 1.5 * CLASS_MODS[div.classId].turn)
}

function faceDirection(div: Division, fx: number, fy: number, dt: number, rate: number): void {
  const len = hypot(fx, fy)
  if (len < 1e-4) return
  fx /= len
  fy /= len
  const a = 1 - Math.exp(-rate * dt)
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

function clampCone(mx: number, my: number, px: number, py: number, minDot: number): { x: number; y: number } {
  const dot = mx * px + my * py
  if (dot >= minDot) return { x: mx, y: my }
  let sx = mx - px * dot
  let sy = my - py * dot
  const sl = Math.hypot(sx, sy)
  if (sl < 1e-6) return { x: px, y: py }
  sx /= sl
  sy /= sl
  const lateral = Math.sqrt(Math.max(0, 1 - minDot * minDot))
  return { x: px * minDot + sx * lateral, y: py * minDot + sy * lateral }
}

function sailBow(
  div: Division,
  gx: number,
  gy: number,
  threatX: number,
  threatY: number,
  speed: number,
  dt: number,
  minDot: number,
): void {
  let mx = gx - div.ax
  let my = gy - div.ay
  const ml = Math.hypot(mx, my) || 1
  mx /= ml
  my /= ml
  let px = threatX - div.ax
  let py = threatY - div.ay
  const pl = Math.hypot(px, py) || 1
  px /= pl
  py /= pl
  const clamped = clampCone(mx, my, px, py, minDot)
  steer(div, clamped.x, clamped.y, speed, dt)
  face(div, div.ax + clamped.x, div.ay + clamped.y, dt)
}

function preyFor(div: Division, ctx: TacticContext): Division | null {
  let best: Division | null = null
  let bestScore = Infinity
  const side = div.flankSign === 0 ? 1 : div.flankSign
  for (const other of ctx.divisions) {
    if (other.side === div.side || other.alive === 0) continue
    const dist = Math.hypot(other.ax - div.ax, other.ay - div.ay)
    const flank = Math.sign(other.ay - ctx.enemyY)
    let score = dist
    if (flank !== 0 && flank !== side) score += 240
    if (other.slot === div.slot) score -= 40
    if (score < bestScore) {
      bestScore = score
      best = other
    }
  }
  return best
}

function polarPoint(prey: Division, side: number, angle: number, range: number): { x: number; y: number } {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return {
    x: prey.ax + (prey.fx * c + prey.rx * side * s) * range,
    y: prey.ay + (prey.fy * c + prey.ry * side * s) * range,
  }
}

function hook(div: Division, ctx: TacticContext, dt: number, speed: number, mode: 'side' | 'rear'): void {
  const prey = preyFor(div, ctx)
  if (!prey) {
    charge(div, ctx, dt, speed)
    return
  }
  const side = div.flankSign === 0 ? 1 : div.flankSign
  const goal = wideFlankGoal(div, prey, mode)
  if (goal.pocket) div.phase = 2
  else if (goal.inFront) div.phase = 0
  div.markX = goal.x
  div.markY = goal.y
  if (div.phase === 2) {
    div.phaseT += dt
    const orbit = Math.min(Math.PI + 0.15, goal.angle + 0.4)
    if (div.phaseT > 5 || goal.angle > Math.PI - 0.35) {
      div.phase = 0
      div.phaseT = 0
    }
    const ahead = polarPoint(prey, side, orbit, mode === 'rear' ? 340 : 380)
    div.markX = ahead.x
    div.markY = ahead.y
    steer(div, ahead.x - div.ax, ahead.y - div.ay, speed * 0.9, dt)
    face(div, prey.ax, prey.ay, dt)
    return
  }
  if (goal.inFront) sailBow(div, goal.x, goal.y, prey.ax, prey.ay, speed, dt, 0.5)
  else {
    steer(div, goal.x - div.ax, goal.y - div.ay, speed, dt)
    face(div, prey.ax, prey.ay, dt)
  }
}

function pin(div: Division, ctx: TacticContext, dt: number): void {
  const prey = preyFor(div, ctx)
  const tx = prey ? prey.ax : ctx.enemyX
  const ty = prey ? prey.ay : ctx.enemyY
  let fx = prey ? prey.fx : ctx.ownX - ctx.enemyX
  let fy = prey ? prey.fy : ctx.ownY - ctx.enemyY
  const len = Math.hypot(fx, fy) || 1
  fx /= len
  fy /= len
  const gx = tx + fx * 520
  const gy = ty + fy * 520
  div.markX = gx
  div.markY = gy
  const dist = Math.hypot(gx - div.ax, gy - div.ay)
  steer(div, gx - div.ax, gy - div.ay, dist < 36 ? 0 : Math.min(28, dist), dt)
  face(div, tx, ty, dt)
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

function fleetHeading(ctx: TacticContext, dist: number): { x: number; y: number } {
  const dx = ctx.ownX - ctx.enemyX
  const dy = ctx.ownY - ctx.enemyY
  const ux = dx / dist
  const uy = dy / dist
  const tx = SWEEP.turn < 0 ? uy : -uy
  const ty = SWEEP.turn < 0 ? -ux : ux
  const off = ctx.sweepLeg === 1 ? SWEEP.passOff : SWEEP.off
  const hx = -ux * Math.cos(off) + tx * Math.sin(off)
  const hy = -uy * Math.cos(off) + ty * Math.sin(off)
  const len = hypot(hx, hy) || 1
  return { x: hx / len, y: hy / len }
}

function sweepDivision(div: Division, ctx: TacticContext, dt: number): void {
  const dx = ctx.ownX - ctx.enemyX
  const dy = ctx.ownY - ctx.enemyY
  const dist = hypot(dx, dy) || 1
  const ux = dx / dist
  const uy = dy / dist
  const tx = SWEEP.turn < 0 ? uy : -uy
  const ty = SWEEP.turn < 0 ? -ux : ux
  if (!div.sweepLocked) {
    const ox = div.ax - ctx.ownX
    const oy = div.ay - ctx.ownY
    div.sweepAlong = ox * tx + oy * ty
    div.sweepOut = ox * ux + oy * uy
    div.sweepLocked = true
  }
  const heading = fleetHeading(ctx, dist)
  const gx = ctx.ownX + heading.x * SWEEP.lead + tx * div.sweepAlong + ux * div.sweepOut
  const gy = ctx.ownY + heading.y * SWEEP.lead + ty * div.sweepAlong + uy * div.sweepOut
  div.markX = gx
  div.markY = gy
  div.sweeping = true
  div.focus = false
  steer(div, gx - div.ax, gy - div.ay, SWEEP.speed, dt)
  const aimed = aimUnderThreat(div, div.ax + heading.x, div.ay + heading.y)
  faceDirection(div, aimed.x - div.ax, aimed.y - div.ay, dt, 3.4)
}

/** Clockwise close-range wheel. Shaped fleets pick this only when it is the committed maneuver. */
export function wheelDivision(div: Division, ctx: TacticContext, dt: number): void {
  sweepDivision(div, ctx, dt)
}

export function stepDivision(div: Division, ctx: TacticContext, dt: number, wheel = true): void {
  div.shaped = false
  const tactic = TACTICS[div.tacticId]
  const dist = hypot(ctx.enemyX - ctx.ownX, ctx.enemyY - ctx.ownY)
  if (wheel && tactic.sweep && dist < SWEEP.engage) {
    sweepDivision(div, ctx, dt)
    return
  }
  div.sweeping = false
  div.sweepLocked = false
  tactic.step(div, ctx, dt)
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
    sweep: true,
    step(div, ctx, dt) {
      tagged(div, false, ctx)
      charge(div, ctx, dt, 34)
    },
  },
  hold: {
    id: 'hold',
    name: '定点射撃',
    summary: 'その場で艦首を敵へ向けて撃つ。接近しても艦隊の旋回には乗らない。',
    focus: false,
    guns: true,
    sweep: false,
    step(div, ctx, dt) {
      tagged(div, false, ctx)
      hold(div, ctx, dt)
    },
  },
  flank: {
    id: 'flank',
    name: '側面迂回',
    summary: '艦首射程の外を回って側面に出る。隊列の歩調には縛られない。',
    focus: false,
    guns: false,
    sweep: false,
    step(div, ctx, dt) {
      tagged(div, false, ctx)
      hook(div, ctx, dt, 46, 'side')
    },
  },
  broadside: {
    id: 'broadside',
    name: '側面攻撃',
    summary: '敵分艦隊の射界の外へ出て、その側面を撃つ。接近後もこの回り込みを続ける。',
    focus: false,
    guns: false,
    sweep: false,
    step(div, ctx, dt) {
      tagged(div, false, ctx)
      hook(div, ctx, dt, 58, 'side')
    },
  },
  rear: {
    id: 'rear',
    name: '背後襲撃',
    summary: '大きく回り込んで敵分艦隊の背面を撃つ。接近後もこの回り込みを続ける。',
    focus: false,
    guns: false,
    sweep: false,
    step(div, ctx, dt) {
      tagged(div, false, ctx)
      hook(div, ctx, dt, 38, 'rear')
    },
  },
  pin: {
    id: 'pin',
    name: '釘付け',
    summary: '敵中軍の正面で艦首を向け、その場に縛る。接近しても艦隊の旋回には乗らない。',
    focus: false,
    guns: false,
    sweep: false,
    step(div, ctx, dt) {
      tagged(div, false, ctx)
      pin(div, ctx, dt)
    },
  },
  encircle: {
    id: 'encircle',
    name: '包囲',
    summary: '敵の周囲を回り、側面と背面を撃つ。',
    focus: false,
    guns: false,
    sweep: true,
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
    sweep: true,
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
    sweep: true,
    step(div, ctx, dt) {
      tagged(div, false, ctx)
      feint(div, ctx, dt, 32, 260, 12)
    },
  },
  focus: {
    id: 'focus',
    name: '集中砲火',
    summary: '艦首を一点へ向け、そこへ弾を集める。接近しても艦隊の旋回には乗らない。',
    focus: true,
    guns: true,
    sweep: false,
    step(div, ctx, dt) {
      tagged(div, true, ctx)
      charge(div, ctx, dt, 18)
    },
  },
} satisfies Record<TacticId, Tactic>

export function tacticById(id: TacticId): Tactic {
  return TACTICS[id]
}
