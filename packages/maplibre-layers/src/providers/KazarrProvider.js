/**
 * @file KazarrProvider.js
 * @description Provider for multi-dimensional grid data served by a remote
 * Kazarr HTTP API ("Kazarr" = Kalisio + Zarr — Zarr being the N-dimensional,
 * cloud-native storage format the API serves from server-side).
 *
 * All Zarr decoding happens server-side: this provider only builds query
 * parameters/request bodies from its `options` (level, lat/lon, time(s),
 * interpolation, mesh settings, probe points...) and calls one of the API's
 * JSON endpoints (`/extract`, `/probe`, `/probes`, `/metadata`, `/select`),
 * returning the already-parsed JSON response — not a raw Zarr `ArrayBuffer`.
 * `get()`'s response shape depends on `_parameters.format` (`'geojson'` for
 * `'vector'` layers with `format: 'geojson'`, `'raw'` for `'raster'` layers
 * — a flat gridded response, see `GriddedFieldProtocol.js`'s file header
 * for the exact shape — `'mesh'` otherwise, incl. both `'mesh'`- and
 * `'tiled-mesh'`-type gridded fields, see `GriddedFieldMeshLayer.js` /
 * `GriddedFieldTiledMeshLayer.js`), consumed downstream by
 * `VectorLayerAdapter`/`ThreeJsLayerAdapter`/`GriddedFieldProtocol.js`/
 * `GriddedFieldMeshLayer.js`/`GriddedFieldTiledMeshLayer.js` respectively.
 */

export class KazarrProvider {
  _layerDefinition

  /**
   * Base URL of the dataset
   * @type {string}
   */
  _baseUrl

  /**
   * Name of the variable to extract
   * @type {string | undefined}
   */
  _variable

  /**
   * Cache of previously fetched metadata, keyed by store URL.
   */
  _metadataCache = null

  /**
   * Parameters for the request
   */
  _parameters = {}

  /**
   * Body for the request (for POST requests)
   * @type {Object}
   */
  _body = {}

  /**
   * @param {Object} definition - layer definition; `definition.url` must use
   *   the `kazarr://` protocol (rewritten to `http://` for `localhost`,
   *   `https://` otherwise), `definition.variable` optionally sets a default variable
   */
  constructor (definition) {
    this._layerDefinition = definition
    const protocol = definition.url.includes('localhost') ? 'http://' : 'https://'
    this._baseUrl = definition.url.replace(/^kazarr:\/\//, protocol)
    if (this._baseUrl.endsWith('/')) {
      this._baseUrl = this._baseUrl.slice(0, -1)
    }
    this._variable = definition.variable
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Fetches data for the given options (merged with `definition.kazarr`
   * defaults), called by `LayerAdapter._loadProviderData()`.
   * @param {Object} [options] - see the option shapes documented inline in `_parseOptions()`
   * @param {{ signal?: AbortSignal }} [requestOptions] - `signal`, if given, is
   * forwarded to the underlying `fetch()` so an in-flight request can be
   * cancelled (used by `GriddedFieldProtocol.js` to drop tiles MapLibre no
   * longer needs, e.g. panned/zoomed away from before the response arrives).
   * @returns {Promise<Object>} the parsed JSON response (GeoJSON or mesh data, per `_parameters.format`)
   * @throws {KazarrError} if the API responds with a structured error, or a generic `Error` if the response can't be parsed
   * @throws {DOMException} `AbortError`, if `requestOptions.signal` is aborted before the response arrives
   */
  async get (options = null, requestOptions = {}) {
    options = { ...this._layerDefinition.kazarr, ...options }
    this._parseOptions(options)

    return await this._fetch(requestOptions.signal)
  }

  /**
   * @returns {Promise<{ variables: string[], coordinates: Object }>}
   */
  async getVariablesAndCoordinates () {
    return {
      variables: await this.getVariables(),
      coordinates: await this.getCoordinates()
    }
  }

  /**
   * @returns {Promise<string[]>} available data variables, fetching/caching metadata first if needed
   */
  async getVariables () {
    if (!this._metadataCache) {
      await this._fetchMetadata()
    }
    return this._metadataCache?.variables || []
  }

  /**
   * @returns {Promise<Object>} available coordinate dimensions and their metadata, fetching/caching metadata first if needed
   */
  async getCoordinates () {
    if (!this._metadataCache) {
      await this._fetchMetadata()
    }
    return this._metadataCache?.coordinates || {}
  }

  /**
   * @param {string} coordinateName
   * @returns {Promise<{ values: Array, metadata: Object }>}
   */
  async getCoordinate (coordinateName) {
    return {
      values: (await this._fetchRaw(coordinateName)).data,
      metadata: (await this.getCoordinates())[coordinateName] || {}
    }
  }

  /**
   * Clears the request parameters/body accumulated by `_parseOptions()`
   * across prior `get()` calls, so the next `get()` starts from a clean slate.
   */
  reset () {
    this._parameters = {}
    this._body = {}
  }

  // ── Private Methods ────────────────────────────────────────────────────────

  /**
   * Acquires and parses Zarr data for a given layer and instant.
   *
   * @param {AbortSignal} [signal] forwarded to `fetch()`, if given
   * @returns {Promise<{ buffer: ArrayBuffer, metadata: Object, timeIndex?: number }>}
   * @throws {Error} if the store is inaccessible or the format is invalid
   */
  async _fetch (signal) {
    if (this._layerDefinition?.type === 'vector' && this._layerDefinition?.format === 'geojson') {
      this._parameters.format = 'geojson'
    } else if (this._layerDefinition?.type === 'raster') {
      // A flat gridded response (`shape`/`longitudes`/`latitudes`/`values`,
      // see GriddedFieldProtocol.js's file header for the exact shape),
      // consumed by GriddedFieldProtocol.js to rasterize one MapLibre
      // raster tile at a time. Only reached for a 'raster'-type layer whose
      // `definition.url` uses `kazarr://` in the first place (a provider is
      // only ever created for a kazarr:// url — see `_createProvider()`), so
      // this never fires for a plain, non-Kazarr raster tile source.
      this._parameters.format = 'raw'
    } else {
      // Includes `'mesh'`- and `'tiled-mesh'`-type gridded fields
      // (GriddedFieldMeshLayer.js / GriddedFieldTiledMeshLayer.js both
      // expect `{ vertices, indices, values }`, already triangulated
      // server-side).
      this._parameters.format = 'mesh'
    }

    let endpoint = 'extract'
    if (this._body?.type === 'FeatureCollection') endpoint = 'probes'
    else if (this._parameters.latitude && this._parameters.longitude) endpoint = 'probe'

    const params = new URLSearchParams(this._parameters).toString()
    const options = { method: endpoint === 'probes' ? 'POST' : 'GET', signal }
    if (endpoint === 'probes') {
      options.body = JSON.stringify(this._body)
      options.headers = { 'Content-Type': 'application/json' }
    }

    const fullUrl = `${this._baseUrl}/${endpoint}?${params}`

    const response = await fetch(fullUrl, options)
    try {
      const json = await response.json()
      if (!response.ok) {
        throw new KazarrError(json)
      }
      return json
    } catch (e) {
      if (e instanceof KazarrError) {
        throw e
      } else {
        throw new Error(`[KazarrProvider] Cannot parse response from kazarr at ${fullUrl}: ${e.message}`)
      }
    }
  }

  /**
   * Fetches and caches the dataset metadata from the /metadata endpoint.
   *
   * @returns {Promise<Object>} Parsed store metadata
   */
  async _fetchMetadata () {
    const metadataUrl = `${this._baseUrl}/metadata`

    const response = await fetch(metadataUrl)
    if (!response.ok) {
      throw new Error(`[KazarrProvider] Cannot fetch Zarr metadata at ${metadataUrl}: ${response.statusText}`)
    }

    const rawMetadata = await response.json()
    this._metadataCache = rawMetadata // cache for future use
    return rawMetadata
  }

  /**
   * Fetches the raw values of one variable/coordinate from the `/select` endpoint.
   * @param {string} targetVariable
   * @returns {Promise<{ data: Array }>}
   * @throws {Error} if the request fails
   */
  async _fetchRaw (targetVariable) {
    const targetUrl = `${this._baseUrl}/select?variable=${targetVariable}`
    const response = await fetch(targetUrl)
    if (!response.ok) {
      throw new Error(`[KazarrProvider] Cannot fetch Zarr raw data at ${targetUrl}: ${response.statusText}`)
    }

    return await response.json()
  }

  /**
   * Translates the business `options` object into `_parameters` (query
   * string) and `_body` (POST body, for probe requests), used by `_fetch()`.
   * Accepted option shapes are documented inline below (`level`, `latitude`/
   * `longitude`, `time`/`times`, `variable`/`variables`, `interpolation`,
   * `mesh`, `additional`, `is3D`, `points`).
   * @param {Object} options
   */
  _parseOptions (options) {
    // level => float | { min: float, max: float }
    // latitude => float | { min: float, max: float }
    // longitude => float | { min: float, max: float }
    // time => Date | { start: Date, end: Date }
    // times => Date[] | [{ start: Date, end: Date }]
    // variable => string
    // variables => string[]
    // interpolation => { variables: { method: 'nearest', list: [], options: {} }, spatial: { method: 'nearest', options: {} } }
    // mesh => { tileSize: number, dataMapping: 'vertices' | 'cells' }
    // additional => { [key: string]: any | { value: any, isDimension: boolean } }
    // is3D => boolean
    // points => GeoJSON FeatureCollection or array of { latitude, longitude, level? }

    if (!options) return

    if (options.variable) {
      this._parameters.variable = options.variable
    }
    if (options.variables) {
      if (Array.isArray(options.variables)) {
        this._parameters.variables = options.variables
      } else {
        console.warn('[KazarrProvider] "variables" option must be an array of strings.')
      }
    }

    if (options.latitude) {
      if (!Number.isNaN(Number.parseFloat(options.latitude))) {
        this._parameters.lat = Number.parseFloat(options.latitude)
      } else if (typeof options.latitude === 'object') {
        if (!Number.isNaN(Number.parseFloat(options.latitude.min))) {
          this._parameters.lat_min = Number.parseFloat(options.latitude.min)
        }
        if (!Number.isNaN(Number.parseFloat(options.latitude.max))) {
          this._parameters.lat_max = Number.parseFloat(options.latitude.max)
        }
      }
    }
    if (options.longitude) {
      if (!Number.isNaN(Number.parseFloat(options.longitude))) {
        this._parameters.lon = Number.parseFloat(options.longitude)
      } else if (typeof options.longitude === 'object') {
        if (!Number.isNaN(Number.parseFloat(options.longitude.min))) {
          this._parameters.lon_min = Number.parseFloat(options.longitude.min)
        }
        if (!Number.isNaN(Number.parseFloat(options.longitude.max))) {
          this._parameters.lon_max = Number.parseFloat(options.longitude.max)
        }
      }
    }
    if (options.level) {
      if (!Number.isNaN(Number.parseFloat(options.level))) {
        this._parameters.level = Number.parseFloat(options.level)
      } else if (typeof options.level === 'object') {
        if (!Number.isNaN(Number.parseFloat(options.level.min))) {
          this._parameters.level_min = Number.parseFloat(options.level.min)
        }
        if (!Number.isNaN(Number.parseFloat(options.level.max))) {
          this._parameters.level_max = Number.parseFloat(options.level.max)
        }
      }
    }

    if ((options.latitude && !options.longitude) || (!options.latitude && options.longitude)) {
      console.warn('[KazarrProvider] Both latitude and longitude must be provided together for spatial filtering.')
      return
    }

    const isProbe = options.points || (options.latitude && options.longitude)

    if (options.time) {
      if (isProbe && options.times) {
        // Can't have both a single time and multiple times for a probe request
        delete this._parameters.time
      } else if (options.time instanceof Date) {
        this._parameters.time = options.time.toISOString()
      } else if (typeof options.time === 'object' && options.time.start && options.time.end) {
        this._parameters.time = `${options.time.start.toISOString()}/${options.time.end.toISOString()}`
      } else {
        console.warn('[KazarrProvider] Time option must be a Date object or an object with start and end Dates.')
      }
    }
    if (options.times) {
      const times = []
      for (const t of options.times) {
        if (t instanceof Date) {
          times.push(t.toISOString())
        } else if (typeof t === 'object' && t.start && t.end) {
          times.push(`${t.start.toISOString()}/${t.end.toISOString()}`)
        } else {
          console.warn('[KazarrProvider] Each entry in times must be a Date or an object with start and end Dates.')
        }
      }

      if (this._body?.type === 'FeatureCollection') {
        this._body.times = times
      } else {
        this._body = { type: 'FeatureCollection', features: [], times }
      }
    }

    if (options.interpolation) {
      if (typeof options.interpolation === 'object') {
        if (options.interpolation.variables?.method) {
          this._parameters.interp_vars_method = options.interpolation.variables.method
        }
        if (options.interpolation.variables?.list) {
          this._parameters.interp_vars = options.interpolation.variables.list
        }
        if (options.interpolation.variables?.options) {
          this._parameters.interp_vars_params = options.interpolation.variables.options
        }

        if (options.interpolation.spatial?.method) {
          this._parameters.interp_spatial_method = options.interpolation.spatial.method
        }
        if (options.interpolation.spatial?.options) {
          this._parameters.interp_spatial_params = options.interpolation.spatial.options
        }
      } else {
        console.warn('[KazarrProvider] Interpolation option must be an object with variables and/or spatial properties.')
      }
    }

    if (options.mesh) {
      if (typeof options.mesh === 'object') {
        if (options.mesh.tileSize && !Number.isNaN(Number.parseInt(options.mesh.tileSize))) {
          this._parameters.mesh_tile_size = Number.parseInt(options.mesh.tileSize)
        }
        if (options.mesh.dataMapping && ['vertices', 'cells'].includes(options.mesh.dataMapping)) {
          this._parameters.mesh_data_mapping = options.mesh.dataMapping
        }
      } else {
        console.warn('[KazarrProvider] Mesh option must be an object with tileSize and dataMapping properties.')
      }
    }

    if (options.additional) {
      if (typeof options.additional === 'object') {
        Object.assign(this._parameters, options.additional)
      } else {
        console.warn('[KazarrProvider] Additional option must be an object with key-value pairs.')
      }
    }

    if (options.is3D !== undefined) {
      this._parameters.is3D = Boolean(options.is3D)
    }

    if (options.points) {
      if (Array.isArray(options.points)) {
        const features = options.points.map((pt) => {
          if (typeof pt === 'object' && pt.latitude !== undefined && pt.longitude !== undefined) {
            const coords = [pt.longitude, pt.latitude]
            if (pt.level !== undefined) {
              coords.push(pt.level)
            }
            return {
              type: 'Feature',
              geometry: {
                type: 'Point',
                coordinates: coords
              },
              properties: {}
            }
          }

          return null
        })

        if (this._body?.type === 'FeatureCollection') {
          this._body.features = features
        } else {
          this._body = { type: 'FeatureCollection', features }
        }
      } else if (typeof options.points === 'object' && options.points.type === 'FeatureCollection') {
        if (this._body?.type === 'FeatureCollection') {
          this._body.features = options.points.features
        } else {
          this._body = { type: 'FeatureCollection', features: options.points.features }
        }
      } else {
        console.warn('[KazarrProvider] Points option must be an array of coordinates or a GeoJSON FeatureCollection.')
      }
    }
  }

  /**
   * Expands a probe-response `FeatureCollection` whose features carry
   * per-time arrays (`geojson.times` plus matching array-valued properties)
   * into one feature per `(original feature, time)` pair, each with a scalar
   * `time` property and scalar values for the expanded properties.
   * @param {Object} geojson - a `FeatureCollection` with a top-level `times` array
   * @param {string[]} [properties] - property names to expand; all matching array-valued properties if omitted
   * @returns {Object} a new `FeatureCollection`, or the input unchanged if it isn't a valid `FeatureCollection` with `times`
   */
  _toOneTimePerFeature (geojson, properties = null) {
    if (geojson?.type !== 'FeatureCollection') {
      console.warn('[KazarrProvider] Input must be a GeoJSON FeatureCollection.')
      return geojson
    }

    if (!geojson.times || !Array.isArray(geojson.times)) {
      console.warn('[KazarrProvider] FeatureCollection must have a "times" array.')
      return geojson
    }

    const features = []
    for (const feature of geojson.features) {
      if (!feature.properties) continue

      const targetProperties = []
      for (const property in feature.properties) {
        const isValidArray = Array.isArray(feature.properties[property]) && feature.properties[property].length === geojson.times.length
        const isInTargetProperties = !properties || properties.includes(property)
        if (isValidArray && isInTargetProperties) {
          targetProperties.push(property)
        }
      }

      for (let i = 0; i < geojson.times.length; i++) {
        const newFeature = { ...feature }
        newFeature.properties.time = geojson.times[i]
        for (const targetProperty of targetProperties) {
          newFeature.properties[targetProperty] = feature.properties[targetProperty][i]
        }
        features.push(newFeature)
      }
    }
    return {
      type: 'FeatureCollection',
      features
    }
  }
}

/**
 * Structured error thrown when the Kazarr API responds with a non-OK status
 * and a `{ detail: { message, error_code, payload } }` JSON body.
 */
class KazarrError extends Error {
  /**
   * @param {{ detail: { message: string, error_code: string, payload?: * } }} response - parsed JSON error response
   */
  constructor (response) {
    super(response.detail.message)
    this.name = 'KazarrError'
    this.type = response.detail.error_code
    this.payload = response.detail.payload
  }
}
