import { CLASS_MODS, FIELD, SHIP_CLASS_IDS, classMods } from './balance.ts'
import { FORMATIONS } from './formations.ts'
import type { SimState } from './types.ts'

export interface Camera {
  x: number
  y: number
  zoom: number
}

const BLUE = '#3c90d6'
const RED = '#e16858'
const STAR = 'rgba(220, 226, 236, 0.55)'

let stars: { x: number; y: number; r: number; a: number }[] = []
let starW = 0
let starH = 0

export function draw(ctx: CanvasRenderingContext2D, state: SimState, camera: Camera, width: number, height: number): void {
  ensureStars(width, height)
  ctx.fillStyle = '#070b14'
  ctx.fillRect(0, 0, width, height)
  for (const star of stars) {
    ctx.globalAlpha = star.a
    ctx.fillStyle = STAR
    ctx.fillRect(star.x, star.y, star.r, star.r)
  }
  ctx.globalAlpha = 1

  const size = blockSize(camera.zoom, state.shipCount)
  paintShips(ctx, state, camera, width, height, size, 0, BLUE)
  paintShips(ctx, state, camera, width, height, size, 1, RED)
  paintShips(ctx, state, camera, width, height, size, 'flash', '#f4f1df')

  strokeBeams(ctx, state, camera, width, height)
  strokeBooms(ctx, state, camera, width, height)
  drawLegend(ctx, state, height)
  drawClassKey(ctx, width, height)
}

export function fitCamera(state: SimState, width: number, height: number): Camera {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const ships = state.ships
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] === 0) continue
    const x = ships.x[i] ?? 0
    const y = ships.y[i] ?? 0
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX)) {
    minX = -FIELD.fleetCenter
    maxX = FIELD.fleetCenter
    minY = -400
    maxY = 400
  }
  const padX = (maxX - minX) * 0.08 + 40
  const padY = (maxY - minY) * 0.12 + 40
  minX -= padX
  maxX += padX
  minY -= padY
  maxY += padY
  const top = 68
  const bottom = 28
  const side = 20
  const zoom = Math.min(
    (width - side * 2) / Math.max(1, maxX - minX),
    (height - top - bottom) / Math.max(1, maxY - minY),
  )
  const worldX = (minX + maxX) / 2
  const worldY = (minY + maxY) / 2
  const usableCenterX = side + (width - side * 2) / 2
  const usableCenterY = top + (height - top - bottom) / 2
  return {
    x: worldX - (usableCenterX - width / 2) / zoom,
    y: worldY - (height / 2 - usableCenterY) / zoom,
    zoom,
  }
}

function paintShips(
  ctx: CanvasRenderingContext2D,
  state: SimState,
  camera: Camera,
  width: number,
  height: number,
  size: number,
  side: 0 | 1 | 'flash',
  color: string,
): void {
  const ships = state.ships
  ctx.strokeStyle = color
  ctx.lineCap = 'butt'
  for (let klass = 0; klass < SHIP_CLASS_IDS.length; klass++) {
    const mods = classMods(klass)
    const hullW = Math.max(0.5, size * 0.7 * mods.girth)
    const halfLen = Math.max(hullW * 0.9, size * 0.9 * mods.length)
    ctx.lineWidth = hullW
    ctx.beginPath()
    const bow = new Path2D()
    for (let i = 0; i < ships.count; i++) {
      if (ships.alive[i] === 0 || (ships.shipClass[i] ?? 0) !== klass) continue
      const flash = (ships.flash[i] ?? 0) > 0.55
      if (side === 'flash' ? !flash : flash || ships.side[i] !== side) continue
      const p = worldToScreen(ships.x[i] ?? 0, ships.y[i] ?? 0, camera, width, height)
      const heading = ships.heading[i] ?? 0
      const hx = Math.cos(heading)
      const hy = -Math.sin(heading)
      const fx = hx * halfLen
      const fy = hy * halfLen
      ctx.moveTo(p.x - fx, p.y - fy)
      ctx.lineTo(p.x + fx, p.y + fy)
      const nose = halfLen + hullW * 0.22
      bow.moveTo(p.x + hx * nose, p.y + hy * nose)
      bow.lineTo(p.x + hx * (nose + hullW * 0.55), p.y + hy * (nose + hullW * 0.55))
    }
    ctx.stroke()
    ctx.lineWidth = Math.max(0.6, hullW * 0.62)
    ctx.stroke(bow)
  }
}

function blockSize(zoom: number, count: number): number {
  const unit = count >= 10000 ? 2.6 : count >= 1000 ? 4 : 9
  return Math.max(1.6, Math.min(13, zoom * unit))
}

function worldToScreen(x: number, y: number, camera: Camera, width: number, height: number): { x: number; y: number } {
  return {
    x: (x - camera.x) * camera.zoom + width / 2,
    y: height / 2 - (y - camera.y) * camera.zoom,
  }
}

function strokeBeams(
  ctx: CanvasRenderingContext2D,
  state: SimState,
  camera: Camera,
  width: number,
  height: number,
): void {
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.lineCap = 'butt'
  const density = beamDensity(state.shipCount, camera.zoom)
  const stride = state.shipCount >= 10000 ? 2 : 1
  const life = state.beams.life
  const kind = state.beams.kind
  const styles = [
    { max: FIELD.beamLife, alpha: FIELD.beamAlpha * density, width: Math.max(0.55, 1.05 * Math.min(1, density + 0.4)) },
    { max: FIELD.beamLifeSide, alpha: FIELD.beamAlphaSide * density, width: Math.max(0.4, 0.65 * Math.min(1, density + 0.4)) },
  ]
  const buckets = 5
  for (let style = 0; style < styles.length; style++) {
    const spec = styles[style]
    if (!spec) continue
    for (let bucket = 1; bucket <= buckets; bucket++) {
      ctx.beginPath()
      let any = false
      for (let i = 0; i < life.length; i++) {
        if (stride > 1 && i % stride !== 0) continue
        const remaining = life[i] ?? 0
        if (remaining <= 0 || (kind[i] ?? 0) !== style) continue
        const fade = Math.max(0, Math.min(1, remaining / spec.max))
        const slot = Math.min(buckets, Math.max(1, Math.ceil(fade * buckets)))
        if (slot !== bucket) continue
        const a = worldToScreen(state.beams.x1[i] ?? 0, state.beams.y1[i] ?? 0, camera, width, height)
        const b = worldToScreen(state.beams.x2[i] ?? 0, state.beams.y2[i] ?? 0, camera, width, height)
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        any = true
      }
      if (!any) continue
      const alpha = spec.alpha * (bucket / buckets)
      ctx.strokeStyle = `rgba(226, 206, 122, ${alpha.toFixed(3)})`
      ctx.lineWidth = spec.width
      ctx.stroke()
    }
  }
}

function beamDensity(count: number, zoom: number): number {
  const byCount = count >= 10000 ? 0.28 : count >= 1000 ? 0.55 : 1
  const byZoom = Math.min(1, Math.max(0.6, zoom / 0.5))
  return byCount * byZoom
}

function strokeBooms(
  ctx: CanvasRenderingContext2D,
  state: SimState,
  camera: Camera,
  width: number,
  height: number,
): void {
  const life = state.booms.life
  ctx.strokeStyle = 'rgba(244, 236, 214, 0.45)'
  for (let i = 0; i < life.length; i++) {
    const remaining = life[i] ?? 0
    if (remaining <= 0) continue
    const p = worldToScreen(state.booms.x[i] ?? 0, state.booms.y[i] ?? 0, camera, width, height)
    const radius = (1 - remaining / FIELD.boomLife) * 10 + 2
    ctx.beginPath()
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
    ctx.stroke()
  }
}

function drawLegend(ctx: CanvasRenderingContext2D, state: SimState, height: number): void {
  const rows = [0, 1] as const
  ctx.font = '13px "WenQuanYi Micro Hei", "Droid Sans Fallback", sans-serif'
  const lines = rows.map((side) => {
    const fleet = state.fleets[side]
    const count = state.alive[side].toLocaleString('ja-JP')
    return `${fleet.name} ${count}隻  ${FORMATIONS[fleet.formationId].name}`
  })
  const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) + 36
  const boxH = 18 + lines.length * 22
  const x = 14
  const y = height - boxH - 14
  ctx.fillStyle = 'rgba(8, 12, 20, 0.82)'
  ctx.strokeStyle = 'rgba(186, 198, 214, 0.35)'
  ctx.lineWidth = 1
  ctx.fillRect(x, y, width, boxH)
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, boxH - 1)
  rows.forEach((side, index) => {
    ctx.fillStyle = side === 0 ? BLUE : RED
    ctx.fillRect(x + 10, y + 14 + index * 22, 9, 9)
    ctx.fillStyle = '#d5dbe6'
    ctx.fillText(lines[index] ?? '', x + 26, y + 23 + index * 22)
  })
}

function drawClassKey(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const rows = SHIP_CLASS_IDS.map((id) => CLASS_MODS[id])
  ctx.font = '12px "WenQuanYi Micro Hei", "Droid Sans Fallback", sans-serif'
  const boxW = 108
  const boxH = 16 + rows.length * 16
  const x = width - boxW - 14
  const y = height - boxH - 14
  ctx.fillStyle = 'rgba(8, 12, 20, 0.82)'
  ctx.strokeStyle = 'rgba(186, 198, 214, 0.35)'
  ctx.lineWidth = 1
  ctx.fillRect(x, y, boxW, boxH)
  ctx.strokeRect(x + 0.5, y + 0.5, boxW - 1, boxH - 1)
  rows.forEach((mods, index) => {
    const rowY = y + 16 + index * 16
    ctx.strokeStyle = '#d5dbe6'
    ctx.lineWidth = Math.max(1, 3.2 * mods.girth)
    ctx.lineCap = 'butt'
    ctx.beginPath()
    const len = 8 + 10 * mods.length
    ctx.moveTo(x + 10, rowY - 3)
    ctx.lineTo(x + 10 + len, rowY - 3)
    ctx.stroke()
    ctx.fillStyle = '#d5dbe6'
    ctx.fillText(mods.name, x + 48, rowY)
  })
}

function ensureStars(width: number, height: number): void {
  if (stars.length > 0 && starW === width && starH === height) return
  starW = width
  starH = height
  stars = []
  let seed = 0x1234abcd
  const count = Math.round((width * height) / 14000)
  for (let i = 0; i < count; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    const x = (seed % 10000) / 10000
    seed = (seed * 1664525 + 1013904223) >>> 0
    const y = (seed % 10000) / 10000
    seed = (seed * 1664525 + 1013904223) >>> 0
    const r = (seed % 3) === 0 ? 2 : 1
    stars.push({ x: x * width, y: y * height, r, a: 0.18 + (seed % 50) / 100 })
  }
}
