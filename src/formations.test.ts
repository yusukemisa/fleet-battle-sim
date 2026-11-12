import { describe, expect, it } from 'vitest'
import { HULL_RADIUS, SLOT_PITCH } from './balance.ts'
import { layoutFormation } from './formations.ts'
import type { FormationId, FormationLayout } from './types.ts'

const IDS: FormationId[] = ['oujin', 'kakuyoku', 'engetsu', 'gyorin', 'hoshi', 'houen']

function finite(layout: FormationLayout): boolean {
  for (let i = 0; i < layout.count; i++) {
    if (!Number.isFinite(layout.x[i]) || !Number.isFinite(layout.y[i])) return false
  }
  return true
}

function divisionCounts(layout: FormationLayout): number[] {
  const counts = [0, 0, 0, 0, 0]
  for (let i = 0; i < layout.count; i++) {
    const slot = layout.division[i] ?? 0
    if (slot >= 0 && slot < 5) counts[slot] = (counts[slot] ?? 0) + 1
  }
  return counts
}

function bandBox(layout: FormationLayout, slot: number): { minX: number; maxX: number; minY: number; maxY: number; meanX: number } | null {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let sumX = 0
  let n = 0
  for (let i = 0; i < layout.count; i++) {
    if (layout.division[i] !== slot) continue
    const x = layout.x[i] ?? 0
    const y = layout.y[i] ?? 0
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    sumX += x
    n += 1
  }
  if (n === 0) return null
  return { minX, maxX, minY, maxY, meanX: sumX / n }
}

function bounds(layout: FormationLayout): { width: number; depth: number } {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < layout.count; i++) {
    const x = layout.x[i] ?? 0
    const y = layout.y[i] ?? 0
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { width: maxX - minX, depth: maxY - minY }
}

function minSpacing(layout: FormationLayout): number {
  const stride = Math.max(1, Math.floor(layout.count / 240))
  let best = Infinity
  for (let i = 0; i < layout.count; i += stride) {
    const x = layout.x[i] ?? 0
    const y = layout.y[i] ?? 0
    let near = Infinity
    for (let j = 0; j < layout.count; j++) {
      if (i === j) continue
      const d = Math.hypot(x - (layout.x[j] ?? 0), y - (layout.y[j] ?? 0))
      if (d > 0 && d < near) near = d
    }
    if (near < best) best = near
  }
  return best
}

function xRange(layout: FormationLayout, pick: (index: number) => boolean): number {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < layout.count; i++) {
    if (!pick(i)) continue
    const x = layout.x[i] ?? 0
    if (x < min) min = x
    if (x > max) max = x
  }
  return max - min
}

describe('formations', () => {
  it.each(IDS)('%s places every ship into all five divisions', (id) => {
    for (const count of [50, 500, 5000]) {
      const layout = layoutFormation(id, count)
      expect(layout.count).toBe(count)
      expect(finite(layout)).toBe(true)
      const counts = divisionCounts(layout)
      expect(counts.reduce((sum, n) => sum + n, 0)).toBe(count)
      for (const n of counts) expect(n).toBeGreaterThan(0)
    }
  })

  it('横陣 lines five compact blocks abreast', () => {
    for (const count of [50, 500, 5000]) {
      const layout = layoutFormation('oujin', count)
      const bands = [0, 1, 2, 3, 4].map((slot) => bandBox(layout, slot))
      for (let i = 0; i < 4; i++) {
        const left = bands[i]
        const right = bands[i + 1]
        expect(left).toBeDefined()
        expect(right).toBeDefined()
        if (!left || !right) continue
        expect(left.meanX).toBeLessThan(right.meanX)
        expect(left.maxX).toBeLessThan(right.minX)
      }
      const first = bands[0]
      const last = bands[4]
      expect(first).toBeDefined()
      expect(last).toBeDefined()
      if (!first || !last) continue
      const line = last.maxX - first.minX
      let depth = 0
      for (const band of bands) {
        if (!band) continue
        depth = Math.max(depth, band.maxY - band.minY)
        expect(Math.max(band.maxX - band.minX, band.maxY - band.minY)).toBeLessThan(line * 0.35)
      }
      expect(line).toBeGreaterThan(depth * 3)
    }
  })

  it('鶴翼 puts the wings forward of the center', () => {
    const layout = layoutFormation('kakuyoku', 500)
    const abs = Array.from(layout.x, (x) => Math.abs(x)).sort((a, b) => a - b)
    const low = abs[Math.floor(layout.count * 0.2)] ?? 0
    const high = abs[Math.floor(layout.count * 0.75)] ?? 0
    let wingY = 0
    let wingN = 0
    let centerY = 0
    let centerN = 0
    for (let i = 0; i < layout.count; i++) {
      const ax = Math.abs(layout.x[i] ?? 0)
      const y = layout.y[i] ?? 0
      if (ax >= high) {
        wingY += y
        wingN += 1
      } else if (ax <= low) {
        centerY += y
        centerN += 1
      }
    }
    expect(wingN).toBeGreaterThan(0)
    expect(centerN).toBeGreaterThan(0)
    expect(wingY / wingN).toBeGreaterThan(centerY / centerN + 80)
  })

  it('偃月 bulges toward the enemy and keeps the commander behind the center', () => {
    const layout = layoutFormation('engetsu', 500)
    let tip = 0
    let maxAbs = 0
    for (let i = 0; i < layout.count; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(layout.x[i] ?? 0))
      if ((layout.y[i] ?? 0) > (layout.y[tip] ?? 0)) tip = i
    }
    expect(Math.abs(layout.x[tip] ?? 0)).toBeLessThan(maxAbs * 0.3)
    const order = Array.from({ length: layout.count }, (_, i) => i).sort(
      (a, b) => (layout.y[a] ?? 0) - (layout.y[b] ?? 0),
    )
    const rearN = Math.floor(layout.count * 0.12)
    let rearAbs = 0
    for (let i = 0; i < rearN; i++) rearAbs += Math.abs(layout.x[order[i] ?? 0] ?? 0)
    expect(rearAbs / rearN).toBeLessThan(maxAbs * 0.4)
  })

  it('魚鱗 and 鋒矢 are narrower at the tip than at the base', () => {
    for (const id of ['gyorin', 'hoshi'] as const) {
      const layout = layoutFormation(id, 500)
      const ys = Array.from(layout.y).sort((a, b) => a - b)
      const backCut = ys[Math.floor(layout.count * 0.15)] ?? 0
      const frontCut = ys[Math.floor(layout.count * 0.85)] ?? 0
      const back = xRange(layout, (i) => (layout.y[i] ?? 0) <= backCut)
      const front = xRange(layout, (i) => (layout.y[i] ?? 0) >= frontCut)
      expect(front * 1.6).toBeLessThan(back)
    }
  })

  it('鋒矢 is one solid arrowhead, narrower than the fish-scale triangle', () => {
    const hoshi = layoutFormation('hoshi', 500)
    const gyorin = layoutFormation('gyorin', 500)
    const width = (layout: FormationLayout) => xRange(layout, () => true)
    expect(width(hoshi)).toBeLessThan(width(gyorin))
    expect(width(hoshi)).toBeGreaterThan(280)
  })

  it('grows large fleets instead of packing them into a hairline', () => {
    for (const id of ['oujin', 'kakuyoku', 'engetsu', 'gyorin', 'hoshi', 'houen'] as const) {
      const small = layoutFormation(id, 500)
      const large = layoutFormation(id, 5000)
      const smallBox = bounds(small)
      const largeBox = bounds(large)
      expect(largeBox.width, id).toBeGreaterThan(smallBox.width * 1.4)
      expect(largeBox.depth, id).toBeGreaterThan(smallBox.depth * 1.4)
      expect(minSpacing(large), id).toBeGreaterThan(7)
    }
  })

  it('keeps every slot outside the largest hull', () => {
    const need = HULL_RADIUS[0] * 2 + 4
    expect(SLOT_PITCH).toBeGreaterThan(need)
    for (const id of IDS) {
      for (const count of [50, 100, 500]) {
        const layout = layoutFormation(id, count)
        let best = Infinity
        for (let i = 0; i < layout.count; i++) {
          for (let j = i + 1; j < layout.count; j++) {
            const d = Math.hypot((layout.x[i] ?? 0) - (layout.x[j] ?? 0), (layout.y[i] ?? 0) - (layout.y[j] ?? 0))
            if (d < best) best = d
          }
        }
        expect(best, `${id} ${count}`).toBeGreaterThanOrEqual(18)
      }
    }
  })

  it('方円 keeps a commander group inside a ring', () => {
    const layout = layoutFormation('houen', 500)
    let maxR = 0
    for (let i = 0; i < layout.count; i++) {
      maxR = Math.max(maxR, Math.hypot(layout.x[i] ?? 0, layout.y[i] ?? 0))
    }
    let inner = 0
    let innerCommand = 0
    let outer = 0
    for (let i = 0; i < layout.count; i++) {
      const r = Math.hypot(layout.x[i] ?? 0, layout.y[i] ?? 0)
      if (r < maxR * 0.28) {
        inner += 1
        if (layout.division[i] === 2) innerCommand += 1
      }
      if (r > maxR * 0.62) outer += 1
    }
    expect(inner).toBeGreaterThan(layout.count * 0.08)
    expect(innerCommand).toBeGreaterThan(inner * 0.7)
    expect(outer).toBeGreaterThan(layout.count * 0.4)
  })
})
