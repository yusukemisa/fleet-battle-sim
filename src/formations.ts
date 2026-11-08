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

function placeKakuyoku(layout: FormationLayout): void {
  const n = layout.count
  const ranks = n > 2000 ? 11 : n > 200 ? 6 : 3
  const left = Math.floor(n / 2)
  const arms = [left, n - left]
  let written = 0
  for (let arm = 0; arm < 2; arm++) {
    const sign = arm === 0 ? -1 : 1
    const take = arms[arm] ?? 0
    const along = Math.max(1, Math.ceil(take / ranks))
    const dx = sign * 390
    const dy = 470
    const len = Math.hypot(dx, dy)
    const px = -dy / len
    const py = dx / len
    for (let i = 0; i < take; i++) {
      const rank = i % ranks
      const step = Math.floor(i / ranks)
      const u = along <= 1 ? 1 : step / (along - 1)
      const thick = (rank - (ranks - 1) / 2) * 6
      layout.x[written] = (dx / len) * (u * len) + px * thick
      layout.y[written] = (dy / len) * (u * len) + py * thick
      layout.division[written] = sign < 0 ? 0 : 4
      written += 1
    }
  }
}

function placeEngetsu(layout: FormationLayout): void {
  const n = layout.count
  const command = Math.max(5, Math.round(n * 0.18))
  const wing = n - command
  const ranks = Math.max(2, Math.min(18, Math.round(Math.sqrt(wing) / 2.4)))
  const per = Math.ceil(wing / ranks)
  const arc = Math.PI * 0.78
  const gap = 460 / per
  const radius = (gap * Math.max(per - 1, 1)) / arc
  for (let i = 0; i < wing; i++) {
    const rank = i % ranks
    const along = Math.floor(i / ranks)
    const t = per === 1 ? 0.5 : along / (per - 1)
    const centered = t - 0.5
    const u = 0.5 + Math.sign(centered) * Math.pow(Math.abs(centered) * 2, 1.35) / 2
    const ang = (u - 0.5) * arc
    const r = radius + rank * gap * 0.45
    layout.x[i] = Math.sin(ang) * r * 1.12
    layout.y[i] = Math.cos(ang) * radius * 0.72 - rank * gap * 0.35
    layout.division[i] = band(u)
  }
  const cols = Math.max(3, Math.round(Math.sqrt(command * 1.4)))
  const pitch = Math.min(18, 220 / cols)
  for (let i = 0; i < command; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const at = wing + i
    layout.x[at] = (col - (cols - 1) / 2) * pitch
    layout.y[at] = -radius * 0.42 - row * pitch * 0.92
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
  const pitch = 520 / Math.max(rows, 1)
  const disk = pitch * 0.3
  const rowGap = pitch * 0.9
  const frontY = ((rows - 1) * rowGap) / 2
  const counts = new Array<number>(scales).fill(Math.floor(n / scales))
  let leftover = n - counts[0]! * scales
  for (let s = 0; leftover > 0; s = (s + 1) % scales) {
    counts[s] = (counts[s] ?? 0) + 1
    leftover -= 1
  }
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
        const rr = disk * Math.sqrt((k + 0.5) / Math.max(take, 1))
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
  const rows = Math.max(6, Math.min(42, Math.round(Math.sqrt(n))))
  const length = 520
  const baseHalf = 230
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
    const half = Math.max(2, baseHalf * Math.pow(Math.max(t, 0.04), 0.9))
    const y = length * 0.46 - t * length
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

function placeHouen(layout: FormationLayout): void {
  const n = layout.count
  const innerCount = Math.max(5, Math.round(n * 0.16))
  const outerCount = n - innerCount
  const innerR = 42
  for (let i = 0; i < innerCount; i++) {
    const ang = i * GOLDEN
    const rr = innerR * Math.sqrt((i + 0.5) / innerCount)
    layout.x[i] = Math.cos(ang) * rr
    layout.y[i] = Math.sin(ang) * rr
    layout.division[i] = 2
  }
  const ringCount = n > 2000 ? 4 : n > 180 ? 3 : 2
  const radii = ringCount === 2 ? [150, 250] : ringCount === 3 ? [130, 190, 255] : [120, 165, 210, 260]
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

export function layoutFormation(id: FormationId, count: number): FormationLayout {
  const layout: FormationLayout = {
    count,
    x: new Float32Array(count),
    y: new Float32Array(count),
    division: new Uint8Array(count),
  }
  FORMATIONS[id].place(layout)
  return layout
}
