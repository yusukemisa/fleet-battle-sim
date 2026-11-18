import { describe, expect, it } from 'vitest'
import { createSim } from './sim.ts'
import { aimUnderThreat, assessDivision, markUnderFire, pathCrossesBow, shipUnderFire, wideFlankGoal } from './threat.ts'

describe('exposure', () => {
  it('keeps the bow on a threat instead of turning the side toward it', () => {
    const state = createSim({ shipCount: 100, commanders: ['manual', 'manual'] })
    const div = state.divisions[2]
    if (!div) return
    div.ax = 0
    div.ay = 0
    div.fx = 1
    div.fy = 0
    div.guard = 20
    div.guardX = 400
    div.guardY = 0
    div.broadsideOk = false
    div.yielding = false
    const aimed = aimUnderThreat(div, 0, 400)
    const dx = aimed.x - div.ax
    const dy = aimed.y - div.ay
    const len = Math.hypot(dx, dy) || 1
    const dot = (dx / len) * 1 + (dy / len) * 0
    expect(dot).toBeGreaterThan(0.7)
    div.broadsideOk = true
    const free = aimUnderThreat(div, 0, 400)
    expect(free).toEqual({ x: 0, y: 400 })
  })

  it('sends a flanking approach outside the prey bow range while still in front', () => {
    const state = createSim({ shipCount: 100 })
    const prey = state.divisions[7]
    const wing = state.divisions[0]
    if (!prey || !wing) return
    prey.ax = 0
    prey.ay = 0
    prey.fx = 1
    prey.fy = 0
    prey.rx = 0
    prey.ry = 1
    prey.classId = 'battleship'
    prey.alive = 10
    wing.ax = 420
    wing.ay = 70
    wing.flankSign = 1
    const goal = wideFlankGoal(wing, prey, 'side')
    expect(goal.inFront).toBe(true)
    expect(goal.range).toBeLessThan(goal.goalRange)
    expect(goal.goalRange).toBeGreaterThan(900)
    expect(Math.hypot(goal.x - prey.ax, goal.y - prey.ay)).toBeGreaterThan(900)
  })

  it('reads a bow battery as a threat and a clear flank as a broadside that pays', () => {
    const state = createSim({ shipCount: 100, commanders: ['manual', 'manual'] })
    const us = state.divisions[2]
    const them = state.divisions[7]
    if (!us || !them) return
    us.ax = -500
    us.ay = 0
    us.fx = 1
    us.fy = 0
    them.ax = 0
    them.ay = 0
    them.fx = -1
    them.fy = 0
    them.rx = 0
    them.ry = 1
    them.classId = 'battleship'
    them.alive = 12
    for (const division of state.divisions) {
      if (division !== them && division.side === 1) division.alive = 0
    }
    const front = assessDivision(state, us)
    expect(front.weight).toBeGreaterThan(0)
    expect(front.broadside).toBe(false)
    us.ax = 0
    us.ay = 300
    const beam = assessDivision(state, us)
    expect(beam.broadside).toBe(true)
    const crosses = pathCrossesBow(state, 0, -1200, 0, 200, 0)
    const clear = pathCrossesBow(state, 0, -1200, 800, -1200, -800)
    expect(crosses).toBe(true)
    expect(clear).toBe(false)
  })

  it('marks a unit inside an enemy bow and leaves a unit outside it', () => {
    const state = createSim({ shipCount: 100, commanders: ['manual', 'manual'] })
    const ships = state.ships
    for (let i = 0; i < ships.count; i++) ships.alive[i] = 0
    const foe = state.divisions.find((division) => division.side === 1)
    const own = state.divisions.find((division) => division.side === 0)
    const wing = state.divisions.find((division) => division.side === 0 && division !== own)
    if (!foe || !own || !wing) throw new Error('division')
    for (const division of state.divisions) division.alive = 0
    foe.alive = 10
    own.alive = 1
    wing.alive = 1
    foe.ax = 500
    foe.ay = 0
    foe.fx = -1
    foe.fy = 0
    foe.classId = 'battleship'
    own.ax = 0
    own.ay = 0
    wing.ax = 0
    wing.ay = 700
    ships.alive[0] = 1
    ships.side[0] = 0
    ships.division[0] = state.divisions.indexOf(own)
    ships.x[0] = 0
    ships.y[0] = 0
    ships.alive[1] = 1
    ships.side[1] = 0
    ships.division[1] = state.divisions.indexOf(wing)
    ships.x[1] = 0
    ships.y[1] = 700
    markUnderFire(state)
    expect(shipUnderFire(0)).toBe(true)
    expect(shipUnderFire(1)).toBe(false)
  })
})
