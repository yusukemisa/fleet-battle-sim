import { SLOT_PITCH } from './balance.ts'

/** Slot spacing. A 500-ship fleet stays on the minimum. Larger fleets extend their wings. */
function formationPitch(ships: number): number {
  const scale = Math.sqrt(Math.max(ships, 1) / 500)
  return SLOT_PITCH * Math.min(1.85, Math.max(1, scale))
}
import type { Formation, FormationId, FormationLayout } from './types.ts'

const GOLDEN = Math.PI * (3 - Math.sqrt(5))

function band(u: number): number {
  if (u < 0.2) return 0
  if (u < 0.4) return 1
  if (u < 0.6) return 2
  if (u < 0.8) return 3
  return 4
}

function recenter(layout: FormationLayout): void {
  let sx = 0
  let sy = 0
  const n = layout.count
  for (let i = 0; i < n; i++) {
    sx += layout.x[i]
    sy += layout.y[i]
  }
  sx /= n
  sy /= n
  for (let i = 0; i < n; i++) {
    layout.x[i] -= sx
    layout.y[i] -= sy
  }
}

function assignByX(layout: FormationLayout): void {
  const n = layout.count
  const order = new Array<number>(n)
  for (let i = 0; i < n; i++) order[i] = i
  order.sort((a, b) => layout.x[a] - layout.x[b] || a - b)
  const base = Math.floor(n / 5)
  let extra = n % 5
  let cursor = 0
  for (let group = 0; group < 5; group++) {
    const size = base + (extra > 0 ? 1 : 0)
    if (extra > 0) extra -= 1
    for (let k = 0; k < size; k++) {
      const ship = order[cursor]
      if (ship === undefined) break
      layout.division[ship] = group
      cursor += 1
    }
  }
}

function placeOujin(layout: FormationLayout): void {
  const n = layout.count
  const groups = 5
  const base = Math.floor(n / groups)
  let extra = n % groups
  const sizes: number[] = []
  for (let group = 0; group < groups; group++) {
    const size = base + (extra > 0 ? 1 : 0)
    if (extra > 0) extra -= 1
    sizes.push(size)
  }
  const pitch = Math.max(formationPitch(n), n > 400 ? SLOT_PITCH : SLOT_PITCH + 2)
  const wide = n > 800
  const gap = pitch * (wide ? 3.8 : 2.4)
  const specs = sizes.map((size) => {
    const cols = Math.max(1, Math.ceil(wide ? size / 4 : Math.sqrt(size * 1.35)))
    const rows = Math.max(1, Math.ceil(size / cols))
    return { size, cols, rows, width: Math.max(0, cols - 1) * pitch }
  })
  let span = gap * (groups - 1)
  for (const spec of specs) span += spec.width
  let left = -span / 2
  let ship = 0
  for (const spec of specs) {
    const origin = left + spec.width / 2
    left += spec.width + gap
    const depth = Math.max(0, spec.rows - 1) * pitch
    for (let k = 0; k < spec.size; k++) {
      const row = Math.floor(k / spec.cols)
      const col = k % spec.cols
      const rowCount = Math.min(spec.cols, spec.size - row * spec.cols)
      const stagger = row % 2 === 0 ? 0 : pitch * 0.5
      layout.x[ship] = origin + (col - (rowCount - 1) / 2) * pitch + stagger
      layout.y[ship] = depth / 2 - row * pitch
      layout.division[ship] = 0
      ship += 1
    }
  }
}

function placeKakuyoku(layout: FormationLayout): void {
  const n = layout.count
  const left = Math.floor(n / 2)
  const arms = [left, n - left]
  let written = 0
  for (let arm = 0; arm < 2; arm++) {
    const sign = arm === 0 ? -1 : 1
    const take = arms[arm] ?? 0
    const pitch = formationPitch(n)
    const thickPitch = pitch
    let ranks = n <= 800 ? (n > 200 ? 6 : 3) : 4
    let along = Math.max(1, Math.ceil(take / Math.max(1, ranks)))
    let length = n <= 800 ? Math.max(Math.hypot(390, 470), pitch * Math.max(along - 1, 1)) : pitch * Math.max(along - 1, 1)
    const dxAbs = n > 800 ? 780 : 390
    const dyAbs = n > 800 ? 260 : 470
    if (n > 800) {
      const share = dyAbs / Math.hypot(dxAbs, dyAbs)
      while (length * share > 980 && ranks < 30) {
        ranks += 2
        along = Math.max(1, Math.ceil(take / ranks))
        length = pitch * Math.max(along - 1, 1)
      }
    }
    const dx = sign * dxAbs
    const dy = dyAbs
    const len = Math.hypot(dx, dy)
    const px = -dy / len
    const py = dx / len
    const halfBand = ((ranks - 1) * thickPitch) / 2
    const hinge = Math.max(SLOT_PITCH, n <= 800 ? 0 : halfBand + thickPitch)
    for (let i = 0; i < take; i++) {
      const rank = i % ranks
      const step = Math.floor(i / ranks)
      const u = along <= 1 ? 1 : (step + arm * 0.5) / (along - 1)
      const thick = (rank - (ranks - 1) / 2) * thickPitch
      layout.x[written] = sign * hinge + (dx / len) * (u * length) + px * thick
      layout.y[written] = (dy / len) * (u * length) + py * thick
      layout.division[written] = sign < 0 ? 0 : 4
      written += 1
    }
  }
}

function placeEngetsu(layout: FormationLayout): void {
  const n = layout.count
  const command = Math.max(5, Math.round(n * 0.18))
  const wing = n - command
  const classic = n <= 800
  const ranks = classic
    ? Math.max(2, Math.min(18, Math.round(Math.sqrt(wing) / 2.4)))
    : Math.max(2, Math.round(Math.sqrt(wing) / 2.6))
  const per = Math.ceil(wing / ranks)
  const arc = Math.PI * 0.78
  const shipGap = Math.max(formationPitch(n), n > 400 ? SLOT_PITCH : SLOT_PITCH + 2)
  const gap = Math.max(classic ? SLOT_PITCH / 0.45 : SLOT_PITCH, classic ? 460 / per : shipGap)
  const radius = (gap * Math.max(per - 1, 1)) / arc
  for (let i = 0; i < wing; i++) {
    const rank = i % ranks
    const along = Math.floor(i / ranks)
    const t = per === 1 ? 0.5 : along / (per - 1)
    const centered = t - 0.5
    const u = classic
      ? 0.5 + Math.sign(centered) * Math.pow(Math.abs(centered) * 2, 1.35) / 2
      : t
    const ang = (u - 0.5) * arc
    if (classic) {
      const r = radius + rank * gap
      layout.x[i] = Math.sin(ang) * r * 1.12
      layout.y[i] = Math.cos(ang) * radius * 0.72 - rank * gap
    } else {
      const r = radius + rank * gap * 1.35
      layout.x[i] = Math.sin(ang) * r
      layout.y[i] = Math.cos(ang) * r * 0.82
    }
    layout.division[i] = band(u)
  }
  const cols = Math.max(3, Math.round(Math.sqrt(command * 1.4)))
  const pitch = Math.max(SLOT_PITCH, classic ? 220 / cols : shipGap)
  const rowPitch = Math.max(SLOT_PITCH, pitch * 0.92)
  for (let i = 0; i < command; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const at = wing + i
    const stagger = row % 2 === 0 ? 0 : pitch * 0.5
    layout.x[at] = (col - (cols - 1) / 2) * pitch + stagger
    layout.y[at] = -radius * 0.42 - row * rowPitch
    layout.division[at] = 2
  }
}

function placeGyorin(layout: FormationLayout): void {
  const n = layout.count
  const shipsPerScale = Math.max(6, Math.min(22, Math.round(Math.sqrt(n) / 1.6)))
  let scales = Math.max(6, Math.round(n / shipsPerScale))
  let rows = 1
  while ((rows * (rows + 1)) / 2 < scales) rows += 1
  scales = (rows * (rows + 1)) / 2
  const counts = new Array<number>(scales).fill(Math.floor(n / scales))
  let leftover = n - counts[0]! * scales
  for (let s = 0; leftover > 0; s = (s + 1) % scales) {
    counts[s] = (counts[s] ?? 0) + 1
    leftover -= 1
  }
  const growth = Math.sqrt(Math.max(n, 500) / 500)
  const rawPitch = (520 / Math.max(rows, 1)) * growth
  const perScale = Math.max(...counts, 1)
  const disk =
    n > 800
      ? Math.max(formationPitch(n), SLOT_PITCH * Math.sqrt(perScale))
      : Math.max(rawPitch * 0.3, SLOT_PITCH * Math.sqrt(perScale))
  const pitch = Math.max(rawPitch, disk * 2.2)
  const rowGap = Math.max(rawPitch * 0.9, disk * 2.05)
  const frontY = ((rows - 1) * rowGap) / 2
  let ship = 0
  let scale = 0
  for (let row = 0; row < rows; row++) {
    const cols = row + 1
    const y = frontY - row * rowGap
    for (let col = 0; col < cols; col++) {
      const cx = (col - (cols - 1) / 2) * pitch
      const take = Math.min(counts[scale] ?? 0, n - ship)
      for (let k = 0; k < take; k++) {
        const ang = k * GOLDEN
        const spread = Math.max(disk, SLOT_PITCH * Math.sqrt(Math.max(take, 1)))
        const rr = spread * Math.sqrt((k + 0.5) / Math.max(take, 1))
        layout.x[ship] = cx + Math.cos(ang) * rr
        layout.y[ship] = y + Math.sin(ang) * rr * 0.78
        layout.division[ship] = band((col + 0.5) / cols)
        ship += 1
      }
      scale += 1
    }
  }
}

function placeHoshi(layout: FormationLayout): void {
  const n = layout.count
  const scale = Math.sqrt(Math.max(n, 500) / 500)
  const rows = scale === 1
    ? Math.max(6, Math.min(42, Math.round(Math.sqrt(n))))
    : Math.max(6, Math.round(Math.sqrt(n) * 1.2))
  const length = 520 * scale
  const baseHalf = 230 * scale
  const weight = new Array<number>(rows)
  let sum = 0
  for (let r = 0; r < rows; r++) {
    const t = rows === 1 ? 1 : r / (rows - 1)
    const w = Math.max(0.45, Math.pow(t, 0.85))
    weight[r] = w
    sum += w
  }
  let ship = 0
  for (let r = 0; r < rows; r++) {
    const t = rows === 1 ? 1 : r / (rows - 1)
    const share = r === rows - 1 ? n - ship : Math.max(1, Math.round((n * (weight[r] ?? 1)) / sum))
    const take = Math.min(Math.max(share, 0), n - ship)
    const rowPitch = n > 800 ? formationPitch(n) : SLOT_PITCH
    const fitted = ((take - 1) * rowPitch) / 2
    const half = Math.max(2, baseHalf * Math.pow(Math.max(t, 0.04), 0.9), fitted)
    const yStep = Math.max(rowPitch, length / Math.max(rows - 1, 1))
    const y = (rows - 1) * yStep * 0.46 - t * (rows - 1) * yStep
    for (let k = 0; k < take; k++) {
      const u = take === 1 ? 0.5 : k / (take - 1)
      layout.x[ship] = (u - 0.5) * 2 * half
      layout.y[ship] = y
      layout.division[ship] = 2
      ship += 1
    }
    if (ship >= n) break
  }
}

function ringRadii(count: number): number[] {
  const radii: number[] = []
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 1 : i / (count - 1)
    radii.push(120 + t * 190)
  }
  return radii
}

function placeHouen(layout: FormationLayout): void {
  const n = layout.count
  const innerCount = Math.max(5, Math.round(n * 0.16))
  const outerCount = n - innerCount
  const scale = Math.sqrt(Math.max(n, 500) / 500)
  const packedCore = SLOT_PITCH * Math.sqrt(innerCount / Math.PI) * 1.05
  const innerR = Math.max(42 * scale * (scale > 1 ? 1.4 : 1), packedCore)
  for (let i = 0; i < innerCount; i++) {
    const ang = i * GOLDEN
    const rr = innerR * Math.sqrt((i + 0.5) / innerCount)
    layout.x[i] = Math.cos(ang) * rr
    layout.y[i] = Math.sin(ang) * rr
    layout.division[i] = 2
  }
  const ringCount = scale > 1 ? Math.min(7, Math.max(4, Math.round(4 + Math.log2(scale)))) : n > 2000 ? 4 : n > 180 ? 3 : 2
  const ringBase = ringCount <= 2 ? [150, 250] : ringCount === 3 ? [130, 190, 255] : ringRadii(ringCount)
  let radii = ringBase.map((radius) => radius * scale)
  const coreClear = innerR + SLOT_PITCH
  if ((radii[0] ?? 0) < coreClear) {
    const grow = coreClear / Math.max(radii[0] ?? 1, 1)
    radii = radii.map((radius) => radius * grow)
  }
  const weight0 = radii.reduce((sum, radius) => sum + radius, 0)
  let tight = Infinity
  let left = outerCount
  for (let ring = 0; ring < radii.length; ring++) {
    const radius = radii[ring] ?? 1
    const share = ring === radii.length - 1 ? left : Math.max(1, Math.round((outerCount * radius) / weight0))
    const take = Math.min(share, left)
    left -= take
    tight = Math.min(tight, (2 * Math.PI * radius) / Math.max(1, take))
  }
  const ringPitch = formationPitch(n)
  if (tight < ringPitch && tight > 0) radii = radii.map((radius) => radius * (ringPitch / tight))
  const weight = radii.reduce((sum, r) => sum + r, 0)
  let ship = innerCount
  const outerIndex = new Array<number>(outerCount)
  for (let ring = 0; ring < radii.length; ring++) {
    const radius = radii[ring] ?? 200
    const share =
      ring === radii.length - 1
        ? n - ship
        : Math.max(1, Math.round((outerCount * radius) / weight))
    const take = Math.min(share, n - ship)
    for (let k = 0; k < take; k++) {
      const ang = (k / take) * Math.PI * 2 + ring * 0.37
      const at = ship
      layout.x[at] = Math.cos(ang) * radius
      layout.y[at] = Math.sin(ang) * radius
      layout.division[at] = 0
      outerIndex[at - innerCount] = at
      ship += 1
    }
  }
  const outer = outerIndex.filter((index) => index !== undefined)
  outer.sort((a, b) => layout.x[a]! - layout.x[b]! || a - b)
  const slots = [0, 1, 3, 4]
  const base = Math.floor(outer.length / 4)
  let extra = outer.length % 4
  let cursor = 0
  for (let g = 0; g < 4; g++) {
    const size = base + (extra > 0 ? 1 : 0)
    if (extra > 0) extra -= 1
    const division = slots[g] ?? 0
    for (let k = 0; k < size; k++) {
      const shipIndex = outer[cursor]
      if (shipIndex === undefined) break
      layout.division[shipIndex] = division
      cursor += 1
    }
  }
}

function finishLateral(place: (layout: FormationLayout) => void): (layout: FormationLayout) => void {
  return (layout) => {
    place(layout)
    assignByX(layout)
    recenter(layout)
  }
}

function finishRadial(place: (layout: FormationLayout) => void): (layout: FormationLayout) => void {
  return (layout) => {
    place(layout)
    recenter(layout)
  }
}

export const FORMATIONS = {
  oujin: {
    id: 'oujin',
    name: '横陣',
    summary: '五つの分艦隊を横一列に並べる。各隊は塊で、艦首は敵を向く。',
    place: finishLateral(placeOujin),
  },
  kakuyoku: {
    id: 'kakuyoku',
    name: '鶴翼',
    summary: '敵に向かって開いた弧。翼が前に出て包み込む。',
    place: finishLateral(placeKakuyoku),
  },
  engetsu: {
    id: 'engetsu',
    name: '偃月',
    summary: '敵側へ膨らむ弧。中央が厚く、大将は後方中央。',
    place: finishLateral(placeEngetsu),
  },
  gyorin: {
    id: 'gyorin',
    name: '魚鱗',
    summary: '敵を指す三角。小さな塊を鱗のように重ねる。',
    place: finishLateral(placeGyorin),
  },
  hoshi: {
    id: 'hoshi',
    name: '鋒矢',
    summary: '細く長い矢じり。先端で一点を突く。',
    place: finishLateral(placeHoshi),
  },
  houen: {
    id: 'houen',
    name: '方円',
    summary: '大将を中心に円く囲む。全方位の防御。',
    place: finishRadial(placeHouen),
  },
} satisfies Record<FormationId, Formation>

/** Lateral half-width and how far the nose reaches toward the enemy. */
export function formationExtent(id: FormationId, count: number): { halfY: number; forward: number } {
  if (count <= 0) return { halfY: 0, forward: 0 }
  const layout = layoutFormation(id, count)
  let halfY = 0
  let forward = 0
  for (let i = 0; i < count; i++) {
    halfY = Math.max(halfY, Math.abs(layout.x[i] ?? 0))
    forward = Math.max(forward, layout.y[i] ?? 0)
  }
  return { halfY, forward }
}

/** Push any pair closer than the slot pitch apart, without a per-frame cost. */
function spreadSlots(layout: FormationLayout): void {
  const n = layout.count
  const minDist = SLOT_PITCH
  const minSq = minDist * minDist
  const cell = minDist
  for (let pass = 0; pass < 6; pass++) {
    const bins = new Map<string, number[]>()
    for (let i = 0; i < n; i++) {
      const key = `${Math.floor((layout.x[i] ?? 0) / cell)},${Math.floor((layout.y[i] ?? 0) / cell)}`
      const list = bins.get(key)
      if (list) list.push(i)
      else bins.set(key, [i])
    }
    const pushX = new Float32Array(n)
    const pushY = new Float32Array(n)
    let moved = false
    for (let i = 0; i < n; i++) {
      const x = layout.x[i] ?? 0
      const y = layout.y[i] ?? 0
      const cx = Math.floor(x / cell)
      const cy = Math.floor(y / cell)
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const list = bins.get(`${cx + ox},${cy + oy}`)
          if (!list) continue
          for (const j of list) {
            if (j <= i) continue
            let dx = (layout.x[j] ?? 0) - x
            let dy = (layout.y[j] ?? 0) - y
            const d2 = dx * dx + dy * dy
            if (d2 >= minSq) continue
            let dist = Math.sqrt(d2)
            if (dist < 1e-4) {
              dx = i % 2 === 0 ? 1 : -1
              dy = 0.2
              dist = Math.hypot(dx, dy)
            }
            const push = (minDist - dist) / 2
            const nx = (dx / dist) * push
            const ny = (dy / dist) * push
            pushX[i] = (pushX[i] ?? 0) - nx
            pushY[i] = (pushY[i] ?? 0) - ny
            pushX[j] = (pushX[j] ?? 0) + nx
            pushY[j] = (pushY[j] ?? 0) + ny
            moved = true
          }
        }
      }
    }
    if (!moved) break
    for (let i = 0; i < n; i++) {
      layout.x[i] = (layout.x[i] ?? 0) + (pushX[i] ?? 0)
      layout.y[i] = (layout.y[i] ?? 0) + (pushY[i] ?? 0)
    }
  }
}

export function layoutFormation(id: FormationId, count: number): FormationLayout {
  const layout: FormationLayout = {
    count,
    x: new Float32Array(count),
    y: new Float32Array(count),
    division: new Uint8Array(count),
  }
  FORMATIONS[id].place(layout)
  spreadSlots(layout)
  return layout
}
