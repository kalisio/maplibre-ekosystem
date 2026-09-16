/**
 * @file MapEngine.js
 * @description Main facade of the agnostic cartographic engine.
 *
 * `MapEngine` is the ONLY entry point used by the VueJS application.
 * It orchestrates all internal subsystems:
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │                      VueJS Application                      │
 * └──────────────────────────┬──────────────────────────────────┘
 *                            │ addLayer / setTime / setSubFilter
 *                            ▼
 * ┌─────────────────────────────────────────────────────────────┐
 * │                      MapEngine (Facade)                     │
 * │                                                             │
 * │  ┌────────────┐  ┌──────────────┐  ┌───────────────────┐   │
 * │  │StateManager│  │ LayerManager │  │   EventBus        │   │
 * │  └────────────┘  └──────────────┘  └───────────────────┘   │
 * │  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐     │
 * │  │ DrawManager │  │ SelectManager│  │  PopupManager  │     │
 * │  └─────────────┘  └──────────────┘  └────────────────┘     │
 * └─────────────────────────────────────────────────────────────┘
 *                            │
 *              ┌─────────────┴──────────────┐
 *              ▼                            ▼
 *     LayerManager (per-layer `Layer`,     ThreeJsSceneManager /
 *     composed of `LayerAdapter`s:         DeckGlManager
 *     MapLibreLayerAdapter, VectorLayerAdapter,
 *     ThreeJsLayerAdapter, DeckGlLayerAdapter)
 *
 * `MapEngine` only exposes a narrow `EngineContext` (time, app default
 * style, render mode) to `LayerManager` — it never hands out `StateManager`
 * itself. See `@kalisio/maplibre-layers` for how that context, and the
 * equivalent `AdapterContext` handed to each `LayerAdapter`, are built.
 */

import { Map as MapLibreMap, NavigationControl, ScaleControl } from 'maplibre-gl'
import { EventBus } from './EventBus.js'
import { StateManager } from './StateManager.js'
import { LayerManager, EngineContext, INTERNAL_EVENTS } from '@kalisio/maplibre-layers'
import { DrawManager, SelectManager, PopupManager } from '@kalisio/maplibre-interactions'

const SWITCH_RENDER_MODE_THRESHOLD = 2 // pitch in degrees

export class MapEngine {
  // ── Internal Rendering Engine ──────────────────────────────────────────────

  /**
   * Internal MapLibre GL JS instance.
   * NEVER exposed directly to VueJS — everything passes through this facade.
   * @type {import('maplibre-gl').Map}
   */
  _map

  // ── Internal Subsystems ────────────────────────────────────────────────────

  /** @type {EventBus} */
  _eventBus

  /** @type {StateManager} */
  _stateManager

  /** @type {LayerManager} */
  _layerManager

  /** @type {DrawManager} */
  _drawManager

  /** @type {SelectManager} */
  _selectManager

  /** @type {PopupManager} */
  _popupManager

  // ── Constructor ────────────────────────────────────────────────────────────

  /**
   * Initializes the complete cartographic engine.
   *
   * @param {HTMLElement} container - HTML container element of the map (div)
   * @param {Object} [options] - configuration options for the engine
   *
   * @example
   * const engine = new MapEngine(containerRef.value, {
   *   style: 'https://demotiles.maplibre.org/style.json',
   *   center: [2.3522, 48.8566],
   *   zoom: 10,
   * });
   */
  constructor (container, options = {}) {
    // ── Step 1: Initialize MapLibre GL ───────────────────────────────────────
    this._map = new MapLibreMap({
      container,
      style: options.style ?? 'https://demotiles.maplibre.org/style.json',
      center: options.center ?? [0, 0],
      zoom: options.zoom ?? 2,
      minZoom: options.minZoom,
      maxZoom: options.maxZoom
    })

    // Optional Controls
    if (options.navigationControl !== false) {
      this._map.addControl(new NavigationControl(), 'top-right')
    }
    if (options.scaleControl === true) {
      this._map.addControl(new ScaleControl(), 'bottom-left')
    }

    // ── Step 2: Instantiate Subsystems ───────────────────────────────────────
    this._eventBus = new EventBus()
    this._stateManager = new StateManager()
    // LayerManager never receives the StateManager instance itself, only a
    // narrow read-only view of the state it actually needs (see EngineContext).
    this._layerManager = new LayerManager(new EngineContext(this._stateManager))
    this._drawManager = new DrawManager(this._eventBus)
    this._selectManager = new SelectManager(this._map, this._eventBus)
    this._popupManager = new PopupManager(this._map, this._eventBus)

    // ── Step 3: Deferred Post-load Initialization ───────────────────────────
    this._map.on('load', () => {
      this._layerManager.initialize(this._map)
      this._drawManager.initialize(this._map)
      this._eventBus.emit('engine:ready')
    })

    // ── Step 4: MapLibre → EventBus Event Bridging ───────────────────────────
    this._bridgeMapLibreEvents()

    this._initializeInternalEvents()
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Releases all engine resources.
   * Must be called in the `onUnmounted()` hook of the parent Vue component.
   *
   * @emits `'engine:destroy'`
   */
  destroy () {
    this._eventBus.emit('engine:destroy')

    this._drawManager.destroy()
    this._selectManager.destroy()
    this._popupManager.destroy()
    this._eventBus.destroy()
    this._map.remove()
  }

  /**
   * Notifies MapLibre of a container size change.
   */
  resize () {
    this._map.resize()
  }

  // ── Event Management (VueJS API) ───────────────────────────────────────────

  /**
   * Subscribes a callback to an engine event.
   * @param {string} event - event type
   * @param {Function} callback - function called on each event emission
   */
  on (event, callback) {
    this._eventBus.on(event, callback)
  }

  /**
   * Unsubscribes a callback from an event.
   * @param {string} event - event type
   * @param {Function} callback - exact reference of the callback to remove
   */
  off (event, callback) {
    this._eventBus.off(event, callback)
  }

  // ── Layer Management ───────────────────────────────────────────────────────

  /**
   * **Main entry point for adding a layer.**
   *
   * @param {Object} definition - complete layer definition
   * @returns {Promise<void>}
   * @emits `'layer:added'` on success
   * @emits `'layer:error'` on failure
   */
  async addLayer (definition) {
    if (!definition || typeof definition !== 'object') {
      throw new Error('Layer definition must be a valid object.')
    }
    const id = definition.id
    if (!id || typeof id !== 'string') {
      throw new Error('Layer identifier must be a non-empty string.')
    }
    try {
      await this._layerManager.add(this._map, definition)

      this._eventBus.emit('layer:added', {
        layerId: id,
        layerType: definition.type
      })
    } catch (error) {
      this._eventBus.emit('layer:error', {
        layerId: id,
        message: error instanceof Error ? error.message : String(error),
        cause: error instanceof Error ? error : undefined
      })

      throw error
    }
  }

  /**
   * Removes a layer from the engine and releases its resources.
   * @param {string} id
   * @emits `'layer:removed'`
   */
  removeLayer (id) {
    this._layerManager.remove(this._map, id)
    this._eventBus.emit('layer:removed', { layerId: id })
  }

  /**
   * Modifies the visibility of a layer.
   * @param {string} id
   * @param {boolean} visible
   * @emits `'layer:visibility'`
   */
  setLayerVisibility (id, visible) {
    this._layerManager.setVisibility(id, visible)
    this._eventBus.emit('layer:visibility', { layerId: id, visible })
  }

  /**
   * Returns available vertical levels for a layer.
   * @param {string} id
   * @returns {number[]}
   */
  getLayerLevels (id) {
    // TODO: extract levels from Zarr metadata (LayerManager -> layer -> provider.getVariables()/getCoordinates())
    return []
  }

  /**
   * Selects a vertical level for a multi-level layer.
   * @param {string} id
   * @param {number} level
   */
  setLayerLevel (id, level) {
    console.log('[MapEngine] Setting level for layer', id, 'to', level)
    return this._layerManager.setLayerLevel(id, level)
  }

  // ── Temporal Management ────────────────────────────────────────────────────

  /**
   * **Temporal update of a layer.**
   *
   * @param {Date} time - new temporal instant
   * @param {string[]} ids - array of layer identifiers
   * @returns {Promise<void>}
   * @emits `'time:changed'`
   * @emits `'time:applied'`
   */
  async setTime (time, ids = null) {
    this._stateManager.setTime(time)
    this._eventBus.emit('time:changed', { time })

    await this._layerManager.setTime(time, ids)
    this._eventBus.emit('time:applied', { time, layerIds: ids })
  }

  // ── Cross-filtering ────────────────────────────────────────────────────────

  /**
   * **Activates or deactivates a named sub-filter.**
   *
   * @param {string} layerId - target layer identifier
   * @param {string} filterId - business identifier of the filter
   * @param {boolean} active - whether the filter should be active
   * @emits `'filter:active'`
   */
  setFilterActive (layerId, filterId, active) {
    this._layerManager.setFilterActive(layerId, filterId, active)

    this._eventBus.emit('filter:active', {
      layerId,
      filterId,
      active
    })
  }

  // ── Multi-dimensional ──────────────────────────────────────────────────────

  /**
   * Returns the available coordinate dimensions of a multi-dimensional
   * (Kazarr-backed) layer, e.g. `['time', 'level', 'latitude', 'longitude']`.
   * @param {string} layerId
   * @returns {Promise<string[]>}
   */
  async getCoordinates (layerId) {
    return await this._layerManager.getCoordinates(layerId)
  }

  /**
   * Returns the available data variables of a multi-dimensional
   * (Kazarr-backed) layer, e.g. `['temperature', 'wind_speed']`.
   * @param {string} layerId
   * @returns {Promise<string[]>}
   */
  async getVariables (layerId) {
    return await this._layerManager.getVariables(layerId)
  }

  /**
   * Returns the values and metadata of one coordinate dimension of a
   * multi-dimensional (Kazarr-backed) layer.
   * @param {string} layerId
   * @param {string} coordinateName - e.g. `'level'`, `'time'`
   * @returns {Promise<{ values: Array, metadata: Object }>}
   */
  async getCoordinate (layerId, coordinateName) {
    return await this._layerManager.getCoordinate(layerId, coordinateName)
  }

  // ── Style Management ───────────────────────────────────────────────────────

  /**
   * ** Defines the application default style.**
   * This style is used as a fallback for layers that do not provide their own style.
   * The actual parsing into a MapLibre style happens per-layer, in `LayerAdapter`,
   * because the result depends on the layer type — MapEngine only stores the raw value.
   *
   * @param {Object} style KDK style or MapLibre style
   */
  defineDefaultStyle (style) {
    this._stateManager.setAppDefaultStyle(style)
  }

  /**
   * **Applies a style to a layer or a filter.**
   *
   * @param {string} layerId
   * @param {Object} style
   * @param {string} filterId
   */
  applyStyle (layerId, style, filterId = null) {
    return this._layerManager.applyStyle(layerId, style, filterId)
  }

  // ── Map Navigation ─────────────────────────────────────────────────────────

  /**
   * Animates the camera to a new center/zoom.
   * @param {number} lon
   * @param {number} lat
   * @param {number} [zoom]
   * @param {Object} [options] - extra `maplibregl.Map#flyTo` options (merged in, override `center`/`zoom`)
   */
  flyTo (lon, lat, zoom, options = {}) {
    this._map.flyTo({
      center: [lon, lat],
      zoom,
      ...options
    })
  }

  /**
   * Fits the camera to a layer's bounds.
   * No-op (with a console warning) if the layer isn't found or its adapter
   * can't compute bounds (see `LayerAdapter.getBounds()`).
   * @param {string} layerId
   * @param {Object} [options] - passed through to `maplibregl.Map#fitBounds`
   */
  flyToLayer (layerId, options = {}) {
    const bounds = this._layerManager.getLayerBounds(layerId)
    if (bounds) {
      this._map.fitBounds(bounds, options)
    } else {
      console.warn(`[MapEngine] Cannot fly to layer "${layerId}" — bounds not available.`)
    }
  }

  /**
   * @param {[[number, number], [number, number]]} bounds
   * @param {Object} [options]
   */
  fitBounds (bounds, options = {}) {
    this._map.fitBounds(bounds, options)
  }

  /**
   * @returns {[[number, number], [number, number]]}
   */
  getBounds () {
    const bounds = this._map.getBounds()
    return [
      [bounds.getWest(), bounds.getSouth()],
      [bounds.getEast(), bounds.getNorth()]
    ]
  }

  /** @param {number} zoom */
  setZoom (zoom) {
    this._map.setZoom(zoom)
  }

  /** @returns {number} */
  getZoom () {
    return this._map.getZoom()
  }

  /**
   * @param {number} lon
   * @param {number} lat
   */
  setCenter (lon, lat) {
    this._map.setCenter([lon, lat])
  }

  /** @returns {[number, number]} */
  getCenter () {
    const center = this._map.getCenter()
    return [center.lng, center.lat]
  }

  // ── Drawing Tools ──────────────────────────────────────────────────────────

  /**
   * Activates a geometric drawing tool. See `DrawManager.setTool()` for the
   * accepted `toolName` values.
   * @param {string} toolName
   * @param {Object} [options] - visual options of the tool (colors, stroke, etc.)
   */
  setDrawTool (toolName, options) {
    this._drawManager.setTool(toolName, options)
  }

  /**
   * Deactivates the active drawing tool, keeping the geometries drawn so far
   * (retrievable via `DrawManager.getFeatures()` internally).
   */
  stopDrawing () {
    this._drawManager.stopDrawing()
  }

  // ── Legend ─────────────────────────────────────────────────────────────────

  /**
   * @todo Not implemented yet — placeholder for the application-wide legend.
   */
  getLegend () {

  }

  /**
   * @todo Not implemented yet — placeholder for a per-layer legend.
   * @param {string} layerId
   */
  getLayerLegend (layerId) {

  }

  // ── TODO ───────────────────────────────────────────────────────────────────

  /**
   * - isMultidimensionalLayer
   * - getNotFixedDimension
   * - setDimension
   */

  // ── Internal Method ────────────────────────────────────────────────────────

  /**
   * Emits a typed event via the internal bus.
   * @internal — library usage only, do not call from VueJS.
   * @param {string} event
   * @param {Object} [data]
   */
  _emit (event, data) {
    this._eventBus.emit(event, data)
  }

  // ── Private Methods ────────────────────────────────────────────────────────

  /**
   * Bridges native MapLibre events to the typed event bus.
   */
  _bridgeMapLibreEvents () {
    this._map.on('movestart', () => {
      this._eventBus.emit('map:movestart')
    })

    this._map.on('moveend', () => {
      const center = this._map.getCenter()
      this._eventBus.emit('map:moveend', {
        center: [center.lng, center.lat],
        zoom: this._map.getZoom()
      })
    })

    this._map.on('zoomstart', () => {
      this._eventBus.emit('map:zoomstart')
    })

    this._map.on('zoomend', () => {
      this._eventBus.emit('map:zoomend', { zoom: this._map.getZoom() })
    })

    this._map.on('error', (e) => {
      this._eventBus.emit('engine:error', {
        message: e.error?.message ?? 'MapLibre internal error',
        cause: e.error
      })
    })
  }

  /**
   * Watches the map pitch and, when it crosses `SWITCH_RENDER_MODE_THRESHOLD`,
   * flips the engine's 2D/3D render mode. Broadcasts the change on two buses,
   * each with a distinct audience:
   * - `EventBus` (`'engine:render-mode:changed'`) — public, for VueJS.
   * - MapLibre's native event bus (`INTERNAL_EVENTS.RENDER_MODE_CHANGED`) —
   *   internal, for engine subsystems (e.g. the composite `Layer`, which
   *   switches its active 2D/3D `LayerAdapter` in reaction to it).
   */
  _initializeInternalEvents () {
    this._map.on('pitchend', () => {
      const wasIs2D = this._stateManager.isRenderMode2D()
      const isNowIs2D = this._map.getPitch() < SWITCH_RENDER_MODE_THRESHOLD
      this._stateManager.setRenderMode(isNowIs2D)

      if (wasIs2D !== isNowIs2D) {
        const mode = isNowIs2D ? '2D' : '3D'
        this._eventBus.emit('engine:render-mode:changed', { mode })
        this._map.fire(INTERNAL_EVENTS.RENDER_MODE_CHANGED, { mode })
      }
    })
  }
}
