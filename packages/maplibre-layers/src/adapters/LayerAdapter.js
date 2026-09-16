/**
 * @file LayerAdapter.js
 * @description Abstract base class for "adapt a business layer definition to
 * one specific rendering engine" — MapLibre native, Three.js, deck.gl.
 *
 * This class used to be named `Layer`. It is now `LayerAdapter` because the
 * composite, business-facing object (one per `definition.id`, holding a 2D
 * and/or a 3D `LayerAdapter`) is the one now named `Layer` (see `../Layer.js`).
 *
 * A `LayerAdapter` receives an `AdapterContext` (not the full `LayerManager`)
 * — see `../contexts/AdapterContext.js` for exactly which capabilities it exposes.
 *
 * `_definition`/`_map`/`_context` are NOT owned by this class (2026-09-16):
 * they live on the owning `Layer` instead, since they must be shared
 * identically between a layer's 2D and 3D adapter — see `../Layer.js`'s file
 * header for the full rationale. This class only holds a reference to that
 * `Layer` (`_layer`) and exposes `_definition`/`_map`/`_context` as getters
 * delegating to it, so every existing `this._definition`/`this._map`/
 * `this._context` read throughout this class and its subclasses keeps
 * working unchanged.
 */

import { NDimensionalMixin } from './mixins/NDimensionalMixin.js'

import { parseStyle } from '../utils/index.js'
import { FilterStrategy, SetDataStrategy, UrlStrategy } from '../strategies/index.js'
import { KazarrProvider, KmlProvider } from '../providers/index.js'
import { INTERNAL_EVENTS } from '../InternalEvents.js'

const TEMPORAL_STRATEGIES = {
  filter: new FilterStrategy(),
  'set-data': new SetDataStrategy(),
  url: new UrlStrategy()
}

export const LAYER_ID_SEPARATOR = '~'

export class LayerAdapter {
  _initialized = false

  /**
   * Set once `_loadProviderData()` has actually fetched/applied data — an
   * invisible-layer skip (see that method's guard) leaves this `false`, so
   * `ensureDataLoaded()` knows to catch up once the layer becomes visible.
   */
  _dataLoaded = false

  // ── Identity ────────────────────────────────────────────────────────────────

  /** @type {string} Business identifier */
  _id

  /** @type {import('../Layer.js').Layer} owning composite layer — see this file's header */
  _layer

  _provider
  _temporalStrategy

  _filters // { id: string, active: true|false, expression: [], layers: [], style: {} }
  _layers // if filters are not used, this is the list of MapLibre layer ids that are part of this layer

  /**
   * @param {import('../Layer.js').Layer} layer - owning composite layer, whose `getDefinition()`/`getMap()`/`getContext()` back this adapter's `_definition`/`_map`/`_context`
   */
  constructor (layer) {
    this._layer = layer
    this._id = layer.getDefinition().id
  }

  // ── Shared state, delegated to the owning Layer ──────────────────────────────

  /** @returns {Object} Original layer definition, shared with the sibling (2D/3D) adapter */
  get _definition () {
    return this._layer.getDefinition()
  }

  /** @returns {import('maplibre-gl').Map} */
  get _map () {
    return this._layer.getMap()
  }

  /** @returns {import('../contexts/AdapterContext.js').AdapterContext} */
  get _context () {
    return this._layer.getContext()
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Must not be overridden by subclasses. Use `_initialize()` and `_postInitialize()` instead.
   * Idempotent — a second call is a no-op once `_initialized` is `true`.
   */
  initialize () {
    if (this._initialized) return
    this._initialize()
    this._postInitialize()
    this._initialized = true
  }

  /**
   * Subclass hook run first by `initialize()`: create MapLibre/Three.js/deck.gl
   * sources and layers here. Base implementation only resolves the data
   * provider (`_createProvider()`), from `definition.format`/`definition.url`.
   */
  _initialize () {
    this._provider = LayerAdapter._createProvider(this._definition)
  }

  /**
   * Subclass hook run last by `initialize()`, after `_initialize()`. Base
   * implementation triggers the initial data load if a provider was resolved.
   */
  _postInitialize () {
    if (this._provider) {
      this._loadProviderData()
    }
  }

  /**
   * Releases the resources this adapter acquired in `_initialize()`/
   * `_postInitialize()` (MapLibre sources/layers, shared 3D scene group,
   * deck.gl layer, DOM markers, etc.). No-op by default — subclasses that
   * acquire resources must override it.
   */
  destroy () {

  }

  // ── Visibility ─────────────────────────────────────────────────────────────

  /**
   * Toggles the adapter's rendered content on/off. Must be implemented by subclasses.
   * @param {boolean} visible
   */
  setVisibility (visible) {
    throw new Error('setVisibility() must be implemented by subclasses')
  }

  /**
   * Returns the layer's geographic bounding box. Must be implemented by subclasses.
   * @returns {[[number, number], [number, number]]}
   */
  getBounds () {
    throw new Error('getBounds() must be implemented by subclasses')
  }

  // ── Filters ────────────────────────────────────────────────────────────────

  /**
   * Replaces the full set of filters, preserving any already-resolved
   * `layers`/`style` for filters whose `id` matches an existing one.
   * @param {{ id: string, expression: Array, active?: boolean, layers?: string[], style?: Object }[]} filters
   * @throws {Error} if a filter is missing `id` or `expression`
   */
  setFilters (filters) {
    for (const filter of filters) {
      if (!filter.id) {
        throw new Error('Filter must have a unique "id"')
      }
      if (!filter.expression) {
        throw new Error('Filter must have an "expression"')
      }

      const existing = this._filters?.find(f => f.id === filter.id)
      if (existing) {
        if (existing.layers) filter.layers = existing.layers
        if (existing.style && !filter.style) filter.style = existing.style
      } else {
        filter.layers = []
      }
    }

    this._filters = filters
    this._refreshLayers()
  }

  /**
   * Appends one filter to the existing set.
   * @param {{ id: string, expression: Array, active?: boolean }} filter
   * @throws {Error} if the filter is missing `id` or `expression`
   */
  addFilter (filter) {
    if (!filter.id) {
      throw new Error('Filter must have a unique "id"')
    }
    if (!filter.expression) {
      throw new Error('Filter must have an "expression"')
    }
    this._filters.push(filter)
    this._refreshLayers()
  }

  /**
   * Removes a filter by id. No-op if not found.
   * @param {string} filterId
   */
  removeFilter (filterId) {
    const index = this._filters.findIndex((f) => f.id === filterId)
    if (index !== -1) {
      this._filters.splice(index, 1)
    }
    this._refreshLayers()
  }

  /**
   * Activates or deactivates one filter by id. No-op if not found.
   * @param {string} filterId
   * @param {boolean} active
   */
  setFilterActive (filterId, active) {
    const filter = this._filters.find((f) => f.id === filterId)
    if (filter) {
      filter.active = active
      this._refreshLayers()
    }
  }

  // ── Styling ────────────────────────────────────────────────────────────────

  /**
   * Applies a style, optionally scoped to one filter's sublayers. Must be
   * implemented by subclasses.
   * @param {Object} style
   * @param {string} [filterId]
   */
  applyStyle (style, filterId = null) {
    throw new Error('applyStyle() must be implemented by subclasses')
  }

  /**
   * Resets the style to the default style defined in the layer definition,
   * optionally scoped to one filter. Must be implemented by subclasses.
   * @param {string} [filterId]
   */
  resetStyle (filterId = null) {
    throw new Error('resetStyle() must be implemented by subclasses')
  }

  // ── Time management ───────────────────────────────────────────────────────

  /**
   * @returns {boolean} whether `definition.temporal` is set
   */
  isTemporal () {
    return !!this._definition?.temporal
  }

  /**
   * Applies a temporal update via the resolved `TemporalStrategy`
   * (`FilterStrategy` | `SetDataStrategy` | `UrlStrategy`). No-op if
   * the layer isn't temporal, or if no strategy could be resolved.
   * @param {Date} time
   * @returns {Promise<void>}
   */
  async setTime (time) {
    if (!this.isTemporal()) return

    const strategy = this._getTemporalStrategy()
    if (!strategy) {
      console.warn(`[LayerAdapter] No temporal strategy defined for layer "${this._id}". Skipping temporal update.`)
      return
    }
    return await strategy.apply(this, time)
  }

  // ── Data management ───────────────────────────────────────────────────────

  /**
   * Re-fetches the provider's data (e.g. after a filter/level/parameter
   * change unrelated to time) and re-applies it to the underlying source.
   * @param {Object} [options] - forwarded to the provider's `get()`
   * @returns {Promise<void>}
   */
  async reloadData (options = null) {
    await this._loadProviderData(options)
  }

  // ── 3D related methods ────────────────────────────────────────────────────

  /**
   * @returns {boolean} whether this layer's type is inherently 3D (`'mesh'` or `'point-cloud'`)
   */
  is3D () {
    return this._definition?.type === 'mesh' || this._definition?.type === 'point-cloud'
  }

  /**
   * @returns {boolean} whether the 3D rendering of this layer differs from
   *   its 2D rendering (used by `Layer` to decide whether a single adapter
   *   can be reused across both render modes). Must be implemented by subclasses.
   */
  has3dRenderDifferentFrom2d () {
    throw new Error('has3dRenderDifferentFrom2d() must be implemented by subclasses')
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  /**
   * @returns {Object} the original business layer definition
   */
  getDefinition () {
    return this._definition
  }

  /**
   * Returns the underlying MapLibre `GeoJSONSource` (or equivalent) so a
   * `TemporalStrategy` can call `setData()` on it. Must be implemented by subclasses.
   * @returns {Object}
   */
  getSource () {
    throw new Error('getSource() must be implemented by subclasses')
  }

  // ── Private Methods ───────────────────────────────────────────────────────

  /**
   * Lazily resolves (and caches) the `TemporalStrategy` instance for this
   * layer, via `_resolveTemporalStrategy()`.
   * @returns {import('../strategies/index.js').FilterStrategy | import('../strategies/index.js').SetDataStrategy | import('../strategies/index.js').UrlStrategy}
   */
  _getTemporalStrategy () {
    if (!this._temporalStrategy) {
      const strategyName = LayerAdapter._resolveTemporalStrategy(this._definition)
      this._temporalStrategy = TEMPORAL_STRATEGIES[strategyName]
    }

    return this._temporalStrategy
  }

  /**
   * Rebuilds/re-applies this adapter's MapLibre layers from `_filters`
   * (or `_layers` when filters aren't used). Called whenever filters change.
   * Must be implemented by subclasses.
   */
  _refreshLayers () {
    throw new Error('_refreshLayers() must be implemented by subclasses')
  }

  /**
   * Parses a business/MapLibre style via this package's own `utils/`
   * `parseStyle()`, merged with the app default style, registering any
   * generated icon image on `_map` once it loads.
   * @param {Object} style
   * @param {string} layerType - e.g. `'vector'`, `'raster'`
   * @returns {Object} `{ type, paint, layout }`
   */
  _parseStyle (style, layerType) {
    return parseStyle(
      style,
      layerType,
      this._context.getAppDefaultStyle() || {},
      (iconName, iconImage) => {
        if (iconName && iconImage && !this._map.hasImage(iconName)) {
          this._map.addImage(iconName, iconImage)
        }
      }
    )
  }

  /**
   * Fetches fresh data from `_provider` (defaulting `options.time` to the
   * engine's global time), stores it on `definition.data`, pushes it to
   * `getSource()`, and fires `INTERNAL_EVENTS.LAYER_DATA_UPDATED`.
   * @param {Object} [options] - forwarded to the provider's `get()`
   * @param {boolean} [force=false] - if `true`, force to load data even if the layer is invisible
   * @returns {Promise<void>}
   */
  async _loadProviderData (options = null, force = false) {
    if (!force && !this._layer.isVisible()) {
      console.warn(`[LayerAdapter] Skipping data load for invisible layer "${this._id}"`)
      return
    }

    if (this._provider) {
      if (!options?.time) {
        if (!options) options = {}
        options.time = this._context.getGlobalTime() ?? undefined
      }
      this._definition.data = await this._provider.get(options)
    }

    this.getSource()?.setData(this._definition.data)
    this._dataLoaded = true

    this._map.fire(INTERNAL_EVENTS.LAYER_DATA_UPDATED, { layerId: this._id })
  }

  /**
   * Loads the provider's data if `_loadProviderData()` hasn't successfully
   * done so yet — catches up a layer whose initial load was skipped while
   * hidden (see the guard above), called by `Layer._refreshVisibility()`
   * whenever the layer becomes visible.
   * @returns {Promise<void>}
   */
  async ensureDataLoaded () {
    if (!this._dataLoaded) {
      await this._loadProviderData()
    }
  }

  /**
   * @param {Object} definition - layer definition
   * @returns {boolean} whether `definition` is one of the three Kazarr
   *   gridded-field renderings (`'raster'`, `'mesh'`, `'tiled-mesh'` with a
   *   `kazarr://` url) — the single predicate shared by
   *   `_resolveTemporalStrategy()` and `MapLibreLayerAdapter`'s
   *   `_postInitialize()`/`reloadUrlData()`, so it's only computed one way.
   */
  static isKazarrGriddedField (definition) {
    const type = definition.type
    const protocol = definition.url ? new URL(definition.url).protocol.replace(':', '') : null
    return protocol === 'kazarr' && (type === 'raster' || type === 'mesh' || type === 'tiled-mesh')
  }

  /**
   * Infers the temporal strategy from the layer type.
   *
   * @param {Object} definition - layer definition
   * @returns {string} Resolved temporal strategy
   */
  static _resolveTemporalStrategy (definition) {
    // Explicit strategy provided by the user → absolute priority
    if (definition.temporalStrategy) {
      return definition.temporalStrategy
    }

    if (LayerAdapter.isKazarrGriddedField(definition)) {
      return 'url'
    }

    const type = definition.type
    const protocol = definition.url ? new URL(definition.url).protocol.replace(':', '') : null

    switch (type) {
      case 'vector':
        if (protocol === 'kazarr') {
          return 'set-data'
        }
        return 'filter'

      case 'raster':
      case 'raster-dem':
      case 'wms':
        return 'url'

      case 'mesh':
      case 'point-cloud':
        return 'set-data'

      default:
        console.warn('[LayerAdapter] Unknown layer type, defaulting to \'filter\'', definition.type)
        return 'filter'
    }
  }

  /**
   * Instantiates the appropriate provider based on `definition.format` or `definition.url`.
   * Returns `undefined` if no provider is required.
   *
   * @param {Object} definition
   * @returns {Object | undefined}
   */
  static _createProvider (definition) {
    if (!definition?.format && !definition?.url) {
      return undefined
    }

    try {
      let type
      if (definition.url) {
        const url = new URL(definition.url)
        type = url.protocol.replace(':', '')
      }
      type = type || definition.format
      switch (type) {
        case 'kazarr':
          return new KazarrProvider(definition)
        case 'kml':
          return new KmlProvider(definition)
        default:
          console.warn('[LayerAdapter] Unknown provider type:', type)
          return undefined
      }
    } catch (e) {
      console.warn('[LayerAdapter] Invalid url format:', definition.url)
      return undefined
    }
  }
}

/**
 * `LayerAdapter` mixed with `NDimensionalMixin`'s coordinate/level/variable
 * API. Not directly instantiated by `LayerFactory` today (see `NDimensionalMixin.js`
 * for how the mixin is actually consumed).
 */
export class NDimensionalLayerAdapter extends NDimensionalMixin(LayerAdapter) {}
