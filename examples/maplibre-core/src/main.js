import 'maplibre-gl/dist/maplibre-gl.css'
import { MapEngine } from '@kalisio/maplibre-core'
import './style.css'
import { defaultLayers } from './layers.js'
import { styles } from './styles.js'

// --- STATE ---
let engine
const layersState = [...defaultLayers]
const activeMainLayers = new Set()
const activeFilters = new Set()
let styleTarget = null // { layerId, filterId }
let levels = []; let levelMetadata = null

// --- DOM ELEMENTS ---
const dom = {
  rightPanel: document.getElementById('right-panel'),
  toggleRightBtn: document.getElementById('toggle-right-panel'),
  floatingToggleBtn: document.getElementById('floating-toggle-btn'),
  layersList: document.getElementById('layers-list'),
  fabAdd: document.getElementById('fab-add-layer'),
  modal: document.getElementById('add-layer-modal'),
  modalCancel: document.getElementById('modal-cancel'),
  modalSubmit: document.getElementById('modal-submit'),
  inputLayerName: document.getElementById('new-layer-name'),
  inputLayerGeojson: document.getElementById('new-layer-geojson'),
  styleModal: document.getElementById('style-modal'),
  styleModalCancel: document.getElementById('style-modal-cancel'),
  styleModalSubmit: document.getElementById('style-modal-submit'),
  styleOptionsContainer: document.getElementById('style-options-container'),
  levelSlider: document.getElementById('right-altitude-slider'),
  timeInput: document.getElementById('time-input'),
  timeSelect: document.getElementById('time-step-select'),
  prevTimeStepBtn: document.getElementById('prev-time-step-btn'),
  nextTimeStepBtn: document.getElementById('next-time-step-btn')
}

// --- INIT ---
function init () {
  const mapContainer = document.getElementById('map-container')

  engine = new MapEngine(mapContainer, {
    style: {
      version: 8,
      name: 'basic-map',
      sources: {},
      sprite: window.location.origin + '/fonts/lineawesome-sprite',
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f8f9fa' } }]
    },
    center: [2.3522, 48.8566],
    zoom: 4,
    scaleControl: true
  })

  engine.on('engine:ready', async () => {
    console.log('Engine ready.')
    setupUI()
    setupTimeControls()

    const selecedTime = new Date(dom.timeInput.value)
    engine.setTime(selecedTime)

    for (const layer of layersState) {
      engine.addLayer(layer)

      // A layer is active by default unless explicitly marked `activate: false`.
      const layerActive = layer.activate !== false
      if (layerActive) {
        activeMainLayers.add(layer.id)
      } else {
        engine.setLayerVisibility(layer.id, false)
      }

      // Keep each filter's initial state (activeFilters set + engine state) consistent
      // with its own `activate` flag, independently of the parent layer's state.
      if (layer.filters) {
        layer.filters.forEach(filter => {
          const filterActive = filter.activate !== false
          if (filterActive) {
            activeFilters.add(filter.id)
          } else {
            engine.setFilterActive(layer.id, filter.id, false)
          }
        })
      }
    }

    renderLayersList()
  })

  engine.on('layer:added', async ({ layerId }) => {
    if (layerId === 'default-kazarr') {
      const levelCoordinate = await engine.getCoordinate(layerId, 'isobaricInhPa')
      levels = levelCoordinate.values
      levelMetadata = levelCoordinate.metadata
      console.log('Levels for isobaricInhPa:', levels, levelMetadata)
      setupVerticalSlider()
    }
  })

  // Close menus when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-container')) {
      document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'))
    }
  })
}

// --- UI SETUP ---
function setupUI () {
  const togglePanel = () => {
    dom.rightPanel.classList.toggle('collapsed')
    setTimeout(() => engine.resize(), 300)
  }
  dom.toggleRightBtn.addEventListener('click', togglePanel)
  dom.floatingToggleBtn.addEventListener('click', togglePanel)

  // FAB & Modal
  dom.fabAdd.addEventListener('click', () => {
    dom.inputLayerName.value = ''
    dom.inputLayerGeojson.value = ''
    dom.modal.showModal()
  })

  dom.modalCancel.addEventListener('click', () => dom.modal.close())

  dom.modalSubmit.addEventListener('click', () => {
    const name = dom.inputLayerName.value.trim()
    const rawData = dom.inputLayerGeojson.value.trim()
    if (!name || !rawData) {
      console.log('Missing name or GeoJSON data:', { name, rawData })
      return
    }

    let data
    try {
      data = JSON.parse(rawData)
    } catch (e) {
      console.log('Invalid GeoJSON:', e)
      return
    }

    const id = `custom-layer-${Date.now()}`
    const newLayer = {
      id,
      name,
      type: 'geojson',
      data,
      style: { 'circle-color': '#ffb703', 'circle-radius': 8, 'fill-color': '#ffb703', 'fill-opacity': 0.4 }
    }

    layersState.push(newLayer)
    dom.modal.close()
    renderLayersList()

    // Auto-enable
    toggleLayer(id, true)
    centerOnLayer(id)
  })

  // Style Modal
  dom.styleOptionsContainer.innerHTML = styles.map((s, idx) => `
    <label style="display: block; margin-bottom: 8px;">
      <input type="radio" name="style-choice" value="${idx}" ${idx === 0 ? 'checked' : ''}>
      ${s.name}
    </label>
  `).join('')
  dom.styleModalCancel.addEventListener('click', () => {
    dom.styleModal.close()
    styleTarget = null
  })
  dom.styleModalSubmit.addEventListener('click', () => {
    if (!styleTarget) return
    const selectedIdx = document.querySelector('input[name="style-choice"]:checked').value
    const selectedStyle = styles[selectedIdx].style

    engine.applyStyle(styleTarget.layerId, selectedStyle, styleTarget.filterId)

    dom.styleModal.close()
    styleTarget = null
  })
}

function setupVerticalSlider () {
  dom.levelSlider.min = 0
  dom.levelSlider.max = levels.length - 1
  dom.levelSlider.step = 1
  dom.levelSlider.value = 0
  document.getElementById('slider-value').textContent = `${levels[0]} ${levelMetadata?.attributes?.units || ''}`
  dom.levelSlider.addEventListener('change', () => {
    const levelIndex = Number.parseInt(dom.levelSlider.value)
    const levelValue = levels[levelIndex]
    const textElement = document.getElementById('slider-value')
    textElement.textContent = `${levelValue} ${levelMetadata?.attributes?.units || ''}`
    engine.setLayerLevel('default-kazarr', levelValue)
  })
}

function setupTimeControls () {
  dom.timeInput.addEventListener('change', () => {
    const selectedTime = new Date(dom.timeInput.value)
    engine.setTime(selectedTime)
  })

  dom.prevTimeStepBtn.addEventListener('click', () => {
    const currentTime = new Date(dom.timeInput.value + 'Z')
    const stepValue = dom.timeSelect.value
    const newTime = new Date(currentTime.getTime() - parseTimeStep(stepValue))
    console.log('New time after previous step:', newTime)
    dom.timeInput.value = newTime.toISOString().slice(0, 16)
    engine.setTime(newTime)
  })
  dom.nextTimeStepBtn.addEventListener('click', () => {
    const currentTime = new Date(dom.timeInput.value + 'Z')
    const stepValue = dom.timeSelect.value
    const newTime = new Date(currentTime.getTime() + parseTimeStep(stepValue))
    console.log('New time after next step:', newTime)
    dom.timeInput.value = newTime.toISOString().slice(0, 16)
    engine.setTime(newTime)
  })
}

function parseTimeStep (step) {
  const unit = step.slice(-1)
  const value = Number.parseInt(step.slice(0, -1))
  switch (unit) {
    case 'm': return value * 60 * 1000 // minutes to milliseconds
    case 'h': return value * 60 * 60 * 1000 // hours to milliseconds
    case 'd': return value * 24 * 60 * 60 * 1000 // days to milliseconds
    default: return 0
  }
}

// --- LAYER LOGIC ---
async function toggleLayer (layerId, forceEnable = null) {
  const isEnabled = forceEnable !== null ? forceEnable : !activeMainLayers.has(layerId)

  if (isEnabled) {
    activeMainLayers.add(layerId)
    engine.setLayerVisibility(layerId, true)
  } else {
    activeMainLayers.delete(layerId)
    engine.setLayerVisibility(layerId, false)
  }

  // Update UI checkbox
  const cb = document.getElementById(`cb-${layerId}`)
  if (cb) cb.checked = isEnabled
}

function toggleSubFilter (layerId, filterId, layerDef) {
  if (activeFilters.has(filterId)) {
    activeFilters.delete(filterId)
    console.log(`Deactivating sub-filter ${filterId} for layer ${layerId}`)
    engine.setFilterActive(layerId, filterId, false)
  } else {
    activeFilters.add(filterId)
    console.log(`Activating sub-filter ${filterId} for layer ${layerId}`)
    engine.setFilterActive(layerId, filterId, true)
  }
}

function centerOnLayer (layerId) {
  // engine.flyTo(-73.63835, 48.15876, 7)
  // engine.fitBounds([
  //   [-78.39843750000001, 46.12274903582433],
  //   [-67.85156250000001, 49.55728898983402]
  // ]);
  engine.flyToLayer(layerId)
}

async function changeLayerStyle (layerId, filterId = null) {
  const layerDef = layersState.find(l => l.id === layerId)
  if (layerDef?.type !== 'vector') {
    console.log('Layer is not vector type, cannot change style:', layerDef)
    return
  }

  if (!activeMainLayers.has(layerId)) {
    console.log('Layer is not active, cannot change style:', layerId)
    return
  }

  styleTarget = { layerId, filterId }
  dom.styleModal.showModal()
}

// --- RENDERING UI ---
function renderLayersList () {
  dom.layersList.innerHTML = ''

  layersState.forEach(layer => {
    const li = document.createElement('li')
    li.className = 'layer-item'

    // Main Row
    const mainDiv = document.createElement('div')
    mainDiv.className = 'layer-main'

    const hasChildren = layer.filters && layer.filters.length > 0

    // Caret
    const caret = document.createElement('button')
    caret.className = 'caret-btn'
    caret.innerHTML = hasChildren ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>' : '<div style="width:20px"></div>'

    // Switch
    const switchLabel = document.createElement('label')
    switchLabel.className = 'switch'
    switchLabel.innerHTML = `<input type="checkbox" id="cb-${layer.id}" ${activeMainLayers.has(layer.id) ? 'checked' : ''}><span class="slider"></span>`
    switchLabel.querySelector('input').addEventListener('change', () => toggleLayer(layer.id))

    // Name
    const nameSpan = document.createElement('span')
    nameSpan.className = 'layer-name'
    nameSpan.textContent = layer.name

    // Menu
    const menuContainer = document.createElement('div')
    menuContainer.className = 'menu-container'
    menuContainer.innerHTML = `
      <button class="menu-btn"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>
      <div class="dropdown-menu">
        <button class="dropdown-item" data-action="style">Appliquer un style</button>
        <button class="dropdown-item" data-action="center">Centrer la vue</button>
      </div>
    `

    menuContainer.querySelector('.menu-btn').addEventListener('click', (e) => {
      e.stopPropagation()
      document.querySelectorAll('.dropdown-menu.show').forEach(m => {
        if (m !== menuContainer.querySelector('.dropdown-menu')) m.classList.remove('show')
      })
      menuContainer.querySelector('.dropdown-menu').classList.toggle('show')
    })

    menuContainer.querySelectorAll('.dropdown-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = e.target.dataset.action
        if (action === 'center') centerOnLayer(layer.id)
        if (action === 'style') changeLayerStyle(layer.id)
        menuContainer.querySelector('.dropdown-menu').classList.remove('show')
      })
    })

    mainDiv.appendChild(caret)
    mainDiv.appendChild(switchLabel)
    mainDiv.appendChild(nameSpan)
    mainDiv.appendChild(menuContainer)
    li.appendChild(mainDiv)

    // Children Filters
    if (hasChildren) {
      const childrenDiv = document.createElement('div')
      childrenDiv.className = 'layer-children'

      caret.addEventListener('click', () => {
        caret.classList.toggle('expanded')
        childrenDiv.classList.toggle('expanded')
      })

      layer.filters.forEach(filter => {
        const childDiv = document.createElement('div')
        childDiv.className = 'child-item'

        const cSwitch = document.createElement('label')
        cSwitch.className = 'switch'
        cSwitch.innerHTML = `<input type="checkbox" id="cb-f-${filter.id}" ${activeFilters.has(filter.id) ? 'checked' : ''}><span class="slider"></span>`
        cSwitch.querySelector('input').addEventListener('change', () => toggleSubFilter(layer.id, filter.id, layer))

        const cName = document.createElement('span')
        cName.className = 'layer-name'
        cName.textContent = filter.name

        // Menu for sub-filter
        const fMenuContainer = document.createElement('div')
        fMenuContainer.className = 'menu-container'
        fMenuContainer.style.marginLeft = 'auto'
        fMenuContainer.innerHTML = `
          <button class="menu-btn"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>
          <div class="dropdown-menu">
            <button class="dropdown-item" data-action="style">Appliquer un style</button>
          </div>
        `
        fMenuContainer.querySelector('.menu-btn').addEventListener('click', (e) => {
          e.stopPropagation()
          document.querySelectorAll('.dropdown-menu.show').forEach(m => {
            if (m !== fMenuContainer.querySelector('.dropdown-menu')) m.classList.remove('show')
          })
          fMenuContainer.querySelector('.dropdown-menu').classList.toggle('show')
        })
        fMenuContainer.querySelectorAll('.dropdown-item').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const action = e.target.dataset.action
            if (action === 'style') changeLayerStyle(layer.id, filter.id)
            fMenuContainer.querySelector('.dropdown-menu').classList.remove('show')
          })
        })

        childDiv.appendChild(cSwitch)
        childDiv.appendChild(cName)
        childDiv.appendChild(fMenuContainer)
        childrenDiv.appendChild(childDiv)
      })

      li.appendChild(childrenDiv)
    }

    dom.layersList.appendChild(li)
  })
}

// Start
init()
