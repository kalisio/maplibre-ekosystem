/**
 * @file LayerManager.js
 * @description Central router of the cartographic library.
 *
 * `LayerManager` is the link between the `MapEngine` facade and the
 * rendering subsystems. For each `add()`, `LayerFactory` builds a composite
 * `Layer` (holding a 2D and/or 3D `LayerAdapter` — `MapLibreLayerAdapter`,
 * `VectorLayerAdapter`, `ThreeJsLayerAdapter`, `DeckGlLayerAdapter`
 * depending on `definition.type`) and stores it in the registry.
 *
 * `LayerManager` only ever receives an `EngineContext` from `MapEngine` —
 * never the full `StateManager` — and only ever hands an `AdapterContext`
 * to each `LayerAdapter` it creates (via `LayerFactory`) — never itself.
 * See `EngineContext.js` / `AdapterContext.js`.
 */

import { LayerFactory } from './LayerFactory.js'
import { LAYER_ID_SEPARATOR } from './adapters/LayerAdapter.js'
import { ThreeJsSceneManager } from './ThreeJsSceneManager.js'
import { DeckGlManager } from './DeckGlManager.js'

export class LayerManager {
  _layerFactory = null

  /**
   * Registry of all managed layers, indexed by business identifier.
   * @type {Map<string, import('./Layer.js').Layer>}
   */
  _layerRegistry = new Map()

  /** @type {import('./contexts/EngineContext.js').EngineContext} */
  _engineContext = null

  _threeJsSceneManager = null
  _deckGlManager = null

  /**
   * @param {import('./contexts/EngineContext.js').EngineContext} engineContext - narrowed view of `StateManager` (`isRenderMode2D()`, `getTime()`, `getAppDefaultStyle()`)
   */
  constructor (engineContext) {
    this._engineContext = engineContext // { isRenderMode2D(), getTime(), getAppDefaultStyle() }
  }

  /**
   * Creates the shared 3D scene managers for the given map. Must be called
   * once, before any `add()` call for a 3D-capable layer type.
   * @param {import('maplibre-gl').Map} map
   */
  initialize (map) {
    this._threeJsSceneManager = new ThreeJsSceneManager(map)
    this._deckGlManager = new DeckGlManager(map)
  }

  // ── Layer Addition ─────────────────────────────────────────────────────────

  /**
   * Orchestrates the complete addition of a layer:
   * 1. Builds the composite `Layer` and its `LayerAdapter`(s) via `LayerFactory`
   * 2. Initializes it for the current render mode
   * 3. Registers it in the registry
   *
   * @param {import('maplibre-gl').Map} map
   * @param {Object} definition
   * @returns {Promise<void>}
   */
  async add (map, definition) {
    if (!definition?.id) {
      throw new Error('Layer definition with a unique "id" is required')
    }
    const id = definition.id
    const layer = this._getLayerFactory().createLayer(definition, map, this)
    layer.initialize(this._engineContext.isRenderMode2D())
    this._layerRegistry.set(id, layer)
  }

  // ── Layer Removal ──────────────────────────────────────────────────────────

  /**
   * Removes a layer from the rendering engine and the internal registry.
   *
   * @param {import('maplibre-gl').Map} map
   * @param {string} id
   */
  remove (map, id) {
    const layer = this._layerRegistry.get(id)
    if (!layer) {
      console.warn(`[LayerManager] Cannot remove: layer "${id}" not found in registry.`)
      return
    }

    layer.destroy()
    this._layerRegistry.delete(id)
  }

  // ── Visibility ─────────────────────────────────────────────────────────────

  /**
   * Modifies the visibility of a layer by delegating to its adapter.
   *
   * @param {string} id
   * @param {boolean} visible
   */
  setVisibility (id, visible) {
    const layer = this._layerRegistry.get(id)
    if (!layer) {
      console.warn(`[LayerManager] Cannot set visibility: layer "${id}" not found.`)
      return
    }

    if (visible) {
      layer.show()
    } else {
      layer.hide()
    }
  }

  // ── Styling ──────────────────────────────────────────────────────────────

  /**
   * Applies a style to a layer.
   *
   * @param {string} id
   * @param {Object} style
   * @param {string} filterId
   */
  applyStyle (id, style, filterId = null) {
    const entry = this._getLayerFromRegistry(id)
    if (!entry) {
      console.warn(`[LayerManager] Cannot apply style: layer "${id}" not found.`)
      return
    }

    entry.applyStyle(style, filterId)
  }

  // ── Temporal Update ────────────────────────────────────────────────────────

  /**
   * Applies a temporal update to a layer.
   *
   * @param {Date} time
   * @param {string[]} ids
   * @returns {Promise<void>}
   */
  async setTime (time, ids = null) {
    const entries = []
    const targetIds = ids ?? Array.from(this._layerRegistry.keys())
    for (const id of targetIds) {
      const entry = this._getLayerFromRegistry(id)
      if (!entry) {
        console.warn(`[LayerManager] Cannot set time: layer "${id}" not found.`)
        continue
      }
      entries.push(entry)
    }

    const promises = entries.map(entry => entry.setTime(time))
    await Promise.all(promises)
  }

  /**
   * Activates or deactivates a previously-registered filter on a layer.
   * @param {string} layerId
   * @param {string} filterId
   * @param {boolean} active
   */
  setFilterActive (layerId, filterId, active) {
    const entry = this._getLayerFromRegistry(layerId)
    if (!entry) {
      console.warn(`[LayerManager] Cannot set filter active: layer "${layerId}" not found.`)
      return
    }

    entry.setFilterActive(filterId, active)
  }

  /**
   * Retrieves the bounding box of a layer.
   *
   * @param {string} id
   * @returns {[[number, number], [number, number]] | undefined}
   */
  getLayerBounds (id) {
    const entry = this._getLayerFromRegistry(id)
    if (!entry) {
      console.warn(`[LayerManager] Cannot get bounds: layer "${id}" not found.`)
      return
    }

    return entry.getBounds()
  }

  /**
   * Sets the active vertical/coordinate level of a multi-dimensional
   * (Kazarr-backed) layer.
   * @param {string} id
   * @param {*} level
   */
  setLayerLevel (id, level) {
    const entry = this._getLayerFromRegistry(id)
    if (!entry) {
      console.warn(`[LayerManager] Cannot get bounds: layer "${id}" not found.`)
      return
    }

    return entry.setLevel(level)
  }

  // ── Multi-dimensional ──────────────────────────────────────────────────────

  /**
   * Returns the available coordinate dimensions of a multi-dimensional
   * (Kazarr-backed) layer.
   * @param {string} layerId
   * @returns {Promise<string[] | undefined>}
   */
  async getCoordinates (layerId) {
    const entry = this._getLayerFromRegistry(layerId)
    if (!entry) {
      console.warn(`[LayerManager] Cannot get coordinates: layer "${layerId}" not found.`)
      return
    }

    return await entry.getCoordinates()
  }

  /**
   * Returns the available data variables of a multi-dimensional
   * (Kazarr-backed) layer.
   * @param {string} layerId
   * @returns {Promise<string[] | undefined>}
   */
  async getVariables (layerId) {
    const entry = this._getLayerFromRegistry(layerId)
    if (!entry) {
      console.warn(`[LayerManager] Cannot get variables: layer "${layerId}" not found.`)
      return
    }

    return await entry.getVariables()
  }

  /**
   * Returns the values and metadata of one coordinate dimension of a
   * multi-dimensional (Kazarr-backed) layer.
   * @param {string} layerId
   * @param {string} coordinateName
   * @returns {Promise<Object | undefined>}
   */
  async getCoordinate (layerId, coordinateName) {
    const entry = this._getLayerFromRegistry(layerId)
    if (!entry) {
      console.warn(`[LayerManager] Cannot get coordinate ${coordinateName}: layer "${layerId}" not found.`)
      return
    }

    return await entry.getCoordinate(coordinateName)
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  /**
   * Returns the engine's current global time, defaulting to `new Date()`
   * when none is set (via `StateManager.setTime()`).
   * @returns {Date}
   */
  getGlobalTime () {
    return this._engineContext.getTime() || new Date()
  }

  /**
   * Returns the application-wide default style (set via
   * `MapEngine.defineDefaultStyle()`), used as the lowest-priority layer in
   * `parseStyle()`.
   * @returns {Object}
   */
  getAppDefaultStyle () {
    return this._engineContext.getAppDefaultStyle() || {}
  }

  /**
   * @returns {import('./ThreeJsSceneManager.js').ThreeJsSceneManager}
   */
  getThreeJsSceneManager () {
    return this._threeJsSceneManager
  }

  /**
   * @returns {import('./DeckGlManager.js').DeckGlManager}
   */
  getDeckGlManager () {
    return this._deckGlManager
  }

  // ── Layer Ordering ─────────────────────────────────────────────────────────

  /**
   * Returns the current business layer ids, ordered bottom-to-top as they
   * appear in the MapLibre style's layer stack.
   * @param {import('maplibre-gl').Map} map
   * @returns {string[]}
   */
  getLayersOrder (map) {
    const order = this._getLayersAndSublayersOrder(map)
    return order.map(entry => entry.id)
  }

  /**
   * Moves a layer (all of its MapLibre sublayers) to the top of the stack.
   * @param {import('maplibre-gl').Map} map
   * @param {string} layerId
   */
  moveLayerOnTop (map, layerId) {
    const order = this._getLayersAndSublayersOrder(map)
    const targetIndex = order.findIndex(entry => entry.id === layerId)
    if (targetIndex === -1) {
      console.warn(`[LayerManager] Cannot move layer on top: layer "${layerId}" not found.`)
      return
    }

    for (const sublayerId of order[targetIndex].sublayers) {
      map.moveLayer(sublayerId)
    }
  }

  /**
   * Moves a layer (all of its MapLibre sublayers) to the bottom of the stack.
   * @param {import('maplibre-gl').Map} map
   * @param {string} layerId
   */
  moveLayerOnBottom (map, layerId) {
    const order = this._getLayersAndSublayersOrder(map)
    const targetIndex = order.findIndex(entry => entry.id === layerId)
    if (targetIndex === -1) {
      console.warn(`[LayerManager] Cannot move layer on bottom: layer "${layerId}" not found.`)
      return
    }

    for (const sublayerId of order[targetIndex].sublayers) {
      map.moveLayer(sublayerId, order[0].sublayers[0])
    }
  }

  /**
   * Moves a layer (all of its MapLibre sublayers) directly above another layer.
   * @param {import('maplibre-gl').Map} map
   * @param {string} layerId - layer to move
   * @param {string} targetLayerId - reference layer to move above
   */
  moveLayerOver (map, layerId, targetLayerId) {
    const order = this._getLayersAndSublayersOrder(map)
    const targetIndex = order.findIndex(entry => entry.id === layerId)
    const referenceIndex = order.findIndex(entry => entry.id === targetLayerId)
    if (targetIndex === -1 || referenceIndex === -1) {
      console.warn(`[LayerManager] Cannot move layer over: layer "${layerId}" or "${targetLayerId}" not found.`)
      return
    }

    // As moveLayer moves the layer under the reference layer, we need to move it under the next layer in the order
    const nextIndex = referenceIndex + 1
    const nextLayerId = nextIndex < order.length ? order[nextIndex].sublayers[0] : null

    for (const sublayerId of order[targetIndex].sublayers) {
      map.moveLayer(sublayerId, nextLayerId)
    }
  }

  /**
   * Moves a layer (all of its MapLibre sublayers) directly below another layer.
   * @param {import('maplibre-gl').Map} map
   * @param {string} layerId - layer to move
   * @param {string} targetLayerId - reference layer to move under
   */
  moveLayerUnder (map, layerId, targetLayerId) {
    const order = this._getLayersAndSublayersOrder(map)
    const targetIndex = order.findIndex(entry => entry.id === layerId)
    const referenceIndex = order.findIndex(entry => entry.id === targetLayerId)
    if (targetIndex === -1 || referenceIndex === -1) {
      console.warn(`[LayerManager] Cannot move layer under: layer "${layerId}" or "${targetLayerId}" not found.`)
      return
    }

    for (const sublayerId of order[targetIndex].sublayers) {
      map.moveLayer(sublayerId, order[referenceIndex].sublayers[0])
    }
  }

  // ── Legend ─────────────────────────────────────────────────────────────────

  getLegend () {
    const legend = []
    for (const [layerId, layer] of this._layerRegistry.entries()) {
      const layerLegend = layer.getLegend()
      if (layerLegend) {
        legend.push({ layerId, legend: layerLegend })
      }
    }
    return legend
  }

  getLayerLegend (layerId) {
    const layer = this._layerRegistry.get(layerId)
    if (!layer) {
      console.warn(`[LayerManager] Cannot get legend: layer "${layerId}" not found.`)
      return
    }
    return layer.getLegend()
  }

  // ── TODO  ──────────────────────────────────────────────────────────────────

  /**
   * - clustering options
   * - visibility ranges
   * - popup | tooltip
   */

  // ── Private Methods ────────────────────────────────────────────────────────

  /**
   * Groups the MapLibre style's raw layers back into business layer entries,
   * by splitting each MapLibre layer id on `LAYER_ID_SEPARATOR` (a business
   * layer can own several MapLibre sublayers, e.g. `VectorLayerAdapter`'s
   * fill + stroke + hull layers). Assumes sublayers of the same business
   * layer are contiguous in `map.getStyle().layers`.
   * @param {import('maplibre-gl').Map} map
   * @returns {{ id: string, sublayers: string[] }[]} bottom-to-top
   */
  _getLayersAndSublayersOrder (map) {
    const layers = []
    let currentLayer = null
    for (const layer of map.getStyle().layers) {
      const layerId = layer.id.split(LAYER_ID_SEPARATOR)[0]

      // `!currentLayer` MUST be checked before dereferencing `currentLayer.id`
      // — it starts `null`, and accessing `.id` on `null` throws.
      if (!currentLayer || layerId !== currentLayer.id) {
        if (currentLayer) layers.push(currentLayer)

        currentLayer = { id: layerId, sublayers: [layer.id] }
      } else {
        currentLayer.sublayers.push(layer.id)
      }
    }
    if (currentLayer) layers.push(currentLayer)
    return layers
  }

  /**
   * Lazily creates (and thereafter returns) the single `LayerFactory` instance.
   * @returns {LayerFactory}
   */
  _getLayerFactory () {
    if (!this._layerFactory) {
      this._layerFactory = new LayerFactory()
    }
    return this._layerFactory
  }

  /**
   * Resolves a business layer id to its currently-active `LayerAdapter`
   * (2D or 3D, per the engine's current render mode).
   * @param {string} id
   * @returns {import('./adapters/LayerAdapter.js').LayerAdapter | undefined}
   */
  _getLayerFromRegistry (id) {
    return this._layerRegistry.get(id)?.getLayerAdapter(this._engineContext.isRenderMode2D())
  }
}
