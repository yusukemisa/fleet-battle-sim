import { draw, fitCamera, type Camera } from './draw.ts'
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
let drag: { x: number; y: number; camX: number; camY: number } | null = null

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  drag = { x: event.clientX, y: event.clientY, camX: camera.x, camY: camera.y }
  canvas.setPointerCapture(event.pointerId)
  canvas.style.cursor = 'grabbing'
})
canvas.addEventListener('pointermove', (event) => {
  if (!drag) return
  camera.x = drag.camX - (event.clientX - drag.x) / camera.zoom
  camera.y = drag.camY + (event.clientY - drag.y) / camera.zoom
})
canvas.addEventListener('pointerup', () => {
  drag = null
  canvas.style.cursor = 'grab'
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
  syncHud(root, hud, sim)
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
  draw(context, sim, camera, viewWidth(), viewHeight())
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
    syncHud(root, hud, sim)
  }
  requestAnimationFrame(loop)
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
