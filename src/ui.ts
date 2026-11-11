import { CLASS_MODS, FLEET_SHIP_MAX, FLEET_SHIP_MIN, FLEET_SHIP_PRESETS, FLEET_SHIP_STEP, MAX_SHIPS, SHIP_CLASS_IDS } from './balance.ts'
import { COMMANDERS } from './commanders.ts'
import { FORMATIONS } from './formations.ts'
import { parseClassId, parseCommanderId, parseFleetShips, parseFormationId, parseShipCount, parseSpeed, parseTacticId } from './parse.ts'
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
  battleSize: HTMLElement
  fleetCount: [HTMLSelectElement, HTMLSelectElement]
  formation: [HTMLSelectElement, HTMLSelectElement]
  commander: [HTMLSelectElement, HTMLSelectElement]
  orderKey: string
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
  onSelectDivision: (index: number, shift: boolean) => void = () => {},
): Hud {
  parent.innerHTML = `
    <header id="bar">
      <div class="brand">艦隊決戦</div>
      <label>隻数 <select id="ship-count"></select></label>
      <span id="battle-size"></span>
      <label class="side blue">青軍 <select id="form-0"></select></label>
      <label class="side blue">指揮官 <select id="cmd-0"></select></label>
      <label class="side blue">艦隊 <select id="fleets-0"></select></label>
      <label class="side red">赤軍 <select id="form-1"></select></label>
      <label class="side red">指揮官 <select id="cmd-1"></select></label>
      <label class="side red">艦隊 <select id="fleets-1"></select></label>
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
      <summary title="手動の隊名をクリックして選び、地図を押してドラッグすると移動を命じます">分艦隊の艦種と戦術</summary>
      <p class="ai-settings">AIはその艦隊の指揮官ごとの方策ネットです。約2秒ごとに各分艦隊へ令を出します。未学習の指揮官はルールで代行します。</p>
      <div class="order-grid">
        <section data-side="0"></section>
        <section data-side="1"></section>
      </div>
    </details>
    <p id="banner" hidden></p>
  `

  const shipCount = required(parent, '#ship-count', HTMLSelectElement)
  const custom = document.createElement('option')
  custom.value = ''
  custom.textContent = '個別'
  shipCount.append(custom)
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

  const fleetCountList = [0, 1].map((side) => {
    const select = required(parent, `#fleets-${side}`, HTMLSelectElement)
    for (const count of [1, 2, 3]) {
      const option = document.createElement('option')
      option.value = String(count)
      option.textContent = `${count}`
      select.append(option)
    }
    select.addEventListener('change', () => {
      const count = Number(select.value)
      if ((count === 1 || count === 2 || count === 3) && (side === 0 || side === 1)) {
        onCommand({ type: 'set-fleet-count', side, count })
      }
    })
    return select
  })
  const fleetCount0 = fleetCountList[0]
  const fleetCount1 = fleetCountList[1]
  if (!fleetCount0 || !fleetCount1) throw new Error('fleet count')
  const fleetCount: [HTMLSelectElement, HTMLSelectElement] = [fleetCount0, fleetCount1]

  const orders = required(parent, '#orders', HTMLElement)
  orders.addEventListener('change', (event) => {
    const target = event.target
    if (!(target instanceof HTMLSelectElement || target instanceof HTMLInputElement)) return
    const fleet = Number(target.dataset.fleet)
    const divisionIndex = Number(target.dataset.division)
    if (target.dataset.kind === 'ships' && Number.isInteger(fleet)) {
      const ships = parseFleetShips(target.value)
      if (ships !== null) onCommand({ type: 'set-fleet-ships', fleet, ships })
    }
    if (target.dataset.kind === 'formation' && Number.isInteger(fleet)) {
      const formationId = parseFormationId(target.value)
      if (formationId !== null) onCommand({ type: 'set-fleet-formation', fleet, formationId })
    }
    if (target.dataset.kind === 'commander' && Number.isInteger(fleet)) {
      const commanderId = parseCommanderId(target.value)
      if (commanderId !== null) onCommand({ type: 'set-fleet-commander', fleet, commanderId })
    }
    if (target.dataset.kind === 'tactic' && Number.isInteger(divisionIndex)) {
      const tacticId = parseTacticId(target.value)
      if (tacticId !== null) onCommand({ type: 'set-tactic', division: divisionIndex, tacticId })
    }
    if (target.dataset.kind === 'class' && Number.isInteger(divisionIndex)) {
      const classId = parseClassId(target.value)
      if (classId !== null) onCommand({ type: 'set-class', division: divisionIndex, classId })
    }
  })
  orders.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    const target = event.target
    if (!(target instanceof HTMLInputElement) || target.dataset.kind !== 'ships') return
    event.preventDefault()
    const fleet = Number(target.dataset.fleet)
    const ships = parseFleetShips(target.value)
    if (Number.isInteger(fleet) && ships !== null) onCommand({ type: 'set-fleet-ships', fleet, ships })
  })
  orders.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (target instanceof HTMLButtonElement && target.dataset.kind === 'preset') {
      const fleet = Number(target.dataset.fleet)
      const ships = parseFleetShips(target.dataset.ships ?? '')
      if (Number.isInteger(fleet) && ships !== null) onCommand({ type: 'set-fleet-ships', fleet, ships })
    }
    if (target.classList.contains('div-name')) {
      const row = target.closest('.div-row')
      if (row instanceof HTMLElement) onSelectDivision(Number(row.dataset.index), event.shiftKey)
    }
    if (target instanceof HTMLButtonElement && target.dataset.kind === 'brain') {
      const fleet = Number(target.dataset.fleet)
      const brain = target.dataset.brain === 'ai' ? 'ai' : 'rule'
      if (Number.isInteger(fleet)) onCommand({ type: 'set-fleet-brain', fleet, brain })
    }
    if (target instanceof HTMLButtonElement && target.dataset.kind === 'order-fleet') {
      const select = target.previousElementSibling
      const fleet = Number(target.dataset.fleet)
      if (select instanceof HTMLSelectElement) {
        const tacticId = parseTacticId(select.value)
        if (tacticId !== null) onCommand({ type: 'set-fleet-tactic', fleet, tacticId })
      }
    }
  })

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
      const row = document.createElement('div')
      row.className = 'div-row'
      const name = document.createElement('span')
      name.className = 'div-name'
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
      name.title = 'クリックで選択。Shift で追加。地図を押してドラッグすると着地点と向き。'
      name.addEventListener('click', (event) => {
        event.preventDefault()
        onSelectDivision(index, event.shiftKey)
      })
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
    battleSize: required(parent, '#battle-size', HTMLElement),
    formation,
    commander,
    fleetCount,
    orderKey: '',
    division,
    shipClass,
    log: required(parent, '#log', HTMLElement),
    clock: required(parent, '#clock', HTMLElement),
    fps: required(parent, '#fps', HTMLElement),
    banner: required(parent, '#banner', HTMLElement),
    losses,
  }
}

export function syncHud(parent: HTMLElement, hud: Hud, state: SimState, picked: readonly number[] = []): void {
  const setup = state.phase.kind === 'setup'
  hud.shipCount.disabled = !setup
  const shortcut = state.groups ? '' : String(state.shipCount)
  if (hud.shipCount.value !== shortcut) hud.shipCount.value = shortcut
  const blueShips = state.fleets.filter((fleet) => fleet.side === 0).reduce((sum, fleet) => sum + fleet.ships, 0)
  const redShips = state.fleets.filter((fleet) => fleet.side === 1).reduce((sum, fleet) => sum + fleet.ships, 0)
  const asked = state.fleets.reduce((sum, fleet) => sum + fleet.requested, 0)
  const placed = blueShips + redShips
  const ask = asked === placed ? '' : `（要求 ${formatCount(asked)}）`
  hud.battleSize.textContent = `青 ${formatCount(blueShips)}  赤 ${formatCount(redShips)}  合計 ${formatCount(placed)}${ask} / 上限 ${formatCount(MAX_SHIPS)}`
  hud.battleSize.classList.toggle('over', state.fitNotice !== null)
  const blueFleets = state.fleets.filter((fleet) => fleet.side === 0 && fleet.ships > 0).length
  const redFleets = state.fleets.filter((fleet) => fleet.side === 1 && fleet.ships > 0).length
  hud.fleetCount[0].disabled = !setup
  hud.fleetCount[1].disabled = !setup
  if (hud.fleetCount[0].value !== String(blueFleets)) hud.fleetCount[0].value = String(Math.max(1, blueFleets))
  if (hud.fleetCount[1].value !== String(redFleets)) hud.fleetCount[1].value = String(Math.max(1, redFleets))
  const orderKey = state.fleets.map((fleet) => `${fleet.index}:${fleet.ships}:${fleet.requested}:${fleet.formationId}:${fleet.commanderId}:${fleet.brain}`).join()
  if (orderKey !== hud.orderKey) {
    hud.orderKey = orderKey
    paintOrders(parent, hud, state)
  }
  paintAiStatus(parent, state)
  parent.querySelectorAll<HTMLSelectElement>('#orders select').forEach((select) => {
    if (select.dataset.kind === 'tactic') select.disabled = state.phase.kind === 'finished'
    else select.disabled = !setup
  })
  parent.querySelectorAll<HTMLInputElement>('#orders input').forEach((input) => {
    input.disabled = !setup
  })
  parent.querySelectorAll<HTMLButtonElement>('#orders button[data-kind="preset"]').forEach((button) => {
    button.disabled = !setup
  })
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
    row.classList.toggle('picked', picked.includes(index))
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
  } else if (state.phase.kind === 'setup' && state.fitNotice) {
    hud.banner.hidden = false
    hud.banner.textContent = state.fitNotice
  } else {
    hud.banner.hidden = true
  }
}

function aiStatusText(fleet: SimState['fleets'][number]): string {
  if (fleet.brain !== 'ai') return ''
  const latency = fleet.ai.latencyMs > 0 ? ` ${fleet.ai.latencyMs}ms` : ''
  const fallbacks = fleet.ai.fallbacks > 0 ? ` 代替 ${fleet.ai.fallbacks}` : ''
  if (fleet.ai.status === 'thinking') return `思考中${fallbacks}`
  if (fleet.ai.status === 'fallback') return `ルールで代行${latency}${fallbacks}`
  if (fleet.ai.status === 'ready') return `決定${latency}${fallbacks}`
  return `待機${fallbacks}`
}

function paintAiStatus(parent: HTMLElement, state: SimState): void {
  parent.querySelectorAll<HTMLElement>('.ai-status').forEach((element) => {
    const fleet = state.fleets[Number(element.dataset.fleet)]
    if (!fleet) return
    element.textContent = aiStatusText(fleet)
    element.classList.toggle('fallback', fleet.brain === 'ai' && fleet.ai.status === 'fallback')
  })
  parent.querySelectorAll<HTMLElement>('.ai-note').forEach((element) => {
    const fleet = state.fleets[Number(element.dataset.fleet)]
    element.textContent = fleet?.brain === 'ai' ? fleet.ai.note : ''
  })
}

function paintOrders(parent: HTMLElement, hud: Hud, state: SimState): void {
  const sections = parent.querySelectorAll('#orders section')
  hud.division = []
  hud.shipClass = []
  sections.forEach((section, side) => {
    section.replaceChildren()
    if (side !== 0 && side !== 1) return
    const fleets = state.fleets.filter((fleet) => fleet.side === side && fleet.ships > 0)
    const sideTotal = document.createElement('p')
    sideTotal.className = 'side-total'
    const sideShips = fleets.reduce((sum, fleet) => sum + fleet.ships, 0)
    const sideAsked = fleets.reduce((sum, fleet) => sum + fleet.requested, 0)
    const sideAsk = sideAsked === sideShips ? '' : `（要求 ${formatCount(sideAsked)}）`
    sideTotal.textContent = `${side === 0 ? '青軍' : '赤軍'} 合計 ${formatCount(sideShips)}隻${sideAsk}`
    section.append(sideTotal)
    for (const fleet of fleets) {
      const head = document.createElement('div')
      head.className = `fleet-head shade-${fleet.ordinal}`
      const titleRow = document.createElement('div')
      titleRow.className = 'fleet-title'
      const title = document.createElement('strong')
      title.textContent = fleet.name
      const countLabel = document.createElement('span')
      countLabel.textContent = fleet.requested === fleet.ships
        ? `${formatCount(fleet.ships)}隻`
        : `配置 ${formatCount(fleet.ships)}隻`
      titleRow.append(title, countLabel)
      const control = document.createElement('div')
      control.className = 'ship-control'
      const range = document.createElement('input')
      range.type = 'range'
      range.min = String(FLEET_SHIP_MIN)
      range.max = String(FLEET_SHIP_MAX)
      range.step = String(FLEET_SHIP_STEP)
      range.value = String(fleet.requested)
      range.dataset.kind = 'ships'
      range.dataset.fleet = String(fleet.index)
      range.setAttribute('aria-label', `${fleet.name}の隻数`)
      const number = document.createElement('input')
      number.type = 'number'
      number.min = String(FLEET_SHIP_MIN)
      number.max = String(FLEET_SHIP_MAX)
      number.step = String(FLEET_SHIP_STEP)
      number.value = String(fleet.requested)
      number.dataset.kind = 'ships'
      number.dataset.fleet = String(fleet.index)
      number.setAttribute('aria-label', `${fleet.name}の隻数`)
      control.append(range, number)
      const presets = document.createElement('div')
      presets.className = 'ship-presets'
      for (const count of FLEET_SHIP_PRESETS) {
        const button = document.createElement('button')
        button.type = 'button'
        button.dataset.kind = 'preset'
        button.dataset.fleet = String(fleet.index)
        button.dataset.ships = String(count)
        button.textContent = formatCount(count)
        button.classList.toggle('on', fleet.requested === count)
        presets.append(button)
      }
      const formation = document.createElement('select')
      formation.dataset.kind = 'formation'
      formation.dataset.fleet = String(fleet.index)
      for (const id of FORMATION_IDS) {
        const option = document.createElement('option')
        option.value = id
        option.textContent = FORMATIONS[id].name
        formation.append(option)
      }
      formation.value = fleet.formationId
      const commander = document.createElement('select')
      commander.dataset.kind = 'commander'
      commander.dataset.fleet = String(fleet.index)
      for (const id of COMMANDER_IDS) {
        const option = document.createElement('option')
        option.value = id
        option.textContent = COMMANDERS[id].name
        commander.append(option)
      }
      commander.value = fleet.commanderId
      const brain = document.createElement('div')
      brain.className = 'brain-toggle'
      brain.dataset.fleet = String(fleet.index)
      for (const mode of ['rule', 'ai'] as const) {
        const button = document.createElement('button')
        button.type = 'button'
        button.dataset.kind = 'brain'
        button.dataset.brain = mode
        button.dataset.fleet = String(fleet.index)
        button.textContent = mode === 'rule' ? 'ルール' : 'AI'
        button.classList.toggle('on', fleet.brain === mode)
        button.title = mode === 'rule' ? 'コードの指揮官' : 'モデルに令を尋ねる'
        brain.append(button)
      }
      const status = document.createElement('p')
      status.className = 'ai-status'
      status.dataset.fleet = String(fleet.index)
      const note = document.createElement('p')
      note.className = 'ai-note'
      note.dataset.fleet = String(fleet.index)
      const tactic = document.createElement('select')
      fillTactics(tactic)
      const apply = document.createElement('button')
      apply.type = 'button'
      apply.dataset.kind = 'order-fleet'
      apply.dataset.fleet = String(fleet.index)
      apply.textContent = 'この艦隊に下令'
      const meta = document.createElement('div')
      meta.className = 'fleet-meta'
      meta.append(formation, commander, brain, tactic, apply)
      head.append(titleRow, control, presets, meta, status, note)
      section.append(head)
      for (let slot = 0; slot < 5; slot++) {
        const index = fleet.index * 5 + slot
        const division = state.divisions[index]
        const row = document.createElement('div')
        row.className = `div-row shade-${fleet.ordinal}`
        row.dataset.index = String(index)
        const name = document.createElement('span')
        name.className = 'div-name'
        name.textContent = division?.name ?? ''
        name.title = `${fleet.name}の${division?.name ?? '隊'}。クリックで選択。`
        const count = document.createElement('span')
        count.className = 'remain'
        const klass = document.createElement('select')
        klass.className = 'class-select'
        klass.dataset.kind = 'class'
        klass.dataset.division = String(index)
        for (const id of SHIP_CLASS_IDS) {
          const option = document.createElement('option')
          option.value = id
          option.textContent = CLASS_MODS[id].name
          klass.append(option)
        }
        if (division) klass.value = division.classId
        const select = document.createElement('select')
        select.dataset.kind = 'tactic'
        select.dataset.division = String(index)
        fillTactics(select)
        if (division) select.value = division.tacticId
        row.append(name, klass, count, select)
        section.append(row)
        hud.division[index] = select
        hud.shipClass[index] = klass
      }
    }
  })
}

function formatCount(value: number): string {
  return value.toLocaleString('ja-JP')
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
