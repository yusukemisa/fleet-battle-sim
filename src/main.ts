import { draw, fitCamera, type Camera, type OrderDraft } from './draw.ts'
import { dispatch, createSim } from './sim.ts'
import { DEFAULT_SHIP_COUNT, type Command, type SimState } from './types.ts'
import { mountHud, syncHud } from './ui.ts'
import './style.css'

const found = document.querySelector('#app')
if (!(found instanceof HTMLElement)) throw new Error('missing app')
const root = found

const hud = mountHud(
  root,
  (command) => apply(command),
  () => {
    camera = fitCamera(sim, viewWidth(), viewHeight())
  },
  () => sim.phase.kind,
  (index, shift) => toggleSelect(index, shift),
)

const canvas = document.createElement('canvas')
canvas.id = 'view'
root.append(canvas)
const maybeContext = canvas.getContext('2d', { alpha: false })
if (!maybeContext) {
  root.textContent = 'このブラウザでは戦場を描画できません。'
  throw new Error('2d context unavailable')
}
const context = maybeContext

let sim: SimState = createSim({ shipCount: DEFAULT_SHIP_COUNT })
let camera: Camera = { x: 0, y: 0, zoom: 1 }
let fitted = false

const frameSamples: { frame: number; sim: number; draw: number }[] = []
let fps = 0
let simMs = 0
let drawMs = 0
let frameMs = 0
let sampleFrames = 0
let sampleAcc = 0
let last = performance.now()
const selected: number[] = []
let draft: OrderDraft | null = null
type Gesture =
  | { kind: 'pan'; pointerId: number; x: number; y: number; camX: number; camY: number }
  | { kind: 'order'; pointerId: number; x: number; y: number; wx: number; wy: number; moved: boolean }
let gesture: Gesture | null = null

canvas.addEventListener('contextmenu', (event) => event.preventDefault())
canvas.addEventListener('pointerdown', (event) => {
  const world = screenToWorld(event.clientX, event.clientY)
  if (event.button === 2) {
    const hit = pickDivision(world.x, world.y)
    if (hit >= 0 && sim.divisions[hit]?.ordered) apply({ type: 'order-clear', divisions: [hit] })
    else if (selected.length > 0) apply({ type: 'order-clear', divisions: [...selected] })
    return
  }
  if (event.button !== 0) return
  const hit = pickDivision(world.x, world.y)
  if (hit >= 0 && isManual(hit)) {
    toggleSelect(hit, event.shiftKey)
    return
  }
  const manuals = manualSelection()
  if (manuals.length > 0 && sim.phase.kind !== 'finished') {
    gesture = { kind: 'order', pointerId: event.pointerId, x: event.clientX, y: event.clientY, wx: world.x, wy: world.y, moved: false }
    draft = { x: world.x, y: world.y, heading: travelHeading(world.x, world.y), divisions: manuals }
    capture(event.pointerId)
    return
  }
  gesture = { kind: 'pan', pointerId: event.pointerId, x: event.clientX, y: event.clientY, camX: camera.x, camY: camera.y }
  capture(event.pointerId)
  canvas.style.cursor = 'grabbing'
})
canvas.addEventListener('pointermove', (event) => {
  if (!gesture || gesture.pointerId !== event.pointerId) {
    const world = screenToWorld(event.clientX, event.clientY)
    const hit = pickDivision(world.x, world.y)
    canvas.style.cursor = hit >= 0 && isManual(hit) ? 'pointer' : selected.length > 0 ? 'crosshair' : 'grab'
    return
  }
  if (gesture.kind === 'pan') {
    camera.x = gesture.camX - (event.clientX - gesture.x) / camera.zoom
    camera.y = gesture.camY + (event.clientY - gesture.y) / camera.zoom
    return
  }
  const dx = event.clientX - gesture.x
  const dy = event.clientY - gesture.y
  if (dx * dx + dy * dy > 144) gesture.moved = true
  const world = screenToWorld(event.clientX, event.clientY)
  const heading = gesture.moved ? Math.atan2(world.y - gesture.wy, world.x - gesture.wx) : travelHeading(gesture.wx, gesture.wy)
  draft = { x: gesture.wx, y: gesture.wy, heading, divisions: manualSelection() }
})
canvas.addEventListener('pointerup', (event) => finishGesture(event.pointerId, event.clientX, event.clientY))
canvas.addEventListener('pointercancel', (event) => {
  if (gesture?.pointerId === event.pointerId) {
    gesture = null
    draft = null
  }
})
canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault()
    const rect = canvas.getBoundingClientRect()
    const sx = event.clientX - rect.left
    const sy = event.clientY - rect.top
    const width = viewWidth()
    const height = viewHeight()
    const wx = (sx - width / 2) / camera.zoom + camera.x
    const wy = (height / 2 - sy) / camera.zoom + camera.y
    camera.zoom = Math.min(8, Math.max(0.04, camera.zoom * Math.exp(-event.deltaY * 0.001)))
    camera.x = wx - (sx - width / 2) / camera.zoom
    camera.y = wy - (height / 2 - sy) / camera.zoom
  },
  { passive: false },
)

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement) return
  if (event.key === 'Escape') {
    event.preventDefault()
    if (selected.length > 0) {
      apply({ type: 'order-clear', divisions: [...selected] })
      setSelected([])
    } else {
      const all = sim.divisions.map((_, index) => index).filter((index) => isManual(index))
      apply({ type: 'order-clear', divisions: all })
    }
    return
  }
  if (event.code === 'Space') {
    event.preventDefault()
    if (sim.phase.kind === 'setup') apply({ type: 'start' })
    else if (sim.phase.kind === 'running') apply({ type: 'pause' })
    else if (sim.phase.kind === 'paused') apply({ type: 'resume' })
  } else if (event.key === '1' || event.key === '2' || event.key === '4') {
    const speed = event.key === '1' ? 1 : event.key === '2' ? 2 : 4
    apply({ type: 'set-speed', speed })
  }
})

window.addEventListener('resize', () => {
  resize()
  camera = fitCamera(sim, viewWidth(), viewHeight())
})

const api = {
  get fps() { return fps },
  get simMs() { return simMs },
  get drawMs() { return drawMs },
  get frameMs() { return frameMs },
  get shipCount() { return sim.shipCount },
  get phase() { return sim.phase.kind },
  get alive() { return [sim.alive[0], sim.alive[1]] as const },
  get lost() { return [sim.lost[0], sim.lost[1]] as const },
  get formations() { return [sim.fleets[0].formationId, sim.fleets[1].formationId] as const },
  samples: frameSamples,
  command(command: Command) { apply(command) },
}
window.__battle = api

resize()
syncHud(root, hud, sim)
requestAnimationFrame(loop)

function apply(command: Command): void {
  const before = sim.shipCount
  const formation = sim.fleets.map((fleet) => fleet.formationId).join()
  sim = dispatch(sim, command)
  const refit = sim.shipCount !== before || sim.fleets.map((fleet) => fleet.formationId).join() !== formation || command.type === 'reset'
  if (refit) camera = fitCamera(sim, viewWidth(), viewHeight())
  syncHud(root, hud, sim, selected)
}

function loop(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  const simStart = performance.now()
  sim = dispatch(sim, { type: 'tick', dt })
  simMs = performance.now() - simStart
  resize()
  if (!fitted && viewWidth() > 0 && viewHeight() > 0) {
    camera = fitCamera(sim, viewWidth(), viewHeight())
    fitted = true
  }
  const drawStart = performance.now()
  draw(context, sim, camera, viewWidth(), viewHeight(), { selected, draft })
  drawMs = performance.now() - drawStart
  frameMs = simMs + drawMs
  sampleAcc += dt
  sampleFrames += 1
  frameSamples.push({ frame: frameMs, sim: simMs, draw: drawMs })
  if (frameSamples.length > 240) frameSamples.shift()
  if (sampleAcc >= 0.5) {
    fps = sampleFrames / sampleAcc
    sampleFrames = 0
    sampleAcc = 0
    hud.fps.textContent = `${Math.round(fps)} fps  計算 ${simMs.toFixed(1)} ms  描画 ${drawMs.toFixed(1)} ms`
    syncHud(root, hud, sim, selected)
  }
  requestAnimationFrame(loop)
}

function finishGesture(pointerId: number, clientX: number, clientY: number): void {
  const current = gesture
  if (!current || current.pointerId !== pointerId) return
  gesture = null
  if (current.kind === 'order' && sim.phase.kind !== 'finished') {
    const world = screenToWorld(clientX, clientY)
    const heading = current.moved ? Math.atan2(world.y - current.wy, world.x - current.wx) : travelHeading(current.wx, current.wy)
    apply({ type: 'order-move', divisions: manualSelection(), x: current.wx, y: current.wy, heading })
  }
  draft = null
  canvas.style.cursor = selected.length > 0 ? 'crosshair' : 'grab'
}

function toggleSelect(index: number, shift: boolean): void {
  if (!isManual(index)) return
  if (shift) {
    const at = selected.indexOf(index)
    if (at >= 0) selected.splice(at, 1)
    else selected.push(index)
    setSelected(selected)
    return
  }
  setSelected(selected.length === 1 && selected[0] === index ? [] : [index])
}

function setSelected(next: readonly number[]): void {
  const copy = [...next]
  selected.splice(0, selected.length, ...copy)
  canvas.style.cursor = selected.length > 0 ? 'crosshair' : 'grab'
  syncHud(root, hud, sim, selected)
}

function isManual(index: number): boolean {
  const division = sim.divisions[index]
  return division !== undefined && sim.fleets[division.side].commanderId === 'manual'
}

function manualSelection(): number[] {
  return selected.filter((index) => isManual(index))
}

function travelHeading(x: number, y: number): number {
  const manuals = manualSelection()
  let cx = 0
  let cy = 0
  let n = 0
  for (const index of manuals) {
    const division = sim.divisions[index]
    if (!division) continue
    cx += division.ax
    cy += division.ay
    n += 1
  }
  if (n === 0) return 0
  return Math.atan2(y - cy / n, x - cx / n)
}

function pickDivision(wx: number, wy: number): number {
  const ships = sim.ships
  const shipReach = 18 / Math.max(camera.zoom, 0.04)
  let best = -1
  let bestD = shipReach * shipReach
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] === 0) continue
    const dx = (ships.x[i] ?? 0) - wx
    const dy = (ships.y[i] ?? 0) - wy
    const d = dx * dx + dy * dy
    if (d <= bestD) {
      bestD = d
      best = ships.division[i] ?? -1
    }
  }
  if (best >= 0) return best
  const anchorReach = 26 / Math.max(camera.zoom, 0.04)
  let divBest = -1
  let divD = anchorReach * anchorReach
  for (let i = 0; i < sim.divisions.length; i++) {
    const division = sim.divisions[i]
    if (!division || division.alive === 0) continue
    const dx = division.ax - wx
    const dy = division.ay - wy
    const d = dx * dx + dy * dy
    if (d <= divD) {
      divD = d
      divBest = i
    }
  }
  return divBest
}

function screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  const sx = clientX - rect.left
  const sy = clientY - rect.top
  return {
    x: (sx - viewWidth() / 2) / camera.zoom + camera.x,
    y: (viewHeight() / 2 - sy) / camera.zoom + camera.y,
  }
}

function capture(pointerId: number): void {
  try {
    canvas.setPointerCapture(pointerId)
  } catch {
    // The pointer can already be gone on a very fast tap.
  }
}

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr))
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function viewWidth(): number {
  return canvas.clientWidth
}

function viewHeight(): number {
  return canvas.clientHeight
}

declare global {
  interface Window {
    __battle: {
      fps: number
      simMs: number
      drawMs: number
      frameMs: number
      shipCount: number
      phase: string
      alive: readonly [number, number]
      lost: readonly [number, number]
      formations: readonly [string, string]
      samples: { frame: number; sim: number; draw: number }[]
      command(command: Command): void
    }
  }
}
