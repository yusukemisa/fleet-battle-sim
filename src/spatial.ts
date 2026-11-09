/** Open-addressed grid. Ships in the same cell share a chain. Rebuilt each step. */
export interface SpatialHash {
  cell: number
  mask: number
  generation: number
  stamp: Int32Array
  keys: Int32Array
  head: Int32Array
  next: Int32Array
  found: Int32Array
}

/** Per-side ready guns, so a volley can alternate sides without allocating. */
export interface ReadyQueues {
  blue: Int32Array
  red: Int32Array
}

export interface CombatScratch {
  hash: SpatialHash
  bowX: Float32Array
  bowY: Float32Array
  incoming: Float32Array
  opened: Float32Array
  exposed: Uint8Array
  cosArc: number
  cosBow: number
  cosStern: number
  /** Max distance from each side's centroid to one of its living ships. */
  spread: [number, number]
  ready: ReadyQueues
  /** Frame of the last target search. -1 means this gun has not searched yet. */
  look: Int32Array
}

function tableSize(count: number): number {
  let size = 16
  const need = Math.max(16, count * 2)
  while (size < need) size <<= 1
  return size
}

export function createSpatialHash(count: number, cell: number): SpatialHash {
  const size = tableSize(count)
  return {
    cell,
    mask: size - 1,
    generation: 0,
    stamp: new Int32Array(size),
    keys: new Int32Array(size),
    head: new Int32Array(size),
    next: new Int32Array(count),
    found: new Int32Array(count),
  }
}

export function createScratch(count: number, cell: number): CombatScratch {
  return {
    hash: createSpatialHash(count, cell),
    bowX: new Float32Array(count),
    bowY: new Float32Array(count),
    incoming: new Float32Array(count),
    opened: new Float32Array(count),
    exposed: new Uint8Array(count),
    cosArc: 1,
    cosBow: 1,
    cosStern: 1,
    spread: [0, 0],
    ready: { blue: new Int32Array(count), red: new Int32Array(count) },
    look: new Int32Array(count).fill(-1),
  }
}

function cellKey(cx: number, cy: number): number {
  return (cx * 73856093) ^ (cy * 19349663)
}

export function fillSpatialHash(
  hash: SpatialHash,
  x: Float32Array,
  y: Float32Array,
  alive: Uint8Array,
  count: number,
): void {
  hash.generation += 1
  if (hash.generation >= 0x7ffffffe) {
    hash.stamp.fill(0)
    hash.generation = 1
  }
  const gen = hash.generation
  const cell = hash.cell
  const mask = hash.mask
  for (let i = 0; i < count; i++) {
    if (alive[i] === 0) continue
    const key = cellKey(Math.floor((x[i] ?? 0) / cell), Math.floor((y[i] ?? 0) / cell))
    let slot = key & mask
    for (;;) {
      if (hash.stamp[slot] !== gen) {
        hash.stamp[slot] = gen
        hash.keys[slot] = key
        hash.head[slot] = i
        hash.next[i] = -1
        break
      }
      if (hash.keys[slot] === key) {
        hash.next[i] = hash.head[slot] ?? -1
        hash.head[slot] = i
        break
      }
      slot = (slot + 1) & mask
    }
  }
}

/** Writes neighbors inside `radius` into `hash.found` and returns how many. */
export function collectNear(
  hash: SpatialHash,
  x: number,
  y: number,
  radius: number,
  xs: Float32Array,
  ys: Float32Array,
): number {
  const cell = hash.cell
  const reach = Math.ceil(radius / cell)
  const cx = Math.floor(x / cell)
  const cy = Math.floor(y / cell)
  const gen = hash.generation
  const mask = hash.mask
  const radiusSq = radius * radius
  const found = hash.found
  let n = 0
  for (let oy = -reach; oy <= reach; oy++) {
    for (let ox = -reach; ox <= reach; ox++) {
      const key = cellKey(cx + ox, cy + oy)
      let slot = key & mask
      let guard = 0
      for (;;) {
        if (hash.stamp[slot] !== gen) break
        if (hash.keys[slot] === key) {
          let ship = hash.head[slot] ?? -1
          while (ship >= 0) {
            const dx = (xs[ship] ?? 0) - x
            const dy = (ys[ship] ?? 0) - y
            if (dx * dx + dy * dy <= radiusSq) found[n++] = ship
            ship = hash.next[ship] ?? -1
          }
          break
        }
        slot = (slot + 1) & mask
        guard += 1
        if (guard > mask) break
      }
    }
  }
  return n
}
