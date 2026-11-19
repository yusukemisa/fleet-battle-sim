import { CLASS_STATS, SLOT_PITCH, stepYawInto } from './balance.ts'
import { wrapAngle } from './combat.ts'
import { tacticVariants } from './operation.ts'
import type { Fleet, SideId, SimState } from './types.ts'

/**
 * Dress the fleet on a wide, shallow grid and keep it there.
 * The anchor advances and turns. Ships slide onto their cells without yawing
 * off the enemy. Other tactics never enter this path.
 */

const GUN_RANGE = 900
const PITCH_FLOOR = 40
const DEPTH_CAP = 6
const HOLD_NEAR = 620
const HOLD_FAR = 780
const CRUISE = 18
const CLOSE = 16
const BACK = 10

export function dressing(side: SideId): boolean {
  return tacticVariants()[side] === 'dress'
}

/** Columns, ranks, and spacing for `count` living ships. */
export function dressShape(count: number): { cols: number; rows: number; pitch: number } {
  const n = Math.max(1, count)
  const scaled = SLOT_PITCH * Math.min(1.85, Math.max(1, Math.sqrt(n / 500)))
  const pitch = Math.max(PITCH_FLOOR, scaled)
  let rows = Math.max(1, Math.min(DEPTH_CAP, Math.round(Math.sqrt(n / 4))))
  let cols = Math.max(1, Math.ceil(n / rows))
  while (rows > 1 && cols / rows < 4) {
    rows -= 1
    cols = Math.ceil(n / rows)
  }
  return { cols, rows, pitch }
}

export function dressStation(state: SimState, index: number): { file: number; rank: number } | null {
  const book = books.get(state)
  if (!book) return null
  const file = book.file[index] ?? -1
  const rank = book.rank[index] ?? -1
  if (file < 0 || rank < 0) return null
  return { file, rank }
}

/** World point the dress fleet is pouring fire into, or null for every other tactic. */
export function dressAim(state: SimState, index: number): { x: number; y: number; r2: number } | null {
  const side: SideId = state.ships.side[index] === 1 ? 1 : 0
  if (!dressing(side)) return null
  const book = books.get(state)
  if (!book) return null
  const division = state.divisions[state.ships.division[index] ?? -1]
  const fleetIndex = division?.fleet ?? side
  if (book.aimed[fleetIndex] !== 1) return null
  const radius = book.aimR[fleetIndex] ?? 0
  return { x: book.aimX[fleetIndex] ?? 0, y: book.aimY[fleetIndex] ?? 0, r2: radius * radius }
}

interface Book {
  file: Int16Array
  rank: Int16Array
  goalX: Float32Array
  goalY: Float32Array
  speed: Float32Array
  hot: Uint8Array
  aimX: Float64Array
  aimY: Float64Array
  aimR: Float64Array
  aimBin: Int16Array
  aimed: Uint8Array
}

interface Plan {
  fleet: Fleet
  ships: number[]
  originX: number
  originY: number
  ax: number
  ay: number
  fx: number
  fy: number
  speed: number
  hot: boolean
  cols: number
  rows: number
  pitch: number
  half: number
  aimX: number
  aimY: number
  aimR: number
  aimed: boolean
  bin: number
}

const books = new WeakMap<SimState, Book>()
const spun = { yaw: 0, delta: 0 }
const columnPool: number[][] = []
const fresh: number[] = []

function bind(state: SimState): Book {
  const fleets = Math.max(8, state.fleets.length)
  let book = books.get(state)
  if (!book || book.file.length < state.ships.count || book.speed.length < fleets) {
    const n = state.ships.count
    book = {
      file: new Int16Array(n).fill(-1),
      rank: new Int16Array(n).fill(-1),
      goalX: new Float32Array(n),
      goalY: new Float32Array(n),
      speed: new Float32Array(fleets),
      hot: new Uint8Array(fleets),
      aimX: new Float64Array(fleets),
      aimY: new Float64Array(fleets),
      aimR: new Float64Array(fleets),
      aimBin: new Int16Array(fleets).fill(-1),
      aimed: new Uint8Array(fleets),
    }
    books.set(state, book)
  }
  return book
}

function rightOf(fx: number, fy: number): { rx: number; ry: number } {
  return { rx: fy, ry: -fx }
}

function slew(fx: number, fy: number, wx: number, wy: number, dt: number, rate: number): { fx: number; fy: number } {
  const cross = fx * wy - fy * wx
  const dot = fx * wx + fy * wy
  const err = Math.atan2(cross, dot)
  const step = Math.max(-rate * dt, Math.min(rate * dt, err))
  const c = Math.cos(step)
  const s = Math.sin(step)
  return { fx: fx * c - fy * s, fy: fx * s + fy * c }
}

function underGuns(state: SimState, fleet: Fleet): boolean {
  const reach = GUN_RANGE * GUN_RANGE
  const divisions = state.divisions
  for (const own of divisions) {
    if (own.fleet !== fleet.index || own.alive <= 0) continue
    for (const other of divisions) {
      if (other.fleet !== fleet.enemyFleet || other.alive <= 0) continue
      const dx = other.ax - own.ax
      const dy = other.ay - own.ay
      if (dx * dx + dy * dy <= reach) return true
    }
  }
  return false
}

function livingOf(state: SimState, fleet: Fleet): number[] {
  const ships = state.ships
  const out: number[] = []
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] !== 1 || ships.falling[i] === 1) continue
    const division = state.divisions[ships.division[i] ?? -1]
    if (!division || division.fleet !== fleet.index) continue
    out.push(i)
  }
  return out
}

function aimAt(state: SimState, fleet: Fleet, book: Book, ax: number, ay: number, fx: number, fy: number): { x: number; y: number; r: number; bin: number; ok: boolean } {
  const { rx, ry } = rightOf(fx, fy)
  const ships = state.ships
  const enemy = fleet.enemyFleet
  let minL = Infinity
  let maxL = -Infinity
  let n = 0
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] !== 1) continue
    const division = state.divisions[ships.division[i] ?? -1]
    if (!division || division.fleet !== enemy) continue
    const lat = ((ships.x[i] ?? 0) - ax) * rx + ((ships.y[i] ?? 0) - ay) * ry
    if (lat < minL) minL = lat
    if (lat > maxL) maxL = lat
    n += 1
  }
  if (n === 0 || !Number.isFinite(minL)) {
    return { x: ax + fx * 1000, y: ay + fy * 1000, r: 0, bin: -1, ok: false }
  }
  const span = Math.max(1, maxL - minL)
  const bins = Math.max(3, Math.min(16, Math.round(span / 700) || 3))
  const counts = new Float64Array(bins)
  const sumX = new Float64Array(bins)
  const sumY = new Float64Array(bins)
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] !== 1) continue
    const division = state.divisions[ships.division[i] ?? -1]
    if (!division || division.fleet !== enemy) continue
    const x = ships.x[i] ?? 0
    const y = ships.y[i] ?? 0
    const lat = (x - ax) * rx + (y - ay) * ry
    const bin = Math.min(bins - 1, Math.max(0, Math.floor(((lat - minL) / span) * bins)))
    counts[bin] = (counts[bin] ?? 0) + 1
    sumX[bin] = (sumX[bin] ?? 0) + x
    sumY[bin] = (sumY[bin] ?? 0) + y
  }
  const mean = n / bins
  const prev = book.aimBin[fleet.index] ?? -1
  let best = 0
  let bestScore = -Infinity
  for (let bin = 0; bin < bins; bin++) {
    const count = counts[bin] ?? 0
    if (count <= 0) continue
    const cx = (sumX[bin] ?? 0) / count
    const cy = (sumY[bin] ?? 0) / count
    const dist = Math.hypot(cx - ax, cy - ay)
    const end = bin === 0 || bin === bins - 1 ? 160 : 0
    const thin = Math.max(0, mean - count) * 50
    let score = end + thin - dist * 0.04
    if (bin === prev) score += 40
    if (score > bestScore) {
      bestScore = score
      best = bin
    }
  }
  const count = counts[best] ?? 0
  const x = count > 0 ? (sumX[best] ?? 0) / count : ax + fx * GUN_RANGE
  const y = count > 0 ? (sumY[best] ?? 0) / count : ay
  const radius = Math.max(180, (span / bins) * 0.55)
  return { x, y, r: radius, bin: best, ok: count > 0 }
}

function planFleet(state: SimState, fleet: Fleet, book: Book, dt: number, snap: boolean): Plan | null {
  const ships = livingOf(state, fleet)
  if (ships.length === 0) return null
  let ox = 0
  let oy = 0
  for (const i of ships) {
    ox += state.ships.x[i] ?? 0
    oy += state.ships.y[i] ?? 0
  }
  ox /= ships.length
  oy /= ships.length
  let fx = fleet.facingX
  let fy = fleet.facingY
  if (fx * fx + fy * fy < 0.25) {
    fx = fleet.side === 0 ? 1 : -1
    fy = 0
  }
  const aim = aimAt(state, fleet, book, ox, oy, fx, fy)
  const wantLen = Math.hypot(aim.x - ox, aim.y - oy) || 1
  const hot = underGuns(state, fleet)
  if (!snap) {
    const wx = (aim.x - ox) / wantLen
    const wy = (aim.y - oy) / wantLen
    const cross = fx * wy - fy * wx
    const dot = fx * wx + fy * wy
    const err = Math.abs(Math.atan2(cross, dot))
    const rate = hot ? (err > 0.55 ? 1.4 : 0) : 0.9
    const turned = slew(fx, fy, wx, wy, dt, rate)
    fx = turned.fx
    fy = turned.fy
  }
  const along = (aim.x - ox) * fx + (aim.y - oy) * fy
  let speed = 0
  if (!snap && aim.ok) {
    if (!hot) speed = CRUISE
    else if (along > HOLD_FAR) speed = CLOSE
    else if (along < HOLD_NEAR) speed = -BACK
  }
  let ax = ox + fx * speed * dt
  let ay = oy + fy * speed * dt
  const shape = dressShape(ships.length)
  if (snap) {
    let oldFront = -Infinity
    for (const i of ships) {
      const front = ((state.ships.x[i] ?? 0) - ox) * fx + ((state.ships.y[i] ?? 0) - oy) * fy
      if (front > oldFront) oldFront = front
    }
    const newFront = ((shape.rows - 1) / 2) * shape.pitch
    const excess = newFront - oldFront
    if (excess > 0) {
      ax -= fx * excess
      ay -= fy * excess
    }
  }
  return {
    fleet,
    ships,
    originX: ox,
    originY: oy,
    ax,
    ay,
    fx,
    fy,
    speed,
    hot,
    cols: shape.cols,
    rows: shape.rows,
    pitch: shape.pitch,
    half: Math.max(0, shape.cols - 1) * shape.pitch * 0.5,
    aimX: aim.x,
    aimY: aim.y,
    aimR: aim.r,
    aimed: aim.ok,
    bin: aim.bin,
  }
}

function formLine(state: SimState, plans: Plan[], dt: number, snap: boolean): void {
  if (plans.length < 2) return
  const side = plans[0]?.fleet.side ?? 0
  let ox = 0
  let oy = 0
  let weight = 0
  let fx = 0
  let fy = 0
  for (const plan of plans) {
    const n = plan.ships.length
    ox += plan.originX * n
    oy += plan.originY * n
    weight += n
    fx += plan.fleet.facingX
    fy += plan.fleet.facingY
  }
  if (weight <= 0) return
  ox /= weight
  oy /= weight
  const facingLen = Math.hypot(fx, fy) || 1
  fx /= facingLen
  fy /= facingLen
  let ex = 0
  let ey = 0
  let enemies = 0
  const ships = state.ships
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] !== 1 || ships.side[i] === side) continue
    ex += ships.x[i] ?? 0
    ey += ships.y[i] ?? 0
    enemies += 1
  }
  if (enemies > 0) {
    ex /= enemies
    ey /= enemies
  }
  let hot = false
  for (const plan of plans) {
    if (underGuns(state, plan.fleet)) hot = true
  }
  if (!snap && enemies > 0) {
    const wantLen = Math.hypot(ex - ox, ey - oy) || 1
    const wx = (ex - ox) / wantLen
    const wy = (ey - oy) / wantLen
    const err = Math.abs(Math.atan2(fx * wy - fy * wx, fx * wx + fy * wy))
    const rate = hot ? (err > 0.55 ? 1.4 : 0) : 0.9
    const turned = slew(fx, fy, wx, wy, dt, rate)
    fx = turned.fx
    fy = turned.fy
  }
  const halfDepth = Math.max(...plans.map((plan) => Math.max(0, plan.rows - 1) * plan.pitch * 0.5))
  const along = enemies > 0 ? (ex - ox) * fx + (ey - oy) * fy - halfDepth : 0
  let speed = 0
  if (!snap && enemies > 0) {
    if (!hot) speed = CRUISE
    else if (along > HOLD_FAR) speed = CLOSE
    else if (along < HOLD_NEAR) speed = -BACK
  }
  let ax = ox + fx * speed * dt
  let ay = oy + fy * speed * dt
  if (snap) {
    let oldFront = -Infinity
    for (const plan of plans) {
      for (const i of plan.ships) {
        const front = ((ships.x[i] ?? 0) - ox) * fx + ((ships.y[i] ?? 0) - oy) * fy
        if (front > oldFront) oldFront = front
      }
    }
    const excess = halfDepth - oldFront
    if (excess > 0) {
      ax -= fx * excess
      ay -= fy * excess
    }
  }
  plans.sort((a, b) => a.fleet.ordinal - b.fleet.ordinal)
  let width = 0
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i]
    if (!plan) continue
    width += plan.half * 2
    if (i > 0) width += plan.pitch
  }
  const rx = fy
  const ry = -fx
  let cursor = -width / 2
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i]
    if (!plan) continue
    if (i > 0) cursor += plan.pitch
    const center = cursor + plan.half
    cursor += plan.half * 2
    plan.ax = ax + rx * center
    plan.ay = ay + ry * center
    plan.fx = fx
    plan.fy = fy
    plan.speed = speed
    plan.hot = hot
  }
}

function columns(cols: number): number[][] {
  if (columnPool.length < cols) {
    for (let i = columnPool.length; i < cols; i++) columnPool.push([])
  }
  for (let i = 0; i < cols; i++) columnPool[i]!.length = 0
  return columnPool
}

function seat(state: SimState, book: Book, plan: Plan): void {
  const { ships } = state
  const indexes = plan.ships
  const cols = plan.cols
  const pool = columns(cols)
  fresh.length = 0
  let known = 0
  for (const i of indexes) {
    const file = book.file[i] ?? -1
    if (file >= 0 && file < cols) {
      pool[file]!.push(i)
      known += 1
    } else fresh.push(i)
  }
  const reseat = known * 2 < indexes.length
  if (reseat) {
    for (let c = 0; c < cols; c++) pool[c]!.length = 0
    const ordered = indexes.slice().sort((a, b) => {
      const la = ((ships.x[a] ?? 0) - plan.ax) * plan.fy + ((ships.y[a] ?? 0) - plan.ay) * -plan.fx
      const lb = ((ships.x[b] ?? 0) - plan.ax) * plan.fy + ((ships.y[b] ?? 0) - plan.ay) * -plan.fx
      if (la !== lb) return la - lb
      return a - b
    })
    const n = ordered.length
    for (let k = 0; k < n; k++) {
      const ship = ordered[k]
      if (ship === undefined) continue
      const file = Math.min(cols - 1, Math.floor((k * cols) / Math.max(1, n)))
      book.file[ship] = file
      book.rank[ship] = -1
      pool[file]!.push(ship)
    }
  } else {
    for (const ship of fresh) {
      let best = 0
      for (let c = 1; c < cols; c++) if (pool[c]!.length < pool[best]!.length) best = c
      book.file[ship] = best
      book.rank[ship] = -1
      pool[best]!.push(ship)
    }
  }
  const { fx, fy, ax, ay, pitch, rows } = plan
  const rx = fy
  const ry = -fx
  for (let c = 0; c < cols; c++) {
    const col = pool[c]!
    col.sort((a, b) => {
      const ra = book.rank[a] ?? -1
      const rb = book.rank[b] ?? -1
      if (ra >= 0 && rb >= 0 && ra !== rb) return ra - rb
      const fa = ((ships.x[a] ?? 0) - ax) * fx + ((ships.y[a] ?? 0) - ay) * fy
      const fb = ((ships.x[b] ?? 0) - ax) * fx + ((ships.y[b] ?? 0) - ay) * fy
      if (fa !== fb) return fb - fa
      return a - b
    })
    for (let r = 0; r < col.length; r++) {
      const ship = col[r]
      if (ship === undefined) continue
      book.rank[ship] = r
      const along = ((rows - 1) / 2 - r) * pitch
      const across = (c - (cols - 1) / 2) * pitch
      book.goalX[ship] = ax + fx * along + rx * across
      book.goalY[ship] = ay + fy * along + ry * across
    }
  }
}

function placeDivisions(state: SimState, plan: Plan, deltaX: number, deltaY: number): void {
  const ships = state.ships
  const { fx, fy, speed } = plan
  const rx = fy
  const ry = -fx
  for (let d = 0; d < state.divisions.length; d++) {
    const division = state.divisions[d]
    if (!division || division.fleet !== plan.fleet.index) continue
    let sx = 0
    let sy = 0
    let n = 0
    for (const i of plan.ships) {
      if ((ships.division[i] ?? -1) !== d) continue
      sx += ships.x[i] ?? 0
      sy += ships.y[i] ?? 0
      n += 1
    }
    if (n > 0) {
      division.ax = sx / n + deltaX
      division.ay = sy / n + deltaY
    }
    division.fx = fx
    division.fy = fy
    division.rx = rx
    division.ry = ry
    division.vx = fx * speed
    division.vy = fy * speed
    division.focus = plan.aimed
    division.focusX = plan.aimX
    division.focusY = plan.aimY
    division.hunt = -1
  }
}

function writeSlots(state: SimState, book: Book, plan: Plan): void {
  const ships = state.ships
  for (const i of plan.ships) {
    const division = state.divisions[ships.division[i] ?? -1]
    if (!division) continue
    const dx = (book.goalX[i] ?? 0) - division.ax
    const dy = (book.goalY[i] ?? 0) - division.ay
    const sx = dx * division.rx + dy * division.ry
    const sy = dx * division.fx + dy * division.fy
    ships.slotX[i] = sx
    ships.slotY[i] = sy
    ships.homeX[i] = sx
    ships.homeY[i] = sy
  }
}

function commit(state: SimState, book: Book, plan: Plan, snap: boolean): void {
  seat(state, book, plan)
  const ships = state.ships
  const dx = plan.ax - plan.originX
  const dy = plan.ay - plan.originY
  if (snap) {
    for (const i of plan.ships) {
      ships.x[i] = book.goalX[i] ?? ships.x[i] ?? 0
      ships.y[i] = book.goalY[i] ?? ships.y[i] ?? 0
      ships.vx[i] = 0
      ships.vy[i] = 0
      ships.yaw[i] = 0
      const heading = Math.atan2(plan.fy, plan.fx)
      ships.heading[i] = heading
      ships.headingCos[i] = plan.fx
      ships.headingSin[i] = plan.fy
      ships.headingStamp[i] = heading
      ships.headingKnown[i] = 1
    }
    placeDivisions(state, plan, 0, 0)
  } else {
    placeDivisions(state, plan, dx, dy)
  }
  writeSlots(state, book, plan)
  const fleet = plan.fleet
  fleet.meanX = plan.ax
  fleet.meanY = plan.ay
  fleet.facingX = plan.fx
  fleet.facingY = plan.fy
  const index = fleet.index
  book.speed[index] = plan.speed
  book.hot[index] = plan.hot ? 1 : 0
  book.aimX[index] = plan.aimX
  book.aimY[index] = plan.aimY
  book.aimR[index] = plan.aimR
  book.aimBin[index] = plan.bin
  book.aimed[index] = plan.aimed ? 1 : 0
}

function layoutSide(state: SimState, side: SideId, dt: number, snap: boolean): void {
  if (!dressing(side)) return
  const book = bind(state)
  const plans: Plan[] = []
  for (const fleet of state.fleets) {
    if (fleet.side !== side || fleet.ships <= 0) continue
    const plan = planFleet(state, fleet, book, dt, snap)
    if (plan) plans.push(plan)
  }
  formLine(state, plans, dt, snap)
  for (const plan of plans) commit(state, book, plan, snap)
}

/** Put a dressing side on its grid before the first order. */
export function dressDeploy(state: SimState): void {
  if (!dressing(0) && !dressing(1)) return
  const book = bind(state)
  book.file.fill(-1)
  book.rank.fill(-1)
  book.aimed.fill(0)
  layoutSide(state, 0, 0, true)
  layoutSide(state, 1, 0, true)
}

/** Move each dressing fleet's anchor and refill holes left by sunk ships. */
export function applyDress(state: SimState, dt: number): void {
  if (!dressing(0) && !dressing(1)) return
  bind(state)
  layoutSide(state, 0, dt, false)
  layoutSide(state, 1, dt, false)
}

/** Face the enemy and add lateral thrust toward the slot. Returns false when this ship is not dressed. */
export function stepDressShip(state: SimState, index: number, dt: number, turnScale: number): boolean {
  const book = books.get(state)
  if (!book || (book.file[index] ?? -1) < 0) return false
  const ships = state.ships
  const division = state.divisions[ships.division[index] ?? -1]
  const fleet = division ? state.fleets[division.fleet] : undefined
  if (!fleet || !dressing(fleet.side)) return false
  const stats = CLASS_STATS[ships.shipClass[index] ?? 0] ?? state.stats
  const fx = fleet.facingX
  const fy = fleet.facingY
  const rx = fy
  const ry = -fx
  const desired = Math.atan2(fy, fx)
  const prevHeading = ships.heading[index] ?? desired
  const error = wrapAngle(desired - prevHeading)
  const hot = book.hot[fleet.index] === 1
  const turnRate = stats.turnRate * turnScale * (hot && Math.abs(error) < 0.55 ? 0.05 : 1)
  stepYawInto(spun, ships.yaw[index] ?? 0, error, turnRate, stats.yawAccel, dt)
  ships.yaw[index] = spun.yaw
  const heading = prevHeading + spun.delta
  ships.heading[index] = heading
  const hx = Math.cos(heading)
  const hy = Math.sin(heading)
  ships.headingCos[index] = hx
  ships.headingSin[index] = hy
  ships.headingStamp[index] = heading
  ships.headingKnown[index] = 1
  const x = ships.x[index] ?? 0
  const y = ships.y[index] ?? 0
  const gx = book.goalX[index] ?? x
  const gy = book.goalY[index] ?? y
  const ex = gx - x
  const ey = gy - y
  const alongErr = ex * fx + ey * fy
  const latErr = ex * rx + ey * ry
  let speed = book.speed[fleet.index] ?? 0
  if (alongErr > 16) speed += Math.min(8, alongErr * 0.2)
  else if (alongErr < -16) speed -= Math.min(14, -alongErr * 0.25)
  const reverse = stats.maxSpeed * stats.reverse
  speed = Math.max(-reverse, Math.min(stats.maxSpeed, speed))
  const prevSpeed = (ships.vx[index] ?? 0) * hx + (ships.vy[index] ?? 0) * hy
  speed = prevSpeed + Math.max(-8, Math.min(8, speed - prevSpeed))
  const slide = Math.max(-14, Math.min(14, latErr * 1.4))
  const vx = hx * speed + rx * slide
  const vy = hy * speed + ry * slide
  ships.vx[index] = vx
  ships.vy[index] = vy
  ships.x[index] = x + vx * dt
  ships.y[index] = y + vy * dt
  return true
}
