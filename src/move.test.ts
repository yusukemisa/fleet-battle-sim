import { describe, expect, it } from 'vitest'
import { CLASS_STATS, classIndex, type ShipClassId } from './balance.ts'
import { wrapAngle } from './combat.ts'
import { orderPoints, stepMoveOrder } from './move.ts'
import { createSim, dispatch } from './sim.ts'

describe('move orders', () => {
  it('arrives at the point, ends near the ordered heading, and does not strafe', () => {
    const state = createSim({ shipCount: 100, commanders: ['manual', 'manual'] })
    const div = state.divisions[2]
    expect(div?.classId).toBe('battleship')
    if (!div) return
    const turn = CLASS_STATS[classIndex('battleship')]?.turnRate ?? 1.5
    div.ordered = true
    div.orderX = div.ax + 480
    div.orderY = div.ay
    div.orderH = Math.PI / 2
    const dt = 0.05
    let prev = Math.atan2(div.fy, div.fx)
    for (let step = 0; step < 400; step++) {
      const ax = div.ax
      const ay = div.ay
      stepMoveOrder(div, dt)
      const yaw = Math.abs(wrapAngle(Math.atan2(div.fy, div.fx) - prev))
      expect(yaw).toBeLessThanOrEqual(turn * dt + 1e-6)
      const mx = div.ax - ax
      const my = div.ay - ay
      expect(Math.abs(mx * div.rx + my * div.ry)).toBeLessThan(1e-6)
      prev = Math.atan2(div.fy, div.fx)
    }
    expect(Math.hypot(div.orderX - div.ax, div.orderY - div.ay)).toBeLessThan(16)
    expect(Math.abs(wrapAngle(Math.atan2(div.fy, div.fx) - div.orderH))).toBeLessThan(0.2)
  })

  it('yaws a destroyer faster than a battleship, at that class turn rate', () => {
    const battleship = yawOnce(['battleship', 'battleship', 'battleship', 'battleship', 'battleship'])
    const destroyer = yawOnce(['destroyer', 'destroyer', 'destroyer', 'destroyer', 'destroyer'])
    const bb = CLASS_STATS[classIndex('battleship')]?.turnRate ?? 0
    const dd = CLASS_STATS[classIndex('destroyer')]?.turnRate ?? 0
    expect(battleship).toBeCloseTo(bb * 0.05, 5)
    expect(destroyer).toBeCloseTo(dd * 0.05, 5)
    expect(destroyer).toBeGreaterThan(battleship)
  })

  it('keeps a group offset and ignores a fleet that is not manual', () => {
    let state = createSim({ shipCount: 100, commanders: ['manual', 'fierce'] })
    const left = state.divisions[0]
    const right = state.divisions[4]
    if (!left || !right) return
    const gap = right.ax - left.ax
    state = dispatch(state, { type: 'order-move', divisions: [0, 4, 7], x: 0, y: 200, heading: 1 })
    expect(state.divisions[0]?.ordered).toBe(true)
    expect(state.divisions[4]?.ordered).toBe(true)
    expect(state.divisions[7]?.ordered).toBe(false)
    expect((state.divisions[4]?.orderX ?? 0) - (state.divisions[0]?.orderX ?? 0)).toBeCloseTo(gap, 4)
    expect(state.divisions[0]?.orderH).toBeCloseTo(1, 5)
    const points = orderPoints(state.divisions, [0], 10, 10)
    expect(points[0]).toEqual({ index: 0, x: 10, y: 10 })
    state = dispatch(state, { type: 'order-clear', divisions: [0] })
    expect(state.divisions[0]?.ordered).toBe(false)
    expect(state.divisions[4]?.ordered).toBe(true)
  })

  it('sails the block toward the order while the ships stay near their slots', () => {
    let state = createSim({ shipCount: 100, commanders: ['manual', 'manual'] })
    const start = state.divisions[2]?.ax ?? 0
    state = dispatch(state, {
      type: 'order-move',
      divisions: [2],
      x: start + 360,
      y: 30,
      heading: 0.6,
    })
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    for (let step = 0; step < 40; step++) state = dispatch(state, { type: 'tick', dt: 0.05 })
    const div = state.divisions[2]
    expect(div?.ordered).toBe(true)
    expect((div?.ax ?? start) - start).toBeGreaterThan(40)
    let sum = 0
    let n = 0
    for (let i = 0; i < state.ships.count; i++) {
      if (state.ships.division[i] !== 2 || state.ships.alive[i] === 0 || !div) continue
      const tx = div.ax + div.rx * (state.ships.slotX[i] ?? 0) + div.fx * (state.ships.slotY[i] ?? 0)
      const ty = div.ay + div.ry * (state.ships.slotX[i] ?? 0) + div.fy * (state.ships.slotY[i] ?? 0)
      sum += Math.hypot((state.ships.x[i] ?? 0) - tx, (state.ships.y[i] ?? 0) - ty)
      n += 1
    }
    expect(n).toBeGreaterThan(0)
    expect(sum / n).toBeLessThan(140)
  })

  it('brings a gun-facing ship back to its slot when the enemy is out of range', () => {
    let state = createSim({ shipCount: 100, commanders: ['manual', 'manual'] })
    const div = state.divisions[0]
    const ship = state.ships
    if (!div) return
    div.tacticId = 'focus'
    div.fx = 1
    div.fy = 0
    div.rx = 0
    div.ry = -1
    div.guard = 4
    div.guardX = div.ax + 800
    div.guardY = div.ay
    const at = ship.division.findIndex((id, i) => id === 0 && ship.alive[i] === 1)
    ship.slotX[at] = 0
    ship.slotY[at] = 0
    ship.x[at] = div.ax - 480
    ship.y[at] = div.ay
    ship.heading[at] = Math.PI
    ship.vx[at] = 0
    ship.vy[at] = 0
    const start = Math.hypot((ship.x[at] ?? 0) - div.ax, (ship.y[at] ?? 0) - div.ay)
    state = dispatch(state, { type: 'set-speed', speed: 4 })
    state = dispatch(state, { type: 'start' })
    for (let step = 0; step < 80; step++) state = dispatch(state, { type: 'tick', dt: 0.05 })
    const end = Math.hypot((ship.x[at] ?? 0) - (state.divisions[0]?.ax ?? 0), (ship.y[at] ?? 0) - (state.divisions[0]?.ay ?? 0))
    expect(end).toBeLessThan(start * 0.45)
  })
})

function yawOnce(classes: readonly ShipClassId[]): number {
  const state = createSim({ shipCount: 100, commanders: ['manual', 'manual'], classes })
  const div = state.divisions[2]
  if (!div) return 0
  div.fx = 1
  div.fy = 0
  div.rx = 0
  div.ry = -1
  div.ordered = true
  div.orderX = div.ax - 400
  div.orderY = div.ay
  div.orderH = Math.PI
  stepMoveOrder(div, 0.05)
  return Math.abs(wrapAngle(Math.atan2(div.fy, div.fx)))
}
