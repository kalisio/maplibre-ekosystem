/**
 * @file SelectManager.js
 * @description Manager for selecting geographical features.
 *
 * Encapsulates click and bounding box selection logic on the MapLibre map.
 * Emits typed events to the bus so that VueJS can react
 * to the selection without ever manipulating MapLibre directly.
 */

export class SelectManager {
  /**
   * MapLibre instance on which selection is active.
   */
  _map

  /**
   * Shared event bus.
   */
  _eventBus

  /**
   * Set of selected feature identifiers.
   * @type {Set<string | number>}
   */
  _selectedIds = new Set()

  /**
   * Identifiers of layers made selectable.
   * @type {string[]}
   */
  _selectableLayers = []

  /**
   * Reference to the click handler (required for removeEventListener).
   */
  _clickHandler

  /**
   * @param {import('maplibre-gl').Map} map - internal `maplibregl.Map` instance
   * @param {import('../../../packages/maplibre-core/src/EventBus.js').EventBus} eventBus - shared event bus of the engine
   */
  constructor (map, eventBus) {
    this._map = map
    this._eventBus = eventBus

    // Bind handler to be able to remove it cleanly
    this._clickHandler = this._onMapClick.bind(this)
    this._map.on('click', this._clickHandler)
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  /**
   * Sets the list of layers on which click selection is active.
   * @param {string[]} layerIds - identifiers of selectable layers
   */
  setSelectableLayers (layerIds) {
    this._selectableLayers = [...layerIds]
  }

  /**
   * Adds a layer to the list of selectable layers.
   * @param {string} layerId - identifier of the layer to make selectable
   */
  addSelectableLayer (layerId) {
    if (!this._selectableLayers.includes(layerId)) {
      this._selectableLayers.push(layerId)
    }
  }

  /**
   * Removes a layer from the list of selectable layers.
   * @param {string} layerId - layer identifier
   */
  removeSelectableLayer (layerId) {
    this._selectableLayers = this._selectableLayers.filter((id) => id !== layerId)
  }

  // ── Selection Access ───────────────────────────────────────────────────────

  /**
   * Returns the identifiers of all selected features.
   * @returns {(string | number)[]}
   */
  getSelection () {
    return Array.from(this._selectedIds)
  }

  /**
   * Indicates if at least one feature is selected.
   * @returns {boolean}
   */
  hasSelection () {
    return this._selectedIds.size > 0
  }

  // ── Selection Operations ───────────────────────────────────────────────────

  /**
   * Deselects all features and removes the visual highlight.
   * @emits `'select:changed'` via EventBus with an empty array
   */
  clearSelection () {
    for (const layerId of this._selectableLayers) {
      this._unhighlightLayer(layerId)
    }

    this._selectedIds.clear()

    this._eventBus.emit('select:changed', {
      selectedIds: [],
      layerIds: this._selectableLayers
    })
  }

  /**
   * Selects features by their feature ID (programmatic selection).
   *
   * @param {(string | number)[]} featureIds - identifiers of features to select
   * @param {string[]} layerIds - layers involved (for visual highlight)
   * @param {boolean} [append=false] - `true` to add to the selection, `false` to replace
   * @emits `'select:changed'` via EventBus
   */
  selectById (featureIds, layerIds, append = false) {
    if (!append) {
      this.clearSelection()
    }

    for (const id of featureIds) {
      this._selectedIds.add(id)
    }

    for (const layerId of layerIds) {
      this._highlightLayer(layerId, featureIds)
    }

    this._eventBus.emit('select:changed', {
      selectedIds: this.getSelection().map(String),
      layerIds
    })
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Releases SelectManager listeners and resources.
   * Called by `MapEngine.destroy()`.
   */
  destroy () {
    this._map.off('click', this._clickHandler)
    this._selectedIds.clear()
    this._selectableLayers = []
  }

  // ── Private Methods ────────────────────────────────────────────────────────

  /**
   * MapLibre map click handler.
   * @param {import('maplibre-gl').MapMouseEvent} e - MapLibre click event
   */
  _onMapClick (e) {
    if (this._selectableLayers.length === 0) return

    const features = this._map.queryRenderedFeatures(e.point, {
      layers: this._selectableLayers
    })

    if (features.length === 0) {
      this.clearSelection()
      this._eventBus.emit('map:click', {
        lngLat: [e.lngLat.lng, e.lngLat.lat],
        point: [e.point.x, e.point.y]
      })
      return
    }

    const topFeature = features[0]
    const featureId = topFeature.id
    const layerId = topFeature.layer.id

    if (featureId !== undefined) {
      this.selectById([featureId], [layerId])
    }

    this._eventBus.emit('feature:click', {
      layerId,
      properties: topFeature.properties,
      lngLat: [e.lngLat.lng, e.lngLat.lat]
    })
  }

  /**
   * Applies visual highlight to selected features via MapLibre feature-state.
   * @param {string} layerId - layer containing the features
   * @param {(string | number)[]} featureIds - IDs of the features to highlight
   */
  _highlightLayer (layerId, featureIds) {
    const sourceId = layerId
    for (const id of featureIds) {
      this._map.setFeatureState({ source: sourceId, id }, { selected: true })
    }
  }

  /**
   * Removes visual highlight from all features in a layer.
   * @param {string} layerId - layer whose highlight is removed
   */
  _unhighlightLayer (layerId) {
    const sourceId = layerId
    this._map.removeFeatureState({ source: sourceId })
  }
}
