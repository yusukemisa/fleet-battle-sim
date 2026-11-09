import { describe, expect, it } from 'vitest'
import { collectNear, createSpatialHash, fillSpatialHash } from './spatial.ts'

describe('spatial hash', () => {
  it('finds every neighbor inside the radius and skips the rest', () => {
    const count = 64
    const hash = createSpatialHash(count, 50)
    const x = new Float32Array(count)
    const y = new Float32Array(count)
    const alive = new Uint8Array(count)
    for (let i = 0; i < count; i++) {
      x[i] = (i % 8) * 40 - 20
      y[i] = Math.floor(i / 8) * 40 - 100
      alive[i] = i === 7 ? 0 : 1
    }
    fillSpatialHash(hash, x, y, alive, count)
    const n = collectNear(hash, 0, 0, 70, x, y)
    const found = new Set<number>()
    for (let i = 0; i < n; i++) found.add(hash.found[i] ?? -1)
    for (let i = 0; i < count; i++) {
      const dx = (x[i] ?? 0) - 0
      const dy = (y[i] ?? 0) - 0
      const inside = alive[i] === 1 && dx * dx + dy * dy <= 70 * 70
      expect(found.has(i)).toBe(inside)
    }
    fillSpatialHash(hash, x, y, alive, count)
    const again = collectNear(hash, 0, 0, 70, x, y)
    expect(again).toBe(n)
  })
})
