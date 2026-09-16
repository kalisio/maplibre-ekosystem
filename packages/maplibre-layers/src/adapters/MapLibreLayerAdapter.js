/**
 * @file MapLibreLayerAdapter.js
 * @description `LayerAdapter` for layer types rendered natively by MapLibre
 * without a vector GeoJSON source: `'raster'`, `'raster-dem'`, `'wms'`, and
 * (only when `definition.url` uses the `kazarr://` protocol) `'mesh'`.
 * `VectorLayerAdapter` extends this class to add GeoJSON/clustering support.
 *
 * A `kazarr://` gridded scalar field (e.g. a full AROME/ARPEGE model
 * output, potentially whole-earth coverage) has THREE renderings, selected
 * by `definition.type` itself — there is no separate `'gridded-field'` type:
 *  - `'raster'` (+ `kazarr://` url): native MapLibre raster tiles, computed
 *    on demand per z/x/y from a Kazarr bbox query — see
 *    `_addGriddedFieldLayer()` and `GriddedFieldProtocol.js`.
 *  - `'mesh'` (+ `kazarr://` url): a single GPU-colored triangle mesh,
 *    refetched per viewport — see `_addGriddedFieldMeshLayer()` and
 *    `GriddedFieldMeshLayer.js` for the how/why/trade-offs versus the
 *    raster path. `LayerFactory.createLayer()` is what routes a `'mesh'`
 *    definition here (2D, MapLibre-native) instead of to
 *    `DeckGlLayerAdapter` (3D, an explicit static mesh) based on that same
 *    `kazarr://` protocol check.
 *  - `'tiled-mesh'` (+ `kazarr://` url): same GPU-mesh idea as `'mesh'`, but
 *    split into a self-managed z/x/y tile cache so a pan only fetches the
 *    newly-exposed tiles instead of the whole viewport — see
 *    `_addGriddedFieldTiledMeshLayer()` and `GriddedFieldTiledMeshLayer.js`
 *    (including why it's a self-managed cache and not a real MapLibre
 *    `Source`).
 * A plain `'raster'`/`'mesh'` (no `kazarr://` url) is unaffected — regular
 * XYZ raster tiles / an explicit deck.gl mesh, respectively. `'tiled-mesh'`
 * has no non-`kazarr://` meaning at all.
 *
 * @todo `LayerFactory.createLayer()`'s switch on `definition.type` has no
 * `case 'wms'` today, even though `_addWmsLayer()` fully supports it — a
 * `{ type: 'wms' }` definition currently gets no adapter at all.
 */
import bbox from '@turf/bbox'
import { LayerAdapter, LAYER_ID_SEPARATOR } from './LayerAdapter.js'
import { ensureGriddedFieldProtocol, registerGriddedFieldSource, unregisterGriddedFieldSource } from '../maplibreProtocols/GriddedFieldProtocol.js'
import { GriddedFieldMeshLayer } from '../maplibreCustomLayers/GriddedFieldMeshLayer.js'
import { GriddedFieldTiledMeshLayer } from '../maplibreCustomLayers/GriddedFieldTiledMeshLayer.js'

export class MapLibreLayerAdapter extends LayerAdapter {
  /**
   * Adds the MapLibre source/layer matching `definition.type`
   * (`'raster'` | `'raster-dem'` | `'wms'` | `'mesh'`). A `'raster'` or
   * `'mesh'` whose `definition.url` uses the `kazarr://` protocol is a
   * gridded scalar field, dispatched to the raster-tile or GPU-mesh
   * gridded-field renderer respectively instead of the plain-raster/
   * explicit-mesh path (see the file header for the full picture; `'mesh'`
   * only ever reaches this class for a `kazarr://` url — `LayerFactory`
   * routes any other `'mesh'` to `DeckGlLayerAdapter` instead).
   *
   * Skips `super._postInitialize()` (the base class's "load the whole
   * dataset once via `_provider.get()`, then `getSource().setData(...)`"
   * flow) for a `kazarr://` gridded field: that flow doesn't apply here —
   * there's no single bbox to load once, no `setData()`-style source to
   * push into, and data is instead fetched per-tile/per-viewport on demand
   * (`GriddedFieldProtocol.js` / `GriddedFieldMeshLayer.js`). Without this
   * guard, the base flow fires one wasted, bbox-less request on every layer
   * init (`this` still has a `_provider` because `kazarr://` URLs get one
   * from `LayerAdapter._createProvider()` regardless of `definition.type`).
   */
  _postInitialize () {
    const { _map: map, _id: id, _definition: definition } = this
    const type = definition.type
    const isKazarrGriddedField = LayerAdapter.isKazarrGriddedField(definition)

    if (!isKazarrGriddedField) {
      super._postInitialize()
    }

    if (type === 'raster') {
      if (isKazarrGriddedField) {
        this._addGriddedFieldLayer(map, id, definition)
      } else {
        this._addRasterLayer(map, id, definition)
      }
    } else if (type === 'raster-dem') {
      this._addRasterDemLayer(map, id, definition)
    } else if (type === 'wms') {
      this._addWmsLayer(map, id, definition)
    } else if (type === 'mesh' && isKazarrGriddedField) {
      this._addGriddedFieldMeshLayer(map, id, definition)
    } else if (type === 'tiled-mesh' && isKazarrGriddedField) {
      this._addGriddedFieldTiledMeshLayer(map, id, definition)
    } else {
      console.warn(`[MapLibreLayerAdapter] Unsupported maplibre layer type: ${type}`)
    }
  }

  /**
   * Toggles the `visibility` layout property of every MapLibre layer id
   * owned by this adapter (`_layers` and/or each filter's `layers`).
   * @param {boolean} visible
   */
  setVisibility (visible) {
    const map = this._map
    const value = visible ? 'visible' : 'none'
    const allLayerIds = []
    if (this._layers) allLayerIds.push(...this._layers)
    if (this._filters) {
      for (const f of this._filters) {
        if (f.layers) allLayerIds.push(...f.layers)
      }
    }

    for (const layerId of allLayerIds) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', value)
      }
    }

    // Tile/viewport fetching for the GPU-mesh gridded-field renderings is
    // driven by `moveend`, not by this visibility toggle — catch it up to
    // the current viewport whenever it's shown again, since a pending
    // pan/zoom is the only other thing that would otherwise trigger it.
    // The raster gridded field needs no such catch-up (MapLibre's own tile
    // pipeline already handles it), so `_griddedFieldRenderer` simply has
    // no `refresh()` there.
    if (visible) {
      this._griddedFieldRenderer?.refresh?.()
    }
  }

  /**
   * Refetches a Kazarr-backed rendering for a new global time — however
   * this rendering fetches its data (tile URL reload for the raster
   * gridded field, or the GPU-mesh renderer's own reload for `'mesh'`/
   * `'tiled-mesh'`). Called by `UrlStrategy` when `definition.url` uses the
   * `kazarr:` protocol; a no-op if this adapter isn't a gridded field.
   * @param {Date} time
   * @returns {Promise<void>}
   */
  async reloadUrlData (time) {
    return this._griddedFieldRenderer?.reloadData(time)
  }

  /**
   * Computes the layer's bounding box from its MapLibre source: the source's
   * own `bounds` if declared, a turf `bbox()` of the GeoJSON data for
   * `'geojson'` sources, or the whole world for `'raster'`/`'raster-dem'`
   * sources (which don't carry explicit bounds).
   * @returns {[[number, number], [number, number]] | null}
   */
  getBounds () {
    const { type, url } = this._definition
    const protocol = url ? new URL(url).protocol.replace(':', '') : null
    if (protocol === 'kazarr' && (type === 'raster' || type === 'mesh' || type === 'tiled-mesh')) {
      // None of the three gridded-field renderings has a fixed extent to
      // report: the raster-tile source's `tiles` URL carries no bounds, and
      // both mesh renderings (GriddedFieldMeshLayer.js,
      // GriddedFieldTiledMeshLayer.js) are source-less custom GL layers —
      // there is no `map.getSource(this._id)` to inspect at all in that
      // case. Fall back to the whole world, like plain 'raster'/'raster-dem'.
      return [[-180, -90], [180, 90]]
    }

    const map = this._map
    const source = map.getSource(this._id)
    if (!source) {
      console.warn(`[MapLibreLayerAdapter] Cannot get bounds: source for layer "${this._id}" not found.`)
      return null
    }

    if (source.bounds) {
      return [[source.bounds[0], source.bounds[1]], [source.bounds[2], source.bounds[3]]]
    } else if (source.type === 'geojson') {
      const data = source._data || source._options?.data
      if (data) {
        const features = data.type === 'FeatureCollection' ? data.features : [data]
        if (features.length > 0) {
          const boundingBox = bbox(data)
          return [[boundingBox[0], boundingBox[1]], [boundingBox[2], boundingBox[3]]]
        }
      }
    } else if (source.type === 'raster' || source.type === 'raster-dem') {
      return [[-180, -90], [180, 90]]
    }

    console.warn(`[MapLibreLayerAdapter] Cannot compute bounds for layer "${this._id}".`)
    return null
  }

  /**
   * Applies a parsed style's `paint`/`layout` properties directly onto the
   * MapLibre layer(s) (all of `_layers`/every filter's `layers` if `filterId`
   * is omitted, or just one filter's `layers` otherwise), routing each
   * property key by the MapLibre layer's own `type` (symbol icon/text
   * properties, polygon-stroke synthesized as a `line` layer, or a plain
   * `<type>-*` prefix match).
   * @param {Object} style
   * @param {string} [filterId]
   */
  applyStyle (style, filterId = null) {
    const map = this._map
    const parsedStyle = this._parseStyle(style, this._definition.type)

    const targetLayerIds = []
    if (!filterId) {
      if (this._layers) targetLayerIds.push(...this._layers)
      if (this._filters) {
        for (const f of this._filters) {
          if (f.layers) targetLayerIds.push(...f.layers)
        }
      }
    } else if (this._filters) {
      const f = this._filters.find(x => x.id === filterId)
      if (f?.layers) targetLayerIds.push(...f.layers)
    }

    for (const layerId of targetLayerIds) {
      const mlLayer = map.getLayer(layerId)
      if (!mlLayer) continue

      const layerType = mlLayer.type
      const paint = parsedStyle.paint || {}
      const layout = parsedStyle.layout || {}

      for (const [key, value] of Object.entries(paint)) {
        if (layerType === 'symbol' && (key.startsWith('icon-') || key.startsWith('text-'))) {
          map.setPaintProperty(layerId, key, value)
        } else if (layerType === 'line' && layerId.includes(`${LAYER_ID_SEPARATOR}polygon-outline`)) {
          if (key.startsWith('polygon-stroke-')) {
            const lineKey = key.replace('polygon-stroke-', 'line-')
            map.setPaintProperty(layerId, lineKey, value)
          }
        } else if (key.startsWith(layerType)) {
          map.setPaintProperty(layerId, key, value)
        }
      }

      for (const [key, value] of Object.entries(layout)) {
        if (layerType === 'symbol' && (key.startsWith('icon-') || key.startsWith('text-'))) {
          map.setLayoutProperty(layerId, key, value)
        } else if (key.startsWith(layerType) || key === 'visibility') {
          map.setLayoutProperty(layerId, key, value)
        }
      }
    }
  }

  /**
   * Re-applies `definition.style` (the layer's original/default style).
   * @param {string} [filterId]
   */
  resetStyle (filterId = null) {
    this.applyStyle(this._definition.style, filterId)
  }

  /**
   * Finds this adapter's own MapLibre layer id (or one of its
   * `LAYER_ID_SEPARATOR`-prefixed sublayers) in the current style and
   * returns its source.
   * @returns {Object | null} a MapLibre source, or `null` if not found
   */
  getSource () {
    for (const layer of this._map.getStyle().layers) {
      if (layer.id === this._id || layer.id.startsWith(`${this._id}${LAYER_ID_SEPARATOR}`)) {
        return this._map.getSource(layer.source)
      }
    }
    return null
  }

  /**
   * No-op: raster and WMS layers usually don't use vector filters.
   * @todo If filter toggles are needed for these types, they might change
   * visibility instead of rebuilding layers.
   */
  _refreshLayers () {
    // Raster and WMS layers usually do not use vector filters.
    // If they have filter toggles, they might change visibility instead, but for now, no-op.
  }

  /**
   * Removes every MapLibre layer id owned by this adapter and its source.
   * Also unregisters this layer from `GriddedFieldProtocol.js`'s registry —
   * a no-op if this adapter was never a `'gridded-field'` layer.
   */
  destroy () {
    unregisterGriddedFieldSource(this._id)

    const map = this._map
    const allLayerIds = []
    if (this._layers) allLayerIds.push(...this._layers)
    if (this._filters) {
      for (const f of this._filters) {
        if (f.layers) allLayerIds.push(...f.layers)
      }
    }

    for (const layerId of allLayerIds) {
      if (map.getLayer(layerId)) {
        map.removeLayer(layerId)
      }
    }

    if (map.getSource(this._id)) {
      map.removeSource(this._id)
    }
  }

  // Private

  /**
   * Adds a `'raster'` MapLibre source + layer for `definition.tiles`.
   * @param {import('maplibre-gl').Map} map
   * @param {string} id
   * @param {Object} definition
   */
  _addRasterLayer (map, id, definition) {
    const styleObj = definition.style || {}
    const paint = styleObj.paint || styleObj
    const layout = styleObj.layout || {}

    const layerDefinition = {
      id,
      type: 'raster',
      source: id,
      layout: {
        ...layout,
        visibility: definition.visible === false ? 'none' : 'visible'
      },
      paint
    }

    if (definition.minzoom !== undefined) layerDefinition.minzoom = definition.minzoom
    if (definition.maxzoom !== undefined) layerDefinition.maxzoom = definition.maxzoom

    const sourceDefinition = {
      type: 'raster',
      tiles: definition.tiles,
      tileSize: definition.tileSize ?? 256
    }
    // The style-spec validator distinguishes an absent key from a key
    // present with value `undefined`: `attribution` is typed as a string,
    // so including it unconditionally (e.g. `attribution: definition.attribution`)
    // fails validation whenever it's unset, which makes `addSource()` abort
    // silently (a style-spec validation failure fires the map's 'error'
    // event instead of throwing) — leaving the source/layer never created.
    if (definition.attribution !== undefined) sourceDefinition.attribution = definition.attribution

    map.addSource(id, sourceDefinition)
    map.addLayer(layerDefinition)

    if (!this._layers) this._layers = []
    this._layers.push(id)
  }

  /**
   * Adds a `'raster-dem'` MapLibre source + `'hillshade'` layer for
   * `definition.tiles`.
   * @param {import('maplibre-gl').Map} map
   * @param {string} id
   * @param {Object} definition
   */
  _addRasterDemLayer (map, id, definition) {
    const styleObj = definition.style || {}
    const paint = styleObj.paint || styleObj
    const layout = styleObj.layout || {}

    const layerDefinition = {
      id,
      type: 'hillshade',
      source: id,
      layout: {
        ...layout,
        visibility: definition.visible === false ? 'none' : 'visible'
      },
      paint
    }

    if (definition.minzoom !== undefined) layerDefinition.minzoom = definition.minzoom
    if (definition.maxzoom !== undefined) layerDefinition.maxzoom = definition.maxzoom

    const sourceDefinition = {
      type: 'raster-dem',
      tiles: definition.tiles,
      tileSize: definition.tileSize ?? 256
    }
    // See the identical guard in `_addRasterLayer()` above: an `attribution`
    // key present with value `undefined` fails style-spec validation and
    // silently aborts `addSource()`.
    if (definition.attribution !== undefined) sourceDefinition.attribution = definition.attribution

    map.addSource(id, sourceDefinition)

    map.addLayer(layerDefinition)

    if (!this._layers) this._layers = []
    this._layers.push(id)
  }

  /**
   * Builds a WMS `GetMap` tile URL from `definition.wmsUrl`/`layers`/
   * `wmsParams` (EPSG:3857, 256×256 tiles) and adds it as a `'raster'`
   * MapLibre source + layer.
   * @param {import('maplibre-gl').Map} map
   * @param {string} id
   * @param {Object} definition
   */
  _addWmsLayer (map, id, definition) {
    const wmsParams = new URLSearchParams({
      SERVICE: 'WMS',
      VERSION: '1.3.0',
      REQUEST: 'GetMap',
      FORMAT: 'image/png',
      TRANSPARENT: 'true',
      LAYERS: definition.layers,
      WIDTH: '256',
      HEIGHT: '256',
      CRS: 'EPSG:3857',
      BBOX: '{bbox-epsg-3857}',
      ...definition.wmsParams
    })

    map.addSource(id, {
      type: 'raster',
      tiles: [`${definition.wmsUrl}?${wmsParams.toString()}`],
      tileSize: 256
    })

    const styleObj = definition.style || {}
    const paint = styleObj.paint || styleObj
    const layout = styleObj.layout || {}

    const layerDefinition = {
      id,
      type: 'raster',
      source: id,
      layout: {
        ...layout,
        visibility: definition.visible === false ? 'none' : 'visible'
      },
      paint
    }

    if (definition.minzoom !== undefined) layerDefinition.minzoom = definition.minzoom
    if (definition.maxzoom !== undefined) layerDefinition.maxzoom = definition.maxzoom

    map.addLayer(layerDefinition)

    if (!this._layers) this._layers = []
    this._layers.push(id)
  }

  /**
   * Adds a gridded scalar-field layer (e.g. a full AROME/ARPEGE model
   * output, `definition.url` a `kazarr://` dataset) as native MapLibre
   * raster tiles, computed on demand via the `kazarr-field://` protocol
   * (registered lazily, once per process, by `ensureGriddedFieldProtocol()`)
   * — MapLibre's own tiling/zoom/culling pipeline does the heavy lifting,
   * so this scales to whole-earth coverage. Each tile is rasterized from a
   * `KazarrProvider` bbox query (`format=raw` → a flat gridded response, see
   * `GriddedFieldProtocol.js`'s file header for the exact shape) rather than
   * built as an explicit vertex/triangle mesh — see
   * `DeckGlLayerAdapter._createMeshLayer()` for the (unrelated) single-mesh-
   * with-real-relief case, and `GriddedFieldProtocol.js` for the per-tile
   * rasterization itself.
   *
   * Reached for `definition.type === 'raster'` with a `kazarr://` url — see
   * `_addGriddedFieldMeshLayer()` for the `definition.type === 'mesh'`
   * GPU-mesh alternative.
   *
   * `definition.variable` selects the Kazarr variable; `definition.colorRange`
   * (2+ hex colors) and `definition.domain` (`[min, max]`) customize the
   * colormap (domain defaults to each tile's own min/max — fine for a
   * single static view, but means the color scale isn't globally consistent
   * across tiles/zoom levels unless `domain` is set explicitly).
   * @param {import('maplibre-gl').Map} map
   * @param {string} id
   * @param {Object} definition
   */
  _addGriddedFieldLayer (map, id, definition) {
    ensureGriddedFieldProtocol()

    // `LayerAdapter._initialize()` (called before _postInitialize()) already
    // created a KazarrProvider for us, since definition.url uses the
    // kazarr:// protocol — reuse it rather than instantiating a second one.
    registerGriddedFieldSource(id, {
      provider: this._provider,
      variable: definition.variable,
      colorRange: definition.colorRange,
      domain: definition.domain,
      tileSize: definition.tileSize ?? 256,
      // Forwarded so GriddedFieldProtocol.js can read the engine's current
      // global time fresh on every tile request (see `_context.getGlobalTime()`
      // usage in `LayerAdapter._loadProviderData()` for the equivalent
      // non-tiled pattern).
      context: this._context
    })

    this._addRasterLayer(map, id, {
      ...definition,
      tiles: [this._griddedFieldRasterTileUrl(id)]
    })

    // MapLibre caches raster tiles by URL forever — `reloadData()` below
    // folds `time` into that same URL and calls `source.setTiles()`, which
    // MapLibre treats as a new tile identity, forcing fresh requests
    // without touching any internal cache API.
    this._griddedFieldRenderer = {
      reloadData: (time) => {
        const source = map.getSource(id)
        if (source && 'setTiles' in source) {
          source.setTiles([this._griddedFieldRasterTileUrl(id, time)])
        }
      }
    }
  }

  /**
   * Builds the `kazarr-field://` tile URL for `_addGriddedFieldLayer()`,
   * optionally folding in `time` as a query parameter purely to change the
   * URL (and so force MapLibre to treat it as a new tile source) on a time
   * change — `GriddedFieldProtocol.js`'s tile handler still resolves the
   * time it actually requests from `context.getGlobalTime()`, not from this
   * query string.
   * @param {string} id
   * @param {Date} [time]
   * @returns {string}
   */
  _griddedFieldRasterTileUrl (id, time = null) {
    const base = `kazarr-field://${id}/{z}/{x}/{y}`
    return time ? `${base}?time=${encodeURIComponent(time.toISOString())}` : base
  }

  /**
   * Adds a gridded scalar-field layer rendered as a single GPU-colored
   * triangle mesh (`GriddedFieldMeshLayer.js`) instead of rasterized
   * MapLibre tiles. Reached for `definition.type === 'mesh'` with a
   * `kazarr://` url (routed here by `LayerFactory`, instead of to
   * `DeckGlLayerAdapter` for an explicit static mesh) — see
   * `_addGriddedFieldLayer()` for the `definition.type === 'raster'`
   * raster-tile alternative, and `GriddedFieldMeshLayer.js`'s file header
   * for the full rationale and trade-offs between the two.
   *
   * Unlike `_addGriddedFieldLayer()`, this doesn't go through
   * `ensureGriddedFieldProtocol()`/`registerGriddedFieldSource()` at all —
   * `GriddedFieldMeshLayer` is a self-contained MapLibre `'custom'` GL
   * layer (no MapLibre source, no `kazarr-field://` protocol involved) that
   * fetches its own data directly from `this._provider`.
   * @param {import('maplibre-gl').Map} map
   * @param {string} id
   * @param {Object} definition
   */
  _addGriddedFieldMeshLayer (map, id, definition) {
    const meshLayer = new GriddedFieldMeshLayer(id, {
      // Reused from LayerAdapter._initialize() — same rationale as
      // _addGriddedFieldLayer() above, avoid a second redundant instance.
      provider: this._provider,
      variable: definition.variable,
      colorRange: definition.colorRange,
      domain: definition.domain,
      opacity: definition.opacity ?? definition.style?.paint?.['raster-opacity'] ?? definition.style?.['raster-opacity'],
      time: this._context.getGlobalTime()
    })

    map.addLayer(meshLayer)
    this._griddedFieldRenderer = meshLayer

    if (!this._layers) this._layers = []
    this._layers.push(id)
  }

  /**
   * Adds a gridded scalar-field layer rendered as a self-managed z/x/y tile
   * cache of GPU-colored meshes (`GriddedFieldTiledMeshLayer.js`) — a
   * middle ground between `_addGriddedFieldLayer()`'s per-tile CPU
   * rasterization and `_addGriddedFieldMeshLayer()`'s single whole-viewport
   * mesh. Reached for `definition.type === 'tiled-mesh'` with a `kazarr://`
   * url. See `GriddedFieldTiledMeshLayer.js`'s file header for the full
   * design discussion, including why this isn't a real MapLibre `Source`.
   *
   * Like `_addGriddedFieldMeshLayer()`, this doesn't go through
   * `ensureGriddedFieldProtocol()`/`registerGriddedFieldSource()` — no
   * MapLibre source or `kazarr-field://` protocol is involved, the layer
   * fetches its own per-tile data directly from `this._provider`.
   * @param {import('maplibre-gl').Map} map
   * @param {string} id
   * @param {Object} definition
   */
  _addGriddedFieldTiledMeshLayer (map, id, definition) {
    const tiledMeshLayer = new GriddedFieldTiledMeshLayer(id, {
      // Reused from LayerAdapter._initialize() — same rationale as the
      // other two gridded-field layer builders above, avoid a second
      // redundant provider instance.
      provider: this._provider,
      variable: definition.variable,
      colorRange: definition.colorRange,
      domain: definition.domain,
      opacity: definition.opacity ?? definition.style?.paint?.['raster-opacity'] ?? definition.style?.['raster-opacity'],
      minzoom: definition.minzoom,
      maxzoom: definition.maxzoom,
      time: this._context.getGlobalTime()
    })

    map.addLayer(tiledMeshLayer)
    this._griddedFieldRenderer = tiledMeshLayer

    if (!this._layers) this._layers = []
    this._layers.push(id)
  }
}
