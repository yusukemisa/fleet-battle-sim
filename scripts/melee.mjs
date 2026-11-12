/**
 * Melee pressure in one headless battle: how close ships get, how often
 * hulls overlap, and what share of the hits land on a side or rear.
 *
 *   npx vite-node scripts/melee.mjs
 */
import { hullRadius } from '../src/balance.ts'
import { createSim, dispatch } from '../src/sim.ts'

function sample(state) {
  const ships = state.ships
  const cell = 24
  const grid = new Map()
  for (let i = 0; i < ships.count; i++) {
    if (ships.alive[i] === 0) continue
    const key = `${Math.floor((ships.x[i] ?? 0) / cell)},${Math.floor((ships.y[i] ?? 0) / cell)}`
    const bucket = grid.get(key)
    if (bucket) bucket.push(i)
    else grid.set(key, [i])
  }
  let nearest = 0
  let nearestN = 0
  let living = 0
  let overlapped = 0
  let enemyOverlap = 0
  const step = ships.count > 4000 ? 8 : 2
  const enemyStep = ships.count > 4000 ? 6 : 1
  for (let i = 0; i < ships.count; i += step) {
    if (ships.alive[i] === 0) continue
    living += 1
    const xi = ships.x[i] ?? 0
    const yi = ships.y[i] ?? 0
    const ri = hullRadius(ships.shipClass[i] ?? 0)
    const cx = Math.floor(xi / cell)
    const cy = Math.floor(yi / cell)
    let best = Infinity
    let touching = false
    let enemyTouch = false
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const bucket = grid.get(`${cx + ox},${cy + oy}`)
        if (!bucket) continue
        for (const j of bucket) {
          if (j === i) continue
          const dist = Math.hypot((ships.x[j] ?? 0) - xi, (ships.y[j] ?? 0) - yi)
          const hit = dist < ri + hullRadius(ships.shipClass[j] ?? 0)
          if (hit) touching = true
          if (hit && (ships.side[j] ?? 0) !== (ships.side[i] ?? 0)) enemyTouch = true
        }
      }
    }
    const side = ships.side[i] ?? 0
    for (let j = side === 0 ? ships.count / 2 : 0; j < (side === 0 ? ships.count : ships.count / 2); j += enemyStep) {
      if (ships.alive[j] === 0) continue
      const dist = Math.hypot((ships.x[j] ?? 0) - xi, (ships.y[j] ?? 0) - yi)
      if (dist < best) best = dist
    }
    if (best < Infinity) {
      nearest += best
      nearestN += 1
    }
    if (touching) overlapped += 1
    if (enemyTouch) enemyOverlap += 1
  }
  const front = (state.hits.front[0] ?? 0) + (state.hits.front[1] ?? 0)
  const side = (state.hits.side[0] ?? 0) + (state.hits.side[1] ?? 0)
  const rear = (state.hits.rear[0] ?? 0) + (state.hits.rear[1] ?? 0)
  const shots = front + side + rear
  const gun = (state.dealt[0] ?? 0) + (state.dealt[1] ?? 0)
  const ram = state.ram ?? 0
  return {
    time: Math.round(state.time * 10) / 10,
    nearest: nearestN ? Math.round(nearest / nearestN) : 0,
    overlap: living ? Math.round((overlapped / living) * 1000) / 1000 : 0,
    enemyOverlap: living ? Math.round((enemyOverlap / living) * 1000) / 1000 : 0,
    flank: shots ? Math.round(((side + rear) / shots) * 1000) / 1000 : 0,
    ramShare: gun + ram > 0 ? Math.round((ram / (gun + ram)) * 1000) / 1000 : 0,
    alive: (state.alive[0] ?? 0) + (state.alive[1] ?? 0),
  }
}

function battle(label, setup) {
  let state = createSim(setup)
  state.rng = 101
  state = dispatch(state, { type: 'set-speed', speed: 4 })
  state = dispatch(state, { type: 'start' })
  const rows = []
  let ticks = 0
  while (state.phase.kind === 'running' && state.time < 40 && ticks < 1200) {
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    ticks += 1
    if (state.time >= 10 && rows.length < Math.floor((state.time - 10) / 5)) rows.push(sample(state))
  }
  const last = sample(state)
  const mean = (key) => {
    const values = rows.length ? rows : [last]
    return Math.round((values.reduce((sum, row) => sum + row[key], 0) / values.length) * 1000) / 1000
  }
  const summary = {
    label,
    nearest: mean('nearest'),
    overlap: mean('overlap'),
    enemyOverlap: mean('enemyOverlap'),
    flank: mean('flank'),
    ramShare: mean('ramShare'),
    alive: last.alive,
    time: last.time,
  }
  console.log(JSON.stringify(summary))
  return summary
}

const base = { shipCount: 1000, formations: ['oujin', 'kakuyoku'] }
battle('rules 1000', { ...base, commanders: ['balanced', 'fierce'], brains: ['rule', 'rule'] })
battle('default 1000', { ...base, commanders: ['balanced', 'fierce'] })
battle('rules 10000', { shipCount: 10000, formations: ['oujin', 'kakuyoku'], commanders: ['balanced', 'fierce'], brains: ['rule', 'rule'] })
