/**
 * @file GriddedFieldMeshLayer.js
 * @description GPU-rendered alternative to `GriddedFieldProtocol.js`'s
 * raster-tile rendering for a gridded scalar field: a `kazarr://` dataset
 * with `definition.type === 'mesh'` (routed here by `LayerFactory` instead
 * of to `DeckGlLayerAdapter`'s explicit-static-mesh path, based on that
 * `kazarr://` protocol check) — see
 * `MapLibreLayerAdapter._addGriddedFieldMeshLayer()`. There are now THREE
 * renderings total for a `kazarr://` gridded field, selected by
 * `definition.type`: `'raster'` (`GriddedFieldProtocol.js`), `'mesh'` (this
 * file), and `'tiled-mesh'` (`GriddedFieldTiledMeshLayer.js` — same GPU-mesh
 * idea as this file, but split into z/x/y tiles so panning doesn't refetch
 * the whole viewport). The shader/GL/mesh-parsing code shared between this
 * file and `GriddedFieldTiledMeshLayer.js` lives in `GriddedFieldGL.js`.
 *
 * Instead of rasterizing one PNG per MapLibre tile, this registers a single
 * MapLibre `'custom'` GL layer that fetches Kazarr's `format=mesh` response
 * (`{ vertices, indices, values }`, already triangulated server-side) for
 * the current viewport bbox, uploads it as GPU buffers, and lets a fragment
 * shader do the colormap lookup (a 1D LUT texture) and missing-value
 * discard every frame — no per-pixel CPU work at all.
 *
 * Compared to the raster-tile approach: one Kazarr request per viewport
 * change instead of one per visible tile (less redundant server load during
 * pan/zoom), zero main-thread rasterization cost, no seams between
 * independently-sampled tiles (this is a single continuous mesh), and
 * instant recoloring — changing `domain`/`colorRange` is a GPU uniform
 * update, not a re-fetch. The trade-off is giving up MapLibre's built-in
 * tiling/culling/LOD pipeline: fine for a regional grid (e.g. AROME), but a
 * whole-globe ARPEGE view at low zoom could mean a very large mesh with no
 * decimation, AND every pan refetches the entire viewport from scratch even
 * where it overlaps the previous one — `'tiled-mesh'` exists specifically
 * to address that second point, see its file header for why a real
 * MapLibre `Source`/tile pyramid couldn't be used for it and what it does
 * instead.
 *
 * Loading strategy is "viewport" (refetch on `moveend`), not "preload the
 * whole dataset" — appropriate since `definition.url` can point at
 * whole-earth coverage.
 *
 * @todo Kazarr's `format=mesh` response shape assumed by
 * `GriddedFieldGL.js`'s `meshResponseToTypedArrays()` (`vertices` flat
 * `[lon0, lat0, alt0, lon1, lat1, alt1, ...]`, `indices` a flat triangle
 * list, `values` one scalar per vertex aligned by array index, `null` for
 * missing data) is UNCONFIRMED against a real response. If this renders
 * garbled or empty, get a real `format=mesh` response dumped first rather
 * than guessing further tweaks — see that function's own `@todo` for
 * details, since both mesh renderings share it.
 * @todo No decimation/LOD — a very large viewport-scale mesh (e.g. whole
 * globe at low zoom) could be slow to build/upload every `moveend`.
 * @todo No live update wired for `domain`/`colorRange`/`opacity` after
 * construction (no public API calls into it yet) — would be cheap to add
 * (just a uniform/texture update + `triggerRepaint()`) if ever needed.
 */
import {
  VERTEX_SHADER_SRC,
  FRAGMENT_SHADER_SRC,
  DEFAULT_COLOR_RANGE,
  createShaderProgram,
  createColormapTexture,
  supportsUint32Indices,
  meshResponseToTypedArrays
} from './GriddedFieldGL.js'

/**
 * A MapLibre `CustomLayerInterface` implementation — instantiate and pass
 * directly to `map.addLayer()` (no source id involved, this layer manages
 * its own GPU resources and data fetching end to end).
 */
export class GriddedFieldMeshLayer {
  type = 'custom'
  renderingMode = '2d'

  /**
   * @param {string} id MapLibre layer id (the business layer id)
   * @param {{ provider: import('../providers/KazarrProvider.js').KazarrProvider, variable?: string, colorRange?: string[], domain?: [number, number], opacity?: number, time?: Date }} config
   */
  constructor (id, config) {
    this.id = id
    this._provider = config.provider
    this._variable = config.variable
    this._colorRange = config.colorRange || DEFAULT_COLOR_RANGE
    this._domain = config.domain
    this._opacity = config.opacity ?? 1
    /** Set by `setTime()` — read by `_refreshViewport()`, never resolved internally. */
    this._time = config.time ?? null

    this._map = null
    this._gl = null
    this._program = null
    this._vertexBuffer = null
    this._indexBuffer = null
    this._valueBuffer = null
    this._colormapTexture = null
    this._useUint32Indices = false

    this._indexCount = 0
    this._isReady = false
    /** Computed from the last fetched values when `config.domain` isn't set. */
    this._computedDomain = null

    this._abortController = null
    this._onMoveEnd = null
  }

  // ── MapLibre CustomLayerInterface ───────────────────────────────────────

  /**
   * @param {import('maplibre-gl').Map} map
   * @param {WebGLRenderingContext | WebGL2RenderingContext} gl MapLibre's own GL context — shared, not a dedicated one
   */
  async onAdd (map, gl) {
    this._map = map
    this._gl = gl

    this._useUint32Indices = supportsUint32Indices(gl)
    if (!this._useUint32Indices) {
      console.warn(`[GriddedFieldMeshLayer] "${this.id}": OES_element_index_uint not available — meshes over 65535 vertices won't render correctly.`)
    }

    this._program = createShaderProgram(gl, VERTEX_SHADER_SRC, FRAGMENT_SHADER_SRC, this.id)
    if (!this._program) {
      console.error(`[GriddedFieldMeshLayer] "${this.id}": failed to compile shaders.`)
      return
    }

    this._vertexBuffer = gl.createBuffer()
    this._indexBuffer = gl.createBuffer()
    this._valueBuffer = gl.createBuffer()
    this._colormapTexture = createColormapTexture(gl, this._colorRange)

    this._onMoveEnd = () => this._refreshViewport()
    map.on('moveend', this._onMoveEnd)

    await this._refreshViewport()
  }

  /**
   * @param {WebGLRenderingContext | WebGL2RenderingContext} gl
   * @param {Float32Array | number[] | Object} matrix MapLibre passes a plain
   * matrix in older versions, or a `ProjectionData`-like object with the
   * matrix nested inside in newer ones — handle both.
   */
  render (gl, matrix) {
    if (!this._isReady || !this._program || this._indexCount === 0) return

    let matrixArray
    if (matrix instanceof Float32Array || Array.isArray(matrix)) {
      matrixArray = matrix
    } else {
      const raw = matrix?.defaultProjectionData?.mainMatrix ?? matrix?.projectionData?.mainMatrix ?? matrix?.mainMatrix
      if (!raw) return
      matrixArray = raw instanceof Float32Array ? raw : new Float32Array(raw)
    }

    if (gl.bindVertexArray) gl.bindVertexArray(null)

    gl.useProgram(this._program)

    const [min, max] = this._domain || this._computedDomain || [0, 1]

    gl.uniformMatrix4fv(gl.getUniformLocation(this._program, 'u_matrix'), false, matrixArray)
    gl.uniform1f(gl.getUniformLocation(this._program, 'u_min_value'), min)
    gl.uniform1f(gl.getUniformLocation(this._program, 'u_max_value'), max)
    gl.uniform1f(gl.getUniformLocation(this._program, 'u_opacity'), this._opacity)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this._colormapTexture)
    gl.uniform1i(gl.getUniformLocation(this._program, 'u_colormap'), 0)

    const posLoc = gl.getAttribLocation(this._program, 'a_position')
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer)
    gl.enableVertexAttribArray(posLoc)
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0)

    const valLoc = gl.getAttribLocation(this._program, 'a_value')
    gl.bindBuffer(gl.ARRAY_BUFFER, this._valueBuffer)
    gl.enableVertexAttribArray(valLoc)
    gl.vertexAttribPointer(valLoc, 1, gl.FLOAT, false, 0, 0)

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)

    const indexType = this._useUint32Indices ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT
    gl.drawElements(gl.TRIANGLES, this._indexCount, indexType, 0)

    gl.disableVertexAttribArray(posLoc)
    gl.disableVertexAttribArray(valLoc)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  /**
   * @param {import('maplibre-gl').Map} map
   * @param {WebGLRenderingContext | WebGL2RenderingContext} [gl]
   */
  onRemove (map, gl) {
    if (this._abortController) {
      this._abortController.abort()
      this._abortController = null
    }
    if (this._onMoveEnd) {
      map.off('moveend', this._onMoveEnd)
      this._onMoveEnd = null
    }
    if (gl) {
      if (this._vertexBuffer) gl.deleteBuffer(this._vertexBuffer)
      if (this._indexBuffer) gl.deleteBuffer(this._indexBuffer)
      if (this._valueBuffer) gl.deleteBuffer(this._valueBuffer)
      if (this._colormapTexture) gl.deleteTexture(this._colormapTexture)
      if (this._program) gl.deleteProgram(this._program)
    }
    this._gl = null
    this._map = null
    this._isReady = false
    this._indexCount = 0
  }

  // ── Data fetching ────────────────────────────────────────────────────────

  /**
   * Sets the time used for subsequent fetches. Does not itself trigger a
   * refetch — see `reloadData()`.
   * @param {Date} time
   */
  setTime (time) {
    this._time = time
  }

  /**
   * Re-fetches the current viewport — used both to catch up a layer that
   * was shown after missing a `moveend`, and as the underlying mechanism
   * for `reloadData()` below (a single fetch always covers the whole
   * viewport, so there's no per-tile cache to invalidate here).
   * @returns {Promise<void>}
   */
  refresh () {
    return this._refreshViewport()
  }

  /**
   * Updates the fetch time and re-fetches the current viewport for it —
   * called by `UrlStrategy` on a global time change.
   * @param {Date} time
   * @returns {Promise<void>}
   */
  reloadData (time) {
    this.setTime(time)
    return this._refreshViewport()
  }

  /**
   * Cancels any in-flight fetch, requests `format=mesh` data for the current
   * viewport bbox, and uploads the result as GPU buffers via `_uploadMesh()`.
   * Bound to the map's `moveend` event in `onAdd()`.
   */
  async _refreshViewport () {
    if (!this._provider || !this._map || !this._gl) return

    if (this._abortController) this._abortController.abort()
    this._abortController = new AbortController()
    const signal = this._abortController.signal

    const bounds = this._map.getBounds()
    const options = {
      longitude: { min: bounds.getWest(), max: bounds.getEast() },
      latitude: { min: bounds.getSouth(), max: bounds.getNorth() }
    }
    // Same footgun as GriddedFieldProtocol.js: KazarrProvider.get() merges
    // `{ ...definition.kazarr, ...options }`, so an explicit `variable:
    // undefined` here would still win over a `definition.kazarr.variable`
    // default — only include it when actually configured.
    if (this._variable) options.variable = this._variable
    if (this._time) options.time = this._time

    try {
      const response = await this._provider.get(options, { signal })
      this._uploadMesh(response)
    } catch (e) {
      if (e?.name !== 'AbortError') {
        console.error(`[GriddedFieldMeshLayer] "${this.id}": viewport refresh failed.`, e)
      }
    }
  }

  /**
   * @param {{ vertices: number[], indices: number[], values: (number|null)[] }} response
   * Kazarr's `format=mesh` response — parsed via `GriddedFieldGL.js`'s
   * `meshResponseToTypedArrays()`, see that function's `@todo` about this
   * shape being unconfirmed.
   */
  _uploadMesh (response) {
    const parsed = meshResponseToTypedArrays(response, this._useUint32Indices)
    if (!parsed) {
      console.error(`[GriddedFieldMeshLayer] "${this.id}": unexpected Kazarr mesh response (missing vertices/indices/values).`, response)
      return
    }
    const { positions, values, indices, min, max } = parsed

    // Only used as a fallback in render() when `this._domain` (from
    // `definition.domain`) isn't set — recomputed on every viewport refetch,
    // so the color scale can drift between refetches unless `domain` is set
    // explicitly (same caveat as the raster-tile path).
    if (!this._domain && Number.isFinite(min) && Number.isFinite(max)) {
      this._computedDomain = [min, max]
    }

    const gl = this._gl

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW)

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW)
    this._indexCount = indices.length

    gl.bindBuffer(gl.ARRAY_BUFFER, this._valueBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, values, gl.DYNAMIC_DRAW)

    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)

    this._isReady = true
    this._map?.triggerRepaint()
  }
}
