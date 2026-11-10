import { CLASS_MODS, SHIP_CLASS_IDS } from './balance.ts'
import { COMMANDERS } from './commanders.ts'
import { FORMATIONS } from './formations.ts'
import { parseClassId, parseCommanderId, parseFormationId, parseShipCount, parseSpeed, parseTacticId } from './parse.ts'
import { TACTICS } from './tactics.ts'
import {
  COMMANDER_IDS,
  FORMATION_IDS,
  SHIP_COUNTS,
  TACTIC_IDS,
  type Command,
  type SimState,
} from './types.ts'

export interface Hud {
  shipCount: HTMLSelectElement
  formation: [HTMLSelectElement, HTMLSelectElement]
  commander: [HTMLSelectElement, HTMLSelectElement]
  division: HTMLSelectElement[]
  shipClass: HTMLSelectElement[]
  log: HTMLElement
  clock: HTMLElement
  fps: HTMLElement
  banner: HTMLElement
  losses: [HTMLElement, HTMLElement]
}

export function mountHud(
  parent: HTMLElement,
  onCommand: (command: Command) => void,
  onFit: () => void,
  phaseKind: () => SimState['phase']['kind'],
): Hud {
  parent.innerHTML = `
    <header id="bar">
      <div class="brand">艦隊決戦</div>
      <label>隻数 <select id="ship-count"></select></label>
      <label class="side blue">青軍 <select id="form-0"></select></label>
      <label class="side blue">指揮官 <select id="cmd-0"></select></label>
      <label class="side red">赤軍 <select id="form-1"></select></label>
      <label class="side red">指揮官 <select id="cmd-1"></select></label>
      <button id="start" type="button">開戦</button>
      <button id="pause" type="button">停止</button>
      <div class="speeds" role="group" aria-label="速度">
        <button type="button" data-speed="1">×1</button>
        <button type="button" data-speed="2">×2</button>
        <button type="button" data-speed="4">×4</button>
      </div>
      <button id="reset" type="button">初期配置</button>
      <button id="fit" type="button">全体</button>
      <span id="clock">00:00</span>
      <span id="fps"></span>
    </header>
    <ol id="log"></ol>
    <details id="orders">
      <summary title="艦種は開戦前、戦術は戦闘中も、分艦隊ごとに変更できます">分艦隊の艦種と戦術</summary>
      <div class="order-grid">
        <section data-side="0"></section>
        <section data-side="1"></section>
      </div>
    </details>
    <p id="banner" hidden></p>
  `

  const shipCount = required(parent, '#ship-count', HTMLSelectElement)
  for (const count of SHIP_COUNTS) {
    const option = document.createElement('option')
    option.value = String(count)
    option.textContent = `${count.toLocaleString('ja-JP')}隻`
    shipCount.append(option)
  }
  shipCount.addEventListener('change', () => {
    const count = parseShipCount(shipCount.value)
    if (count !== null) onCommand({ type: 'set-ship-count', count })
  })

  const formationList = [0, 1].map((side) => {
    const select = required(parent, `#form-${side}`, HTMLSelectElement)
    for (const id of FORMATION_IDS) {
      const option = document.createElement('option')
      option.value = id
      option.textContent = FORMATIONS[id].name
      option.title = FORMATIONS[id].summary
      select.append(option)
    }
    select.addEventListener('change', () => {
      const formationId = parseFormationId(select.value)
      if (formationId !== null && (side === 0 || side === 1)) {
        onCommand({ type: 'set-formation', side, formationId })
      }
    })
    return select
  })
  const formation0 = formationList[0]
  const formation1 = formationList[1]
  if (!formation0 || !formation1) throw new Error('formation')
  const formation: [HTMLSelectElement, HTMLSelectElement] = [formation0, formation1]

  const commanderList = [0, 1].map((side) => {
    const select = required(parent, `#cmd-${side}`, HTMLSelectElement)
    for (const id of COMMANDER_IDS) {
      const option = document.createElement('option')
      option.value = id
      option.textContent = COMMANDERS[id].name
      option.title = COMMANDERS[id].summary
      select.append(option)
    }
    select.addEventListener('change', () => {
      const commanderId = parseCommanderId(select.value)
      if (commanderId !== null && (side === 0 || side === 1)) {
        onCommand({ type: 'set-commander', side, commanderId })
      }
    })
    return select
  })
  const commander0 = commanderList[0]
  const commander1 = commanderList[1]
  if (!commander0 || !commander1) throw new Error('commander')
  const commander: [HTMLSelectElement, HTMLSelectElement] = [commander0, commander1]

  const division: HTMLSelectElement[] = []
  const shipClass: HTMLSelectElement[] = []
  const sections = parent.querySelectorAll('#orders section')
  sections.forEach((section, side) => {
    const fleetTactic = document.createElement('div')
    fleetTactic.className = 'fleet-tactic'
    const fleetSelect = document.createElement('select')
    fillTactics(fleetSelect)
    const apply = document.createElement('button')
    apply.type = 'button'
    apply.textContent = '全軍に下令'
    apply.addEventListener('click', () => {
      const tacticId = parseTacticId(fleetSelect.value)
      if (tacticId !== null && (side === 0 || side === 1)) {
        onCommand({ type: 'set-side-tactic', side, tacticId })
      }
    })
    fleetTactic.append(fleetSelect, apply)
    section.append(fleetTactic)
    for (let slot = 0; slot < 5; slot++) {
      const row = document.createElement('label')
      row.className = 'div-row'
      const name = document.createElement('span')
      const count = document.createElement('span')
      count.className = 'remain'
      const klass = document.createElement('select')
      klass.className = 'class-select'
      for (const id of SHIP_CLASS_IDS) {
        const option = document.createElement('option')
        option.value = id
        option.textContent = CLASS_MODS[id].name
        option.title = CLASS_MODS[id].summary
        klass.append(option)
      }
      klass.addEventListener('change', () => {
        const classId = parseClassId(klass.value)
        if (classId !== null) onCommand({ type: 'set-class', division: index, classId })
      })
      const select = document.createElement('select')
      fillTactics(select)
      const index = side * 5 + slot
      select.addEventListener('change', () => {
        const tacticId = parseTacticId(select.value)
        if (tacticId !== null) onCommand({ type: 'set-tactic', division: index, tacticId })
      })
      row.append(name, klass, count, select)
      section.append(row)
      division[index] = select
      shipClass[index] = klass
      row.dataset.index = String(index)
    }
  })

  required(parent, '#start', HTMLButtonElement).addEventListener('click', () => onCommand({ type: 'start' }))
  required(parent, '#pause', HTMLButtonElement).addEventListener('click', () => {
    const kind = phaseKind()
    if (kind === 'running') onCommand({ type: 'pause' })
    if (kind === 'paused') onCommand({ type: 'resume' })
  })
  parent.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((button) => {
    button.addEventListener('click', () => {
      const speed = parseSpeed(button.dataset.speed ?? '')
      if (speed !== null) onCommand({ type: 'set-speed', speed })
    })
  })
  required(parent, '#reset', HTMLButtonElement).addEventListener('click', () => onCommand({ type: 'reset' }))
  required(parent, '#fit', HTMLButtonElement).addEventListener('click', onFit)

  const losses: [HTMLElement, HTMLElement] = [
    document.createElement('span'),
    document.createElement('span'),
  ]
  return {
    shipCount,
    formation,
    commander,
    division,
    shipClass,
    log: required(parent, '#log', HTMLElement),
    clock: required(parent, '#clock', HTMLElement),
    fps: required(parent, '#fps', HTMLElement),
    banner: required(parent, '#banner', HTMLElement),
    losses,
  }
}

export function syncHud(parent: HTMLElement, hud: Hud, state: SimState): void {
  const setup = state.phase.kind === 'setup'
  hud.shipCount.disabled = !setup
  if (hud.shipCount.value !== String(state.shipCount)) hud.shipCount.value = String(state.shipCount)
  hud.formation.forEach((select, side) => {
    select.disabled = !setup
    const id = state.fleets[side]?.formationId
    if (id && select.value !== id) select.value = id
  })
  hud.commander.forEach((select, side) => {
    select.disabled = !setup
    const id = state.fleets[side]?.commanderId
    if (id && select.value !== id) select.value = id
  })
  hud.log.replaceChildren()
  for (const line of state.log) {
    const item = document.createElement('li')
    item.textContent = line
    hud.log.append(item)
  }
  const speed = state.phase.kind === 'finished' ? 0 : state.phase.speed
  parent.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((button) => {
    button.classList.toggle('on', button.dataset.speed === String(speed))
    button.disabled = state.phase.kind === 'finished'
  })
  const start = required(parent, '#start', HTMLButtonElement)
  const pause = required(parent, '#pause', HTMLButtonElement)
  start.disabled = !setup
  pause.disabled = state.phase.kind !== 'running' && state.phase.kind !== 'paused'
  pause.textContent = state.phase.kind === 'paused' ? '再開' : '停止'
  const total = Math.floor(state.time)
  hud.clock.textContent = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  const rows = parent.querySelectorAll('.div-row')
  rows.forEach((row) => {
    if (!(row instanceof HTMLElement)) return
    const index = Number(row.dataset.index)
    const division = state.divisions[index]
    const select = hud.division[index]
    if (!division || !select) return
    const name = row.querySelector('span')
    const remain = row.querySelector('.remain')
    if (name) name.textContent = division.name
    if (remain) remain.textContent = division.alive.toLocaleString('ja-JP')
    const klass = hud.shipClass[index]
    if (klass) {
      if (klass.value !== division.classId) klass.value = division.classId
      klass.disabled = !setup
    }
    if (select.value !== division.tacticId) select.value = division.tacticId
    select.disabled = state.phase.kind === 'finished'
  })
  if (state.phase.kind === 'finished') {
    hud.banner.hidden = false
    hud.banner.textContent =
      state.phase.winner === 'draw'
        ? '引き分け'
        : state.phase.winner === 0
          ? '青軍の勝利'
          : '赤軍の勝利'
  } else if (state.phase.kind === 'paused') {
    hud.banner.hidden = false
    hud.banner.textContent = '停止中'
  } else {
    hud.banner.hidden = true
  }
}

function fillTactics(select: HTMLSelectElement): void {
  for (const id of TACTIC_IDS) {
    const option = document.createElement('option')
    option.value = id
    option.textContent = TACTICS[id].name
    option.title = TACTICS[id].summary
    select.append(option)
  }
}

function required<T extends Element>(parent: ParentNode, selector: string, ctor: new () => T): T {
  const node = parent.querySelector(selector)
  if (!(node instanceof ctor)) throw new Error(selector)
  return node
}
