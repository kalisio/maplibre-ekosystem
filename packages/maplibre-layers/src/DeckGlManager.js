/**
 * @file DeckGlManager.js
 * @description Owns the single `MapboxOverlay` (deck.gl) control for one
 * MapLibre map instance, symmetrical to `ThreeJsSceneManager`.
 *
 * Instantiated once per map (by `LayerManager.initialize()`) and keeps every
 * registered deck.gl layer in a `Map`, so `setProps({ layers })` is always
 * given the full, current set — this is what lets multiple point-cloud/mesh
 * layers coexist on the same map without one overwriting another.
 */

import { MapboxOverlay } from '@deck.gl/mapbox'

export class DeckGlManager {
  _map

  /**
   * Created lazily, on the first `setLayer()` call — not in the constructor.
   * `LayerManager.initialize()` builds a `DeckGlManager` for every map
   * unconditionally, even when the app never adds a single point-cloud/mesh
   * layer. An interleaved `MapboxOverlay` hooks into MapLibre's WebGL render
   * pipeline as soon as it's added as a control, and doing that before any
   * layer/camera activity has been observed to leave the base map's own
   * tiles rendering black until the next full repaint (e.g. a pitch
   * change) — so we only pay that cost when a deck.gl layer actually exists.
   */
  _overlay = null

  /**
   * deck.gl layer instances, keyed by business layer id.
   * @type {Map<string, Object>}
   */
  _layers = new Map()

  /**
   * @param {import('maplibre-gl').Map} map
   */
  constructor (map) {
    this._map = map
  }

  /**
   * Registers or replaces the deck.gl layer instance for a given business layer id.
   * @param {string} id
   * @param {Object} deckLayer - a deck.gl Layer instance
   */
  setLayer (id, deckLayer) {
    this._layers.set(id, deckLayer)
    this._redraw()
  }

  /**
   * Toggles the visibility of one layer without touching the others.
   * @param {string} id
   * @param {boolean} visible
   */
  setLayerVisibility (id, visible) {
    const layer = this._layers.get(id)
    if (!layer) return
    this.setLayer(id, layer.clone({ visible }))
  }

  /**
   * Removes a layer's deck.gl instance.
   * @param {string} id
   */
  removeLayer (id) {
    this._layers.delete(id)
    // Nothing to redraw if the overlay was never created (no deck.gl layer
    // was ever added) — avoid creating it just to remove nothing from it.
    if (this._overlay) this._redraw()
  }

  /**
   * Pushes the full current set of registered deck.gl layers to the overlay
   * (deck.gl replaces its whole layer array on every `setProps()` call, so
   * this always sends every layer, not just the one that changed).
   */
  _redraw () {
    this._getOrCreateOverlay().setProps({ layers: Array.from(this._layers.values()) })
  }

  /**
   * Returns the `MapboxOverlay`, creating and attaching it to `_map` on the
   * first call. See the `_overlay` field doc above for why this is lazy.
   * @returns {MapboxOverlay}
   */
  _getOrCreateOverlay () {
    if (!this._overlay) {
      this._overlay = new MapboxOverlay({
        // Interleaved so deck.gl layers can be depth-sorted against MapLibre's
        // own 3D content (buildings, terrain) instead of always drawing on top.
        interleaved: true,
        layers: [],
        getTooltip: ({ object }) => object && String(object)
      })
      this._map.addControl(this._overlay)
    }
    return this._overlay
  }
}
