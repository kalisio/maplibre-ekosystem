/**
 * @file Layer.js
 * @description Composite, business-facing layer: one instance per
 * `definition.id`, holding at most two `LayerAdapter`s (2D and 3D) and
 * choosing which one is active based on the engine's current render mode.
 *
 * This class used to be named `MetaLayer`; the per-render-engine
 * implementation (provider, temporal strategy, filters, style...) used to
 * be named `Layer` and is now `LayerAdapter` (see `./adapters/LayerAdapter.js`).
 *
 * `_definition`/`_map`/`_context` live here rather than on each
 * `LayerAdapter` (2026-09-16): a layer's definition/map/context don't
 * depend on which rendering engine is currently displaying it — a 2D and a
 * 3D adapter for the SAME business layer must see the exact same
 * definition/map/context object, not two independently-constructed copies.
 * `LayerAdapter` now holds a reference to its owning `Layer` instead
 * (`_layer`, set in its constructor) and reads these three via `Layer`'s
 * accessors below (`getDefinition()`/`getMap()`/`getContext()`) — see
 * `LayerAdapter`'s own `_definition`/`_map`/`_context` getters, which
 * delegate here so existing `this._definition`/`this._map`/`this._context`
 * usage throughout every `LayerAdapter` subclass kept working unchanged.
 */

import { INTERNAL_EVENTS } from './InternalEvents.js'

export class Layer {
  _definition

  _map

  _context

  _2DLayer

  _3DLayer

  _renderType = 'multiple' // unique | multiple

  _isVisible = true

  _lastRenderMode = '2D' // TODO Should not be right, should be initialized from the map's current render mode

  /**
   * Builds the composite layer and subscribes it to render-mode changes so
   * it can swap its active adapter automatically.
   * @param {Object} definition - business layer definition (`id`, `type`, etc.)
   * @param {import('maplibre-gl').Map} map - internal `maplibregl.Map` instance
   * @param {import('./contexts/AdapterContext.js').AdapterContext} context - narrow, read-only view of `LayerManager`, shared by both of this layer's adapters
   */
  constructor (definition, map, context) {
    this._definition = definition
    this._map = map
    this._context = context
    map.on(INTERNAL_EVENTS.RENDER_MODE_CHANGED, (event) => {
      const is2DMode = event.mode === '2D'
      this.changeRenderMode(is2DMode)
    })
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  /**
   * @returns {Object} the original business layer definition, shared by both
   *   of this layer's adapters (mutated in place, e.g. by
   *   `LayerAdapter._loadProviderData()` setting `.data`).
   */
  getDefinition () {
    return this._definition
  }

  /**
   * @returns {import('maplibre-gl').Map} the internal `maplibregl.Map` instance
   */
  getMap () {
    return this._map
  }

  /**
   * @returns {import('./contexts/AdapterContext.js').AdapterContext}
   */
  getContext () {
    return this._context
  }

  /**
   * @returns {boolean} whether the layer is currently visible
   */
  isVisible () {
    return this._isVisible
  }

  /**
   * Attaches this layer's 2D `LayerAdapter`. Called once by `LayerFactory`
   * right after construction, before `initialize()`.
   * @param {import('./adapters/LayerAdapter.js').LayerAdapter} layer
   */
  set2DLayer (layer) {
    this._2DLayer = layer
  }

  /**
   * Attaches this layer's 3D `LayerAdapter`. Called once by `LayerFactory`
   * right after construction, before `initialize()`.
   * @param {import('./adapters/LayerAdapter.js').LayerAdapter} layer
   */
  set3DLayer (layer) {
    this._3DLayer = layer
  }

  /**
   * Initializes the adapter(s) relevant to the current render mode: both, if
   * `_renderType` is `'multiple'` and only one adapter was provided (so it
   * shows in both modes); otherwise only the one matching `is2DMode`.
   * @param {boolean} is2DMode
   */
  initialize (is2DMode) {
    const hasBothRenderModeLayer = this._2DLayer && this._3DLayer
    if (this._renderType === 'unique' || hasBothRenderModeLayer) {
      if (is2DMode) {
        this._2DLayer?.initialize()
      } else {
        this._3DLayer?.initialize()
      }
    } else {
      this._2DLayer?.initialize()
      this._3DLayer?.initialize()
    }
  }

  /**
   * Makes the layer visible (subject to the current render mode).
   */
  show () {
    this._isVisible = true
    this._refreshVisibility()
  }

  /**
   * Hides the layer entirely, regardless of render mode.
   */
  hide () {
    this._isVisible = false
    this._refreshVisibility()
  }

  /**
   * Sets whether a single-adapter layer shows in both render modes
   * (`'multiple'`, the default) or only in the mode matching its adapter
   * (`'unique'`).
   * @param {'unique' | 'multiple'} renderType
   * @throws {Error} if `renderType` is neither `'unique'` nor `'multiple'`
   */
  setRenderType (renderType) { // unique | multiple
    // Unique: if only one of the layers is provided, it will be displayed only in the corresponding render mode
    // Multiple: if only one of the layers is provided, it will be displayed in both render modes
    if (renderType !== 'unique' && renderType !== 'multiple') {
      throw new Error(`[Layer] Invalid render type "${renderType}". Use "unique" or "multiple".`)
    }
    this._renderType = renderType
  }

  /**
   * Returns the `LayerAdapter` currently relevant for the given render mode.
   * @param {boolean} is2DMode
   * @returns {import('./adapters/LayerAdapter.js').LayerAdapter | undefined}
   */
  getLayerAdapter (is2DMode) {
    if (this._renderType === 'unique') {
      return is2DMode ? this._2DLayer : this._3DLayer
    }
    return this._2DLayer || this._3DLayer
  }

  /**
   * Called whenever the engine's render mode changes.
   * Refreshes visibility so the active `LayerAdapter` actually switches —
   * previously this only recorded `_lastRenderMode` without ever calling
   * `_refreshVisibility()`, so a render-mode switch never actually swapped
   * which adapter was shown.
   * @param {boolean} is2DMode
   */
  changeRenderMode (is2DMode) {
    this._lastRenderMode = is2DMode ? '2D' : '3D'
    this._refreshVisibility()
  }

  /**
   * Releases both adapters' resources. Called by `LayerManager.remove()`.
   */
  destroy () {
    this._2DLayer?.destroy()
    this._3DLayer?.destroy()
  }

  /**
   * Applies `_isVisible`/`_lastRenderMode` to the adapter(s), (re)initializing
   * them if needed, and catches up any data load an adapter skipped while
   * hidden (`LayerAdapter.ensureDataLoaded()`). Called whenever visibility or
   * the render mode changes.
   * @todo Should also propagate filters if any are defined on the layer.
   */
  // This method should be called whenever the visibility of the layer changes, or when the render mode changes
  // It will ensure that the correct layer is visible based on the current render mode and visibility state
  // And should do the same with filters if any are defined on the layer
  _refreshVisibility () {
    const is2DMode = this._lastRenderMode === '2D'
    const hasBothRenderModeLayer = !!(this._2DLayer && this._3DLayer)
    this.initialize(is2DMode)
    if (this._renderType === 'unique' || hasBothRenderModeLayer) {
      const show3D = this._isVisible && !is2DMode
      const show2D = this._isVisible && is2DMode
      this._3DLayer?.setVisibility(show3D)
      this._2DLayer?.setVisibility(show2D)
      if (show3D) this._3DLayer.ensureDataLoaded()
      if (show2D) this._2DLayer.ensureDataLoaded()
    } else {
      // A single adapter in 'multiple' mode shows in both render modes —
      // matches neither branch above, so it's applied unconditionally here.
      this._2DLayer?.setVisibility(this._isVisible)
      this._3DLayer?.setVisibility(this._isVisible)
      if (this._isVisible) {
        this._2DLayer?.ensureDataLoaded()
        this._3DLayer?.ensureDataLoaded()
      }
    }
  }
}
