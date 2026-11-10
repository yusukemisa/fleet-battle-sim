import { spawn } from 'node:child_process'
import { createSim, dispatch } from '../src/sim.ts'

const FORMATIONS = ['oujin', 'kakuyoku', 'engetsu', 'gyorin', 'hoshi', 'houen']
const NAMES = { oujin: '横陣', kakuyoku: '鶴翼', engetsu: '偃月', gyorin: '魚鱗', hoshi: '鋒矢', houen: '方円', fierce: '猛将', cunning: '智将', guard: '守将', balanced: '常勝' }
const FOES = ['fierce', 'cunning', 'guard']
const TUNING = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const HELDOUT = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110]
const TIMEOUT = 220

function argsOf(argv) {
  const out = { heldout: false, mirror: false, ships: 100, parallel: 4, shard: null, own: null, foe: null, form: null, limit: 0 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--heldout') out.heldout = true
    else if (arg === '--mirror') out.mirror = true
    else if (arg === '--ships') out.ships = Number(argv[++i])
    else if (arg === '--parallel') out.parallel = Number(argv[++i])
    else if (arg === '--shard') out.shard = argv[++i]
    else if (arg === '--own') out.own = argv[++i]
    else if (arg === '--foe') out.foe = argv[++i]
    else if (arg === '--form') out.form = argv[++i]
    else if (arg === '--limit') out.limit = Number(argv[++i])
  }
  return out
}

function battle(ownForm, foe, foeForm, seed, swap, ships) {
  const blue = swap ? foe : 'balanced'
  const red = swap ? 'balanced' : foe
  const formations = swap ? [foeForm, ownForm] : [ownForm, foeForm]
  let state = createSim({ shipCount: ships, commanders: [blue, red], formations })
  state.rng = seed | 0
  state = dispatch(state, { type: 'set-speed', speed: 4 })
  state = dispatch(state, { type: 'start' })
  let steps = 0
  while (state.phase.kind === 'running' && state.time < TIMEOUT && steps < 8000) {
    state = dispatch(state, { type: 'tick', dt: 0.05 })
    steps += 1
  }
  let winner = 'draw'
  if (state.phase.kind === 'finished') winner = state.phase.winner
  else if (state.alive[0] >= state.alive[1] * 1.2 && state.alive[0] - state.alive[1] >= 5) winner = 0
  else if (state.alive[1] >= state.alive[0] * 1.2 && state.alive[1] - state.alive[0] >= 5) winner = 1
  const joshouWon = swap ? winner === 1 : winner === 0
  return { win: joshouWon, draw: winner === 'draw', time: state.time }
}

function cellsOf(options) {
  const foes = options.mirror ? [...FOES, 'balanced'] : FOES
  const list = []
  for (const own of FORMATIONS) {
    if (options.own && options.own !== own) continue
    for (const foe of foes) {
      if (options.foe && options.foe !== foe) continue
      for (const form of FORMATIONS) {
        if (options.form && options.form !== form) continue
        list.push({ own, foe, form })
      }
    }
  }
  return options.limit > 0 ? list.slice(0, options.limit) : list
}

function runShard(options) {
  const seeds = options.heldout ? HELDOUT : TUNING
  const all = cellsOf(options)
  let cells = all
  if (options.shard) {
    const [index, count] = options.shard.split('/').map(Number)
    cells = all.filter((_, i) => i % count === index)
  }
  const rows = []
  let games = 0
  const started = Date.now()
  for (const cell of cells) {
    let wins = 0
    let draws = 0
    let time = 0
    for (const seed of seeds) {
      for (const swap of [false, true]) {
        const packed = (Math.imul(seed, 0x9e3779b1) + (swap ? 17 : 0)) | 0
        const row = battle(cell.own, cell.foe, cell.form, packed, swap, options.ships)
        games += 1
        time += row.time
        if (row.draw) draws += 1
        else if (row.win) wins += 1
      }
    }
    const played = seeds.length * 2
    rows.push({
      own: cell.own,
      foe: cell.foe,
      form: cell.form,
      wins,
      draws,
      games: played,
      rate: wins / played,
      time: time / played,
    })
    process.stderr.write(`${options.shard ?? 'all'} ${cell.own} ${cell.foe} ${cell.form} ${(wins / played).toFixed(2)}\n`)
  }
  const competitive = rows.filter((row) => row.foe !== 'balanced')
  const rates = competitive.map((row) => row.rate)
  const summary = {
    set: options.heldout ? 'heldout' : 'tuning',
    ships: options.ships,
    seeds: seeds.length,
    seconds: (Date.now() - started) / 1000,
    games,
    cells: rows,
    min: rates.length ? Math.min(...rates) : null,
    mean: rates.length ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : null,
    below: competitive.filter((row) => row.rate < 0.7).sort((a, b) => a.rate - b.rate),
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`)
}

function merge(parts) {
  const cells = parts.flatMap((part) => part.cells)
  const competitive = cells.filter((row) => row.foe !== 'balanced')
  const rates = competitive.map((row) => row.rate)
  return {
    set: parts[0]?.set,
    ships: parts[0]?.ships,
    seeds: parts[0]?.seeds,
    seconds: Math.max(...parts.map((part) => part.seconds)),
    games: parts.reduce((sum, part) => sum + part.games, 0),
    cells,
    min: rates.length ? Math.min(...rates) : null,
    mean: rates.length ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : null,
    below: competitive.filter((row) => row.rate < 0.7).sort((a, b) => a.rate - b.rate),
  }
}

function printHuman(summary) {
  const err = process.stderr
  err.write(`\n${summary.set} ${summary.ships} ships, ${summary.seeds} seeds, min ${(summary.min ?? 0).toFixed(2)} mean ${(summary.mean ?? 0).toFixed(2)} below ${summary.below.length} in ${summary.seconds.toFixed(0)}s\n`)
  for (const row of summary.below.slice(0, 15)) {
    err.write(`  ${NAMES[row.own]} vs ${NAMES[row.foe]} ${NAMES[row.form]} ${row.rate.toFixed(2)} (${row.wins}/${row.games})\n`)
  }
}

const options = argsOf(process.argv.slice(2))
if (options.shard || options.parallel <= 1) {
  runShard(options)
} else {
  const kids = []
  const forwarded = process.argv.slice(2).filter((arg, index, list) => arg !== '--parallel' && list[index - 1] !== '--parallel')
  for (let index = 0; index < options.parallel; index++) {
    kids.push(spawn('npx', ['vite-node', 'scripts/eval-joshou.mjs', ...forwarded, '--shard', `${index}/${options.parallel}`], {
      stdio: ['ignore', 'pipe', 'inherit'],
    }))
  }
  const parts = await Promise.all(kids.map((kid) => new Promise((resolve, reject) => {
    let text = ''
    kid.stdout.on('data', (chunk) => { text += chunk })
    kid.on('error', reject)
    kid.on('close', (code) => {
      if (code !== 0) reject(new Error(`shard exited ${code}`))
      else resolve(JSON.parse(text.trim().split('\n').at(-1)))
    })
  })))
  const summary = merge(parts)
  printHuman(summary)
  process.stdout.write(`${JSON.stringify(summary)}\n`)
}
