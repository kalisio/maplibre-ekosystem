/**
 * @file VectorLayerAdapter.js
 * @description Abstraction layer for MapLibre vector sources.
 *
 * A single `VectorLayerAdapter` instance manages the full lifecycle of one business
 * layer of type `vector`, which may internally create several MapLibre layers
 * (one per geometry type × filter) and, optionally, DOM cluster Markers.
 *
 * Two operating modes:
 *
 * 1. **Non-clustered** (default): one GeoJSON source, N sub-layers (circle/line/fill/line)
 *    per declared filter.
 *
 * 2. **Clustered** (`definition.cluster.enabled === true`): one GeoJSON source with
 *    `cluster: true`, one WebGL symbol layer for individual points, and DOM `Marker`
 *    elements (donut SVG) for cluster points. A secondary source `{id}-hull` renders
 *    the convex hull of the hovered cluster.
 *
 * Geometry type → MapLibre layer type mapping:
 *   point           → circle (or symbol when style.type === 'symbol')
 *   line            → line
 *   polygon         → fill
 *   polygon-outline → line  (custom KDK convention for polygon stroke)
 */

import { LAYER_ID_SEPARATOR } from './LayerAdapter.js'
import { MapLibreLayerAdapter } from './MapLibreLayerAdapter.js'

import { Marker } from 'maplibre-gl'
import convex from '@turf/convex'
import { featureCollection } from '@turf/helpers'

import { resolveClusterColors, buildClusterMarkerElement } from '../utils/index.js'
import { NDimensionalMixin } from './mixins/NDimensionalMixin.js'

// ── Geometry type mapping ─────────────────────────────────────────────────────

const GEOJSON_TYPES = {
  point: { layerType: 'circle', geometryType: 'Point' },
  line: { layerType: 'line', geometryType: 'LineString' },
  polygon: { layerType: 'fill', geometryType: 'Polygon' },
  'polygon-outline': { layerType: 'line', geometryType: 'Polygon' }
}

// ─────────────────────────────────────────────────────────────────────────────

export class VectorLayerAdapter extends MapLibreLayerAdapter {
  // ── Cluster state ────────────────────────────────────────────────────────────

  /**
   * Active DOM Markers keyed by MapLibre cluster_id.
   * @type {Map<number, { marker: import('maplibre-gl').Marker, element: HTMLElement }>}
   */
  _clusterMarkers = new Map()

  /** @type {{ [className: string]: string }} */
  _colorMap = {}

  /** @type {string[]} Unique class values discovered in the GeoJSON data */
  _classes = []

  /** @type {number|null} cluster_id whose hull is currently displayed */
  _hullClusterId = null

  /** @type {boolean} Layer's own visibility flag, independent of render-mode switching. */
  _isVisible = true

  // ── Event handler refs (kept for cleanup) ────────────────────────────────────

  _onDataHandler = null
  _onZoomHandler = null
  _onMoveEndHandler = null

  /**
   * Parses `definition.style` and mounts either the clustered or standard
   * GeoJSON source/layers depending on `definition.cluster.enabled`.
   */
  _initialize () {
    super._initialize()

    this._definition.style = this._parseStyle(this._definition.style, this._definition.type)

    const { _id: id, _definition: def, _map: map } = this

    if (def.cluster?.enabled) {
      this._mountClustered(map, id, def)
    } else {
      this._mountStandard(map, id, def)
    }
  }

  // ── Public Interface ─────────────────────────────────────────────────────────

  /**
   * Removes all resources associated with this layer:
   * WebGL layers, sources, DOM Markers, and event listeners.
   */
  destroy () {
    const map = this._map

    // ── Event listeners ────────────────────────────────────────────────────────
    if (this._onDataHandler) map.off('data', this._onDataHandler)
    if (this._onZoomHandler) map.off('zoom', this._onZoomHandler)
    if (this._onMoveEndHandler) map.off('moveend', this._onMoveEndHandler)

    // ── DOM Markers ────────────────────────────────────────────────────────────
    for (const { marker } of this._clusterMarkers.values()) {
      marker.remove()
    }
    this._clusterMarkers.clear()

    // ── Sources ────────────────────────────────────────────────────────────────
    if (map.getSource(`${this._id}${LAYER_ID_SEPARATOR}hull`)) {
      map.removeSource(`${this._id}${LAYER_ID_SEPARATOR}hull`)
    }

    super.destroy()
  }

  /**
   * Sets the visibility of all WebGL sub-layers and DOM Markers.
   *
   * @param {boolean} visible
   */
  setVisibility (visible) {
    super.setVisibility(visible)
    this._isVisible = visible

    for (const { element } of this._clusterMarkers.values()) {
      const target = element.hoverElement || element
      target.style.display = visible ? '' : 'none'
    }
  }

  /**
   * Recomposes and reapplies combined filters to all WebGL sub-layers.
   * Takes into account the temporal filter and per-filterId active state.
   */
  _refreshLayers () {
    const map = this._map

    // We do NOT combine this._filters into a single expression.
    // Each sub-layer already has its own condition baked into its `intrinsicFilter`.
    // We only need to check if its corresponding filter is active or not.

    // If there is a temporal filter or global filter, it would be combined here.
    // For now, combinedFilter is null.
    const combinedFilter = null

    const targetLayerIds = []
    if (this._layers) targetLayerIds.push(...this._layers)
    if (this._filters) {
      for (const f of this._filters) {
        if (f.layers) targetLayerIds.push(...f.layers)
      }
    }

    for (const layerId of targetLayerIds) {
      const mlLayer = map.getLayer(layerId)
      if (!mlLayer) continue

      const meta = mlLayer.metadata
      const intrinsic = meta?.intrinsicFilter
      const filterId = meta?.filterId

      let isActive = true
      if (filterId && this._filters) {
        const f = this._filters.find(x => x.id === filterId)
        if (f) {
          isActive = f.active !== false
        }
      }

      if (!isActive) {
        map.setFilter(layerId, ['has', '__hidden__'])
        continue
      }

      if (intrinsic && combinedFilter) {
        map.setFilter(layerId, ['all', intrinsic, combinedFilter])
      } else if (intrinsic) {
        map.setFilter(layerId, intrinsic)
      } else if (combinedFilter) {
        map.setFilter(layerId, combinedFilter)
      } else {
        map.setFilter(layerId, null)
      }
    }
  }

  /**
   * Mounts the clustered GeoJSON source. When `def.cluster.shape` is set,
   * mounts a WebGL layer for individual points plus DOM donut/pie Markers
   * for clusters (via `_setupClusterSync()`) and hull hover layers;
   * otherwise falls back to standard MapLibre WebGL clustering
   * (`_addStandardClusterLayers()`).
   * @param {import('maplibre-gl').Map} map
   * @param {string} id
   * @param {Object} def
   */
  _mountClustered (map, id, def) {
    const shapeType = def.cluster.shape // e.g. 'donut', 'pie'. If undefined, use standard WebGL clustering.

    let clusterProperties = {}

    if (shapeType) {
      this._classes = this._scanClasses(def.data, def.cluster.classField)
      this._colorMap = resolveClusterColors(this._classes, def.cluster?.colors)
      clusterProperties = this._buildClusterProperties(this._classes, def.cluster.classField)
    }

    // Main clustered source
    map.addSource(id, {
      type: 'geojson',
      data: def.data ?? { type: 'FeatureCollection', features: [] },
      generateId: true,
      cluster: true,
      clusterRadius: def.cluster.radius ?? 50,
      clusterProperties: Object.keys(clusterProperties).length > 0 ? clusterProperties : undefined
    })

    // WebGL layer for individual (non-cluster) points
    this._addIndividualPointLayer(map, id, def)

    if (shapeType) {
      // Initialize convex hull sublayers
      this._initHullLayers(map, id)

      // Start the DOM Marker engine
      this._setupClusterSync(map, shapeType)
    } else {
      // Standard MapLibre WebGL clustering
      this._addStandardClusterLayers(map, id, def)
    }
  }

  /**
   * Adds the standard MapLibre WebGL style for clusters (Circle + Text).
   */
  _addStandardClusterLayers (map, id, def) {
    const circleId = `${id}${LAYER_ID_SEPARATOR}cluster:circle`
    map.addLayer({
      id: circleId,
      type: 'circle',
      source: id,
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': [
          'step',
          ['get', 'point_count'],
          '#51bbd6', 10,
          '#f1f075', 50,
          '#f28cb1'
        ],
        'circle-radius': [
          'step',
          ['get', 'point_count'],
          15, 10,
          20, 50,
          25
        ],
        'circle-stroke-width': 1,
        'circle-stroke-color': '#fff'
      },
      metadata: {
        intrinsicFilter: ['has', 'point_count']
      }
    })

    const countId = `${id}${LAYER_ID_SEPARATOR}cluster:count`

    // Find a valid font from the map style to ensure the text renders
    let textFont = ['Open Sans Regular', 'Arial Unicode MS Regular']
    const style = map.getStyle()
    if (style?.layers) {
      const symbolLayer = style.layers.find(l => l.type === 'symbol' && l.layout?.['text-font'])
      if (symbolLayer) textFont = symbolLayer.layout['text-font']
    }

    map.addLayer({
      id: countId,
      type: 'symbol',
      source: id,
      filter: ['has', 'point_count'],
      layout: {
        'text-field': '{point_count_abbreviated}',
        'text-font': textFont,
        'text-size': 12
      },
      paint: {
        'text-color': '#000000'
      },
      metadata: {
        intrinsicFilter: ['has', 'point_count']
      }
    })

    if (!this._layers) this._layers = []
    this._layers.push(circleId, countId)
  }

  /**
   * Mounts the non-clustered GeoJSON source (empty initially if a provider
   * will fetch data asynchronously in `_postInitialize()`) and its geometry
   * sub-layers via `_addGeometryLayers()`.
   * @param {import('maplibre-gl').Map} map
   * @param {string} id
   * @param {Object} def
   */
  _mountStandard (map, id, def) {
    let data = def.data

    // If a provider is used, the data will be fetched asynchronously and set in _postInitialize,
    // so we start with an empty FeatureCollection to avoid MapLibre errors.
    if (this._provider) {
      data = null
    }

    map.addSource(id, {
      type: 'geojson',
      data: data ?? { type: 'FeatureCollection', features: [] },
      generateId: true
    })

    this._addGeometryLayers(map, id, def)
  }

  // ── Private — Clustered helpers ──────────────────────────────────────────────

  /**
   * Extracts unique values of `classField` from GeoJSON features.
   *
   * @param {Object} data - GeoJSON FeatureCollection
   * @param {string} classField - Property name to read from each feature
   * @returns {string[]}
   */
  _scanClasses (data, classField) {
    if (!data?.features || !classField) return []
    const seen = new Set()
    for (const feature of data.features) {
      const val = feature.properties?.[classField]
      if (val !== undefined && val !== null) seen.add(String(val))
    }
    return [...seen]
  }

  /**
   * Builds the `clusterProperties` object for the MapLibre GeoJSON source.
   * Each class gets a `count_{className}` aggregation expression.
   *
   * @param {string[]} classes
   * @param {string} classField
   * @returns {Object}
   */
  _buildClusterProperties (classes, classField) {
    return Object.fromEntries(
      classes.map(cls => [
        `count_${cls}`,
        ['+', ['case', ['==', ['get', classField], cls], 1, 0]]
      ])
    )
  }

  /**
   * Adds a WebGL layer rendering individual (non-cluster) points.
   * Uses the style declared in the layer definition.
   *
   * @param {import('maplibre-gl').Map} map
   * @param {string} id
   * @param {Object} def
   */
  _addIndividualPointLayer (map, id, def) {
    const styleObj = def.style || {}
    const layerType = styleObj.type === 'symbol' ? 'symbol' : 'circle'
    const paint = styleObj.paint || {}
    const layout = styleObj.layout || {}

    const subLayerId = `${id}${LAYER_ID_SEPARATOR}point`

    // FIX: Must filter paint and layout properties to avoid MapLibre rejecting the layer due to invalid properties!
    const filteredPaint = this._filterPaint(paint, layerType, 'point')
    const filteredLayout = this._filterLayout(layout, layerType, def.visible)

    map.addLayer({
      id: subLayerId,
      type: layerType,
      source: id,
      filter: ['!', ['has', 'point_count']], // Unclustered points don't have point_count
      layout: filteredLayout,
      paint: filteredPaint,
      ...(def.minzoom !== undefined ? { minzoom: def.minzoom } : {}),
      ...(def.maxzoom !== undefined ? { maxzoom: def.maxzoom } : {}),
      metadata: {
        intrinsicFilter: ['!', ['has', 'point_count']]
      }
    })

    if (!this._layers) this._layers = []
    this._layers.push(subLayerId)
  }

  /**
   * Creates the hull GeoJSON source and its two rendering layers (fill + outline).
   * The source is initially empty and is populated on cluster hover.
   *
   * @param {import('maplibre-gl').Map} map
   * @param {string} id
   */
  _initHullLayers (map, id) {
    const emptyFC = { type: 'FeatureCollection', features: [] }
    map.addSource(`${id}${LAYER_ID_SEPARATOR}hull`, { type: 'geojson', data: emptyFC })

    const fillId = `${id}${LAYER_ID_SEPARATOR}hull:fill`
    const outlineId = `${id}${LAYER_ID_SEPARATOR}hull:outline`

    map.addLayer({
      id: fillId,
      type: 'fill',
      source: `${id}${LAYER_ID_SEPARATOR}hull`,
      paint: {
        'fill-color': '#3498db',
        'fill-opacity': 0.15
      }
    })

    map.addLayer({
      id: outlineId,
      type: 'line',
      source: `${id}${LAYER_ID_SEPARATOR}hull`,
      paint: {
        'line-color': '#3498db',
        'line-width': 1.5,
        'line-dasharray': [2, 2]
      }
    })

    if (!this._layers) this._layers = []
    this._layers.push(fillId, outlineId)
  }

  /**
   * Registers map event listeners that keep DOM Markers synchronized
   * with the cluster source as the user zooms and pans.
   *
   * @param {import('maplibre-gl').Map} map
   * @param {string} shapeType
   */
  _setupClusterSync (map, shapeType) {
    const sync = () => {
      this._syncClusterMarkers(map, shapeType)
    }

    this._onDataHandler = (e) => {
      if (e.sourceId === this._id) {
        if (map.isSourceLoaded(this._id)) sync()
      }
    }
    this._onMoveEndHandler = sync

    map.on('data', this._onDataHandler)
    map.on('moveend', this._onMoveEndHandler)

    // FIX: Wait for the map to be fully idle to ensure initial tiles are rendered
    map.once('idle', sync)
  }

  /**
   * Queries the map for currently visible clusters and updates DOM markers.
   *
   * @param {import('maplibre-gl').Map} map
   * @param {string} shapeType
   */
  _syncClusterMarkers (map, shapeType) {
    const clusterFeatures = map.querySourceFeatures(this._id, {
      filter: ['has', 'point_count']
    })

    const visibleIds = new Set()

    for (const feature of clusterFeatures) {
      const { cluster_id: clusterId, point_count: pointCount } = feature.properties
      visibleIds.add(clusterId)

      if (this._clusterMarkers.has(clusterId)) continue

      const { element, marker } = this._createClusterMarker(map, feature, pointCount, shapeType)
      this._clusterMarkers.set(clusterId, { marker, element })
    }

    // Remove Markers for clusters no longer visible
    for (const [id, { marker }] of this._clusterMarkers) {
      if (!visibleIds.has(id)) {
        marker.remove()
        this._clusterMarkers.delete(id)
      }
    }
  }

  /**
   * Creates a DOM Marker for one cluster feature.
   * The Marker element is a donut SVG + center label, with hull hover behavior.
   *
   * @param {import('maplibre-gl').Map} map
   * @param {import('maplibre-gl').MapGeoJSONFeature} feature
   * @param {number} totalCount
   * @param {string} shapeType - e.g. `'donut'`, `'pie'`
   * @returns {{ element: HTMLElement, marker: import('maplibre-gl').Marker }}
   */
  _createClusterMarker (map, feature, totalCount, shapeType) {
    const { cluster_id: clusterId } = feature.properties
    const [lng, lat] = feature.geometry.coordinates

    // Build ordered slices from clusterProperties
    const slices = this._classes.map(cls => ({
      value: feature.properties[`count_${cls}`] ?? 0,
      label: cls,
      color: this._colorMap[cls]
    }))

    const element = buildClusterMarkerElement(slices, totalCount, shapeType)

    if (this._isVisible === false) {
      const target = element.hoverElement || element
      target.style.display = 'none'
    }

    // Hull on cluster hover
    const hoverEl = element.hoverElement || element
    hoverEl.addEventListener('mouseenter', () => {
      this._showHull(map, clusterId)
    })
    hoverEl.addEventListener('mouseleave', () => this._hideHull(map))

    const marker = new Marker({ element })
      .setLngLat([lng, lat])
      .addTo(map)

    return { element, marker }
  }

  /**
   * Computes and displays the convex hull of a cluster's leaves.
   * Does nothing if `turf.convex()` returns null (collinear points, < 3 points).
   *
   * @param {import('maplibre-gl').Map} map
   * @param {number} clusterId
   */
  async _showHull (map, clusterId) {
    if (this._hullClusterId === clusterId) return

    const source = map.getSource(this._id)
    if (!source) return

    try {
      const leaves = await new Promise((resolve, reject) => {
        const res = source.getClusterLeaves(clusterId, 99999, 0, (err, features) => {
          if (err) reject(err)
          else resolve(features)
        })

        // MapLibre v3+ returns a Promise and might ignore the callback!
        if (res && typeof res.then === 'function') {
          res.then(resolve).catch(reject)
        }
      })

      if (!leaves || leaves.length < 3) return

      const hull = convex(featureCollection(leaves))
      if (!hull) return // All points collinear — nothing to display

      const hullSource = map.getSource(`${this._id}${LAYER_ID_SEPARATOR}hull`)
      if (hullSource) {
        hullSource.setData(hull)
        this._hullClusterId = clusterId
      }
    } catch (e) {
      console.warn(`[VectorLayerAdapter] Hull computation failed for cluster ${clusterId}:`, e)
    }
  }

  /**
   * Clears the hull source, hiding any displayed convex hull.
   *
   * @param {import('maplibre-gl').Map} map
   */
  _hideHull (map) {
    const hullSource = map.getSource(`${this._id}${LAYER_ID_SEPARATOR}hull`)
    if (hullSource) {
      hullSource.setData({ type: 'FeatureCollection', features: [] })
    }
    this._hullClusterId = null
  }

  // ── Private — Non-clustered helpers ─────────────────────────────────────────

  /**
   * Adds one set of geometry sub-layers per filter (or a single set if no filters).
   * Each set contains four layers: point (circle/symbol), line, polygon (fill), polygon-outline.
   *
   * @param {import('maplibre-gl').Map} map
   * @param {string} id
   * @param {Object} def
   */
  _addGeometryLayers (map, id, def) {
    const hasFilters = def.filters && def.filters.length > 0
    const items = hasFilters ? def.filters : [{ style: def.style }]

    if (hasFilters && !this._filters) {
      this._filters = def.filters.map(f => ({
        id: f.id,
        active: f.active !== false,
        expression: f.expression || f.filter,
        layers: [],
        style: f.style || def.style
      }))
    } else if (!hasFilters && !this._layers) {
      this._layers = []
    }

    items.forEach((item, index) => {
      const styleObj = item.style || def.style || {}
      const layerType = styleObj.type || 'circle'
      const paint = styleObj.paint || styleObj
      const layout = styleObj.layout || {}

      for (const geometryType of Object.keys(GEOJSON_TYPES)) {
        const subLayerId = hasFilters ? `${id}${LAYER_ID_SEPARATOR}${index}:${geometryType}` : `${id}${LAYER_ID_SEPARATOR}${geometryType}`

        if (map.getLayer(subLayerId)) {
          map.removeLayer(subLayerId)
        }

        let currentLayerType = GEOJSON_TYPES[geometryType].layerType
        if (geometryType === 'point' && layerType === 'symbol') {
          currentLayerType = 'symbol'
        }

        const filteredPaint = this._filterPaint(paint, currentLayerType, geometryType)
        const filteredLayout = this._filterLayout(layout, currentLayerType, def.visible)

        const intrinsicFilter = ['==', ['geometry-type'], GEOJSON_TYPES[geometryType].geometryType]
        const condition = item.filter || item.expression
        const finalFilter = condition ? ['all', intrinsicFilter, condition] : intrinsicFilter
        const initialFilter = item.active === false ? ['has', '__hidden__'] : finalFilter

        map.addLayer({
          id: subLayerId,
          type: currentLayerType,
          source: id,
          filter: initialFilter,
          layout: filteredLayout,
          paint: filteredPaint,
          ...(def.minzoom !== undefined ? { minzoom: def.minzoom } : {}),
          ...(def.maxzoom !== undefined ? { maxzoom: def.maxzoom } : {}),
          metadata: {
            intrinsicFilter: finalFilter,
            filterId: item.id
          }
        })

        if (hasFilters) {
          const filterState = this._filters.find(f => f.id === item.id)
          if (filterState) {
            if (!filterState.layers) filterState.layers = []
            filterState.layers.push(subLayerId)
          }
        } else {
          this._layers.push(subLayerId)
        }
      }
    })
  }

  /**
   * Filters paint properties to only those relevant for the given layer type.
   *
   * @param {Object} paint
   * @param {string} layerType - MapLibre layer type
   * @param {string} geometryType - KDK geometry key
   * @returns {Object}
   */
  _filterPaint (paint, layerType, geometryType) {
    const result = {}
    if (!paint) return result

    for (const [key, value] of Object.entries(paint)) {
      if (layerType === 'symbol' && (key.startsWith('icon-') || key.startsWith('text-'))) {
        result[key] = value
      } else if (geometryType === 'polygon-outline' && key.startsWith('polygon-stroke-')) {
        result[key.replace('polygon-stroke-', 'line-')] = value
      } else if (key.startsWith(layerType)) {
        result[key] = value
      }
    }
    return result
  }

  /**
   * Filters layout properties to only those relevant for the given layer type.
   *
   * @param {Object} layout
   * @param {string} layerType - MapLibre layer type
   * @param {boolean|undefined} visible - From layer definition
   * @returns {Object}
   */
  _filterLayout (layout, layerType, visible) {
    const result = { visibility: visible === false ? 'none' : 'visible' }
    if (!layout) return result

    for (const [key, value] of Object.entries(layout)) {
      if (layerType === 'symbol' && (key.startsWith('icon-') || key.startsWith('text-'))) {
        result[key] = value
      } else if (key.startsWith(layerType) || key === 'visibility') {
        result[key] = value
      }
    }
    return result
  }
}

/**
 * `VectorLayerAdapter` mixed with `NDimensionalMixin`'s coordinate/level/
 * variable API. Used by `LayerFactory` for `kazarr://` vector layers (2D side).
 */
export class NDimensionalVectorLayerAdapter extends NDimensionalMixin(VectorLayerAdapter) { }
