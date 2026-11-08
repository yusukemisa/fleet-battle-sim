import puppeteer from 'puppeteer-core'

const url = 'http://127.0.0.1:43173/'
const counts = [100, 1000, 10000]
const rounds = 5
const shots = [
  ['kakuyoku', 'kakuyoku', 'screenshot_kakuyoku.png'],
  ['engetsu', 'engetsu', 'screenshot_engetsu.png'],
  ['gyorin', 'gyorin', 'screenshot_gyorin.png'],
  ['hoshi', 'hoshi', 'screenshot_hoshi.png'],
  ['houen', 'houen', 'screenshot_houen.png'],
]

const browser = await puppeteer.launch({
  executablePath: '/usr/local/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--window-size=1440,900'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
await page.goto(url, { waitUntil: 'networkidle0' })
await page.waitForFunction(() => window.__battle && window.__battle.phase === 'setup')

const trials = []
for (let round = 0; round < rounds; round++) {
  for (const count of counts) {
    const trial = await page.evaluate(async (shipCount) => {
      const battle = window.__battle
      battle.command({ type: 'reset' })
      battle.command({ type: 'set-ship-count', count: shipCount })
      battle.command({ type: 'set-formation', side: 0, formationId: 'kakuyoku' })
      battle.command({ type: 'set-formation', side: 1, formationId: 'hoshi' })
      battle.command({ type: 'start' })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      battle.samples.length = 0
      const aliveBefore = battle.alive.slice()
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const samples = battle.samples.slice()
      return {
        shipCount,
        phase: battle.phase,
        aliveBefore,
        alive: battle.alive.slice(),
        lost: battle.lost.slice(),
        samples,
      }
    }, count)
    trials.push(trial)
  }
}

await page.evaluate(() => window.__battle.command({ type: 'reset' }))
for (const [left, right, name] of shots) {
  await page.evaluate(
    (pair) => {
      window.__battle.command({ type: 'reset' })
      window.__battle.command({ type: 'set-ship-count', count: 1000 })
      window.__battle.command({ type: 'set-formation', side: 0, formationId: pair[0] })
      window.__battle.command({ type: 'set-formation', side: 1, formationId: pair[1] })
    },
    [left, right],
  )
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.screenshot({ path: `/opt/cursor/artifacts/${name}` })
}

await page.evaluate(() => {
  window.__battle.command({ type: 'reset' })
  window.__battle.command({ type: 'set-ship-count', count: 1000 })
  window.__battle.command({ type: 'set-formation', side: 0, formationId: 'kakuyoku' })
  window.__battle.command({ type: 'set-formation', side: 1, formationId: 'hoshi' })
  window.__battle.command({ type: 'start' })
})
await new Promise((resolve) => setTimeout(resolve, 1200))
await page.screenshot({ path: '/opt/cursor/artifacts/screenshot_battle.png' })

await page.evaluate(() => {
  window.__battle.command({ type: 'reset' })
  window.__battle.command({ type: 'set-ship-count', count: 10000 })
  window.__battle.command({ type: 'set-formation', side: 0, formationId: 'kakuyoku' })
  window.__battle.command({ type: 'set-formation', side: 1, formationId: 'hoshi' })
  window.__battle.command({ type: 'start' })
})
await new Promise((resolve) => setTimeout(resolve, 1200))
await page.screenshot({ path: '/opt/cursor/artifacts/screenshot_battle_10000.png' })

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

const summary = counts.map((count) => {
  const rows = trials.filter((trial) => trial.shipCount === count)
  const frames = rows.flatMap((trial) => trial.samples.map((sample) => sample.frame))
  const sims = rows.flatMap((trial) => trial.samples.map((sample) => sample.sim))
  const draws = rows.flatMap((trial) => trial.samples.map((sample) => sample.draw))
  const losses = rows.map((trial) => trial.lost[0] + trial.lost[1])
  return {
    count,
    runs: rows.length,
    frames: frames.length,
    frameMs: { median: median(frames), min: Math.min(...frames), max: Math.max(...frames) },
    simMs: { median: median(sims), min: Math.min(...sims), max: Math.max(...sims) },
    drawMs: { median: median(draws), min: Math.min(...draws), max: Math.max(...draws) },
    losses,
    phases: rows.map((trial) => trial.phase),
  }
})

console.log(JSON.stringify({ errors, summary }, null, 2))
await browser.close()
