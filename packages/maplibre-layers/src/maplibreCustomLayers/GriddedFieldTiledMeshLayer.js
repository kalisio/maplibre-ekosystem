/**
 * @file GriddedFieldTiledMeshLayer.js
 * @description Third rendering for a `kazarr://` gridded scalar field,
 * `definition.type === 'tiled-mesh'` — a middle ground between
 * `GriddedFieldProtocol.js`'s per-tile CPU rasterization (`'raster'`) and
 * `GriddedFieldMeshLayer.js`'s single whole-viewport GPU mesh (`'mesh'`):
 * this fetches and renders one GPU mesh PER z/x/y tile, keeping tiles that
 * remain visible across a pan/zoom instead of refetching the whole viewport
 * every time.
 *
 * ## Why this is a self-managed tile cache, not a real MapLibre Source
 *
 * A true custom `Source` (`maplibregl.addSourceType`), whose
 * `loadTile()`/`unloadTile()` would hook into MapLibre's own `SourceCache`
 * for tile fetch/cache/evict/prefetch, does not compose with a GPU-mesh
 * custom layer — verified against the actual installed maplibre-gl (4.7.1)
 * source, for three reasons:
 *
 *  - A `Source`'s `loadTile(tile)` is real (async/Promise-based) but a
 *    `RasterTileSource` populates `tile.texture` and relies on
 *    `draw_raster.ts` to render it — that draw path is tied to a `'raster'`
 *    STYLE LAYER reading `tile.texture`, not to arbitrary GPU geometry. A
 *    custom `Source` has no hook to draw a mesh instead.
 *  - `CustomLayerInterface` (what `GriddedFieldMeshLayer` already uses to
 *    draw a mesh) has no `source` property at all and is never notified of
 *    a Source's tile load/unload — nothing bridges "a Source loaded tile
 *    z/x/y" to "a custom layer's render() call".
 *  - `SourceCache` only loads tiles for a source once some real style-spec
 *    layer (one with a `source` field, e.g. `'raster'`/`'fill'`) references
 *    that source id (`source._used`/`usedForTerrain`) — a source with only a
 *    `'custom'` layer "next to" it never triggers any tile loading at all.
 *
 * So a working `addSourceType` version would have needed: a custom `Source`
 * whose `loadTile()`/`unloadTile()` populate/clear a shared in-memory mesh
 * registry, PLUS an invisible dummy `'raster'` layer just to make
 * `SourceCache` treat the source as used, PLUS this same `'custom'` GL
 * layer reading that shared registry every frame to actually draw — three
 * moving parts standing in for what looks like it should be one. Given
 * that real complexity/risk, and that the actual goal (avoid refetching
 * tiles that stay on screen across a pan) doesn't need MapLibre's tile
 * *rendering* pipeline at all, just its z/x/y *bookkeeping*, we build that
 * bookkeeping ourselves here instead — see `tileGrid.js`.
 *
 * ## What this actually does
 *
 * A single `'custom'` GL layer (like `GriddedFieldMeshLayer`) that, on
 * `moveend`: picks a target zoom (`Math.round(map.getZoom())`, clamped to
 * `[definition.minzoom, definition.maxzoom]` if set), enumerates the z/x/y
 * tiles covering the current viewport at that zoom (`lngLatToTile()` on
 * each viewport corner), diffs that set against `this._tiles` (a
 * `Map<tileKey, TileEntry>`), fetches any newly-needed tile (`provider.get()`
 * with `tileToBBox(z, x, y)` as the request bbox — the SAME deterministic
 * bbox-per-tile function `GriddedFieldProtocol.js` uses, which is what
 * makes these requests cacheable server-side/HTTP-side, see that file's
 * header), evicts (frees GPU buffers for) tiles no longer covering the
 * viewport, and leaves everything else untouched. `render()` just draws
 * every currently-loaded tile's mesh with the shared shader from
 * `GriddedFieldGL.js`.
 *
 * A zoom CHANGE always refetches every visible tile (there's no pyramid —
 * z9's tiles aren't derived from z8's), but a PAN at a fixed zoom only
 * fetches the newly-exposed tiles and reuses the rest — that's the whole
 * point of this mode over `'mesh'`, see the file header discussion above.
 *
 * ## Zoom-change eviction is deferred until the replacement is ready
 *
 * Eviction happens in two steps: `_refreshTiles()` fetches every
 * newly-needed tile first (old tiles, at any zoom, stay in `this._tiles`
 * and keep rendering untouched the whole time), and only once that fetch
 * batch settles does it evict whatever is still not in the (freshly
 * recomputed) wanted set — evicting immediately, before the fetches
 * complete, would leave a blank map until the new tiles arrive. A
 * `_requestId` counter guards against a rapid pan/zoom sequence: only the
 * MOST RECENT `_refreshTiles()` call is allowed to evict, so an in-flight
 * older call finishing late can't wipe out tiles a newer call already
 * fetched. This produces a "hold the old view, swap once the new one is
 * whole" transition, not an animated cross-fade — there's no gradual
 * blending between old and new tiles (that would need a render loop plus a
 * per-tile opacity uniform).
 *
 * @todo Kazarr's `format=mesh` response shape is UNCONFIRMED — see
 * `GriddedFieldGL.js`'s `meshResponseToTypedArrays()` `@todo`.
 * @todo No cross-tile domain consistency: each tile's `_computedDomain`
 * fallback (when `definition.domain` isn't set) is that tile's own min/max,
 * so adjacent tiles fetched at different times can show inconsistent
 * colors for the same underlying value — same caveat as the other two
 * gridded-field renderings; set `definition.domain` explicitly to avoid it.
 * @todo No decimation/LOD within a tile, and no tile-count cap — a very
 * large viewport at a low target zoom could mean many simultaneous tile
 * fetches. Revisit if that's actually a problem for some dataset.
 * @todo The "wait for the whole batch, then evict" swap means a single slow
 * or failed tile in the new set holds back eviction of ALL stale tiles, not
 * just the one it would visually replace — acceptable for a "hold old
 * until new is ready" transition, but if a true per-tile crossfade is ever
 * needed, revisit doing per-tile eviction instead (evict a stale tile as
 * soon as ITS replacement lands, via a geometric overlap check) rather than
 * this whole-batch approach.
 */
import { tileToBBox, lngLatToTile } from '../utils/tileGrid.js'
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
 * @typedef {Object} TileEntry
 * @property {WebGLBuffer} vertexBuffer
 * @property {WebGLBuffer} indexBuffer
 * @property {WebGLBuffer} valueBuffer
 * @property {number} indexCount
 * @property {[number, number] | null} domain this tile's own computed [min, max]
 */

/**
 * A MapLibre `CustomLayerInterface` implementation rendering a self-managed
 * z/x/y tile cache of GPU meshes — see the file header for why this isn't a
 * real MapLibre `Source`.
 */
export class GriddedFieldTiledMeshLayer {
  type = 'custom'
  renderingMode = '2d'

  /**
   * @param {string} id MapLibre layer id (the business layer id)
   * @param {{ provider: import('./providers/KazarrProvider.js').KazarrProvider, variable?: string, colorRange?: string[], domain?: [number, number], opacity?: number, minzoom?: number, maxzoom?: number, time?: Date }} config
   */
  constructor (id, config) {
    this.id = id
    this._provider = config.provider
    this._variable = config.variable
    this._colorRange = config.colorRange || DEFAULT_COLOR_RANGE
    this._domain = config.domain
    this._opacity = config.opacity ?? 1
    this._minzoom = config.minzoom ?? 0
    this._maxzoom = config.maxzoom ?? 22
    /** Set by `setTime()` — read by `_fetchTile()`, never resolved internally. */
    this._time = config.time ?? null

    this._map = null
    this._gl = null
    this._program = null
    this._colormapTexture = null
    this._useUint32Indices = false

    /** @type {Map<string, TileEntry>} keyed by `"z/x/y"` */
    this._tiles = new Map()
    /** @type {Map<string, AbortController>} in-flight fetches, keyed the same way */
    this._pending = new Map()
    /**
     * Incremented at the start of every `_refreshTiles()` call — only the
     * call that still holds the latest id by the time its fetch batch
     * settles is allowed to evict stale tiles (see the file header's
     * "Zoom-change eviction is deferred" section).
     */
    this._requestId = 0

    this._onMoveEnd = null
  }

  // ── MapLibre CustomLayerInterface ───────────────────────────────────────

  /**
   * @param {import('maplibre-gl').Map} map
   * @param {WebGLRenderingContext | WebGL2RenderingContext} gl
   */
  async onAdd (map, gl) {
    this._map = map
    this._gl = gl

    this._useUint32Indices = supportsUint32Indices(gl)
    if (!this._useUint32Indices) {
      console.warn(`[GriddedFieldTiledMeshLayer] "${this.id}": OES_element_index_uint not available — tiles over 65535 vertices won't render correctly.`)
    }

    this._program = createShaderProgram(gl, VERTEX_SHADER_SRC, FRAGMENT_SHADER_SRC, this.id)
    if (!this._program) {
      console.error(`[GriddedFieldTiledMeshLayer] "${this.id}": failed to compile shaders.`)
      return
    }

    this._colormapTexture = createColormapTexture(gl, this._colorRange)

    this._onMoveEnd = () => this._refreshTiles()
    map.on('moveend', this._onMoveEnd)

    await this._refreshTiles()
  }

  /**
   * @param {WebGLRenderingContext | WebGL2RenderingContext} gl
   * @param {Float32Array | number[] | Object} matrix same dual convention as `GriddedFieldMeshLayer.render()`
   */
  render (gl, matrix) {
    if (!this._program || this._tiles.size === 0) return

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

    const matrixLoc = gl.getUniformLocation(this._program, 'u_matrix')
    const minLoc = gl.getUniformLocation(this._program, 'u_min_value')
    const maxLoc = gl.getUniformLocation(this._program, 'u_max_value')
    const opacityLoc = gl.getUniformLocation(this._program, 'u_opacity')
    const posLoc = gl.getAttribLocation(this._program, 'a_position')
    const valLoc = gl.getAttribLocation(this._program, 'a_value')

    gl.uniformMatrix4fv(matrixLoc, false, matrixArray)
    gl.uniform1f(opacityLoc, this._opacity)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this._colormapTexture)
    gl.uniform1i(gl.getUniformLocation(this._program, 'u_colormap'), 0)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)

    const indexType = this._useUint32Indices ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT

    gl.enableVertexAttribArray(posLoc)
    gl.enableVertexAttribArray(valLoc)

    for (const tile of this._tiles.values()) {
      const [min, max] = this._domain || tile.domain || [0, 1]
      gl.uniform1f(minLoc, min)
      gl.uniform1f(maxLoc, max)

      gl.bindBuffer(gl.ARRAY_BUFFER, tile.vertexBuffer)
      gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0)

      gl.bindBuffer(gl.ARRAY_BUFFER, tile.valueBuffer)
      gl.vertexAttribPointer(valLoc, 1, gl.FLOAT, false, 0, 0)

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, tile.indexBuffer)
      gl.drawElements(gl.TRIANGLES, tile.indexCount, indexType, 0)
    }

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
    for (const controller of this._pending.values()) controller.abort()
    this._pending.clear()

    if (this._onMoveEnd) {
      map.off('moveend', this._onMoveEnd)
      this._onMoveEnd = null
    }

    if (gl) {
      for (const tile of this._tiles.values()) this._freeTile(gl, tile)
      if (this._colormapTexture) gl.deleteTexture(this._colormapTexture)
      if (this._program) gl.deleteProgram(this._program)
    }
    this._tiles.clear()

    this._gl = null
    this._map = null
  }

  // ── Tile cache management ───────────────────────────────────────────────

  /**
   * Re-syncs the tile cache to the current viewport — fetches whatever
   * tiles are newly needed and evicts whatever fell out of view. A no-op
   * until `onAdd()` has run (`_map`/`_gl` not set yet).
   * Exposed so `MapLibreLayerAdapter.setVisibility()` can catch up a layer
   * that missed viewport changes while hidden — tile fetching here is
   * driven by `moveend`, which doesn't fire just because visibility toggled.
   * @returns {Promise<void>}
   */
  refresh () {
    return this._refreshTiles()
  }

  /**
   * Sets the time used for subsequent tile fetches. Does not itself trigger
   * a refetch — see `reloadData()`.
   * @param {Date} time
   */
  setTime (time) {
    this._time = time
  }

  /**
   * Updates the fetch time and forces a full reload of every currently-needed
   * tile, discarding whatever is cached — its content is now stale, unlike
   * `refresh()`'s viewport catch-up, which deliberately keeps already-loaded
   * tiles since their content is still valid. Called by `UrlStrategy` on a
   * global time change.
   * @param {Date} time
   * @returns {Promise<void>}
   */
  reloadData (time) {
    this.setTime(time)
    for (const controller of this._pending.values()) controller.abort()
    this._pending.clear()
    if (this._gl) {
      for (const tile of this._tiles.values()) this._freeTile(this._gl, tile)
    }
    this._tiles.clear()
    return this._refreshTiles()
  }

  /**
   * Computes the target zoom + covering tile set for the current viewport,
   * kicks off fetches for newly-needed tiles, and — only once that whole
   * batch has settled — evicts (frees GPU buffers for) tiles no longer
   * covering the (freshly recomputed) viewport. Bound to `moveend` in
   * `onAdd()`.
   *
   * Eviction is deliberately NOT done up front: old tiles (including every
   * tile from a previous zoom level, since there's no pyramid to reuse
   * across zooms) are left rendering untouched while the new ones load, so
   * a zoom/pan never shows a blank gap — see the file header's "Zoom-change
   * eviction is deferred" section for why, and the `_requestId` guard
   * against a rapid pan/zoom sequence racing itself.
   */
  async _refreshTiles () {
    if (!this._provider || !this._map || !this._gl) return

    const requestId = ++this._requestId

    const z = Math.min(this._maxzoom, Math.max(this._minzoom, Math.round(this._map.getZoom())))
    const bounds = this._map.getBounds()

    const { x: xMin, y: yMin } = lngLatToTile(bounds.getWest(), bounds.getNorth(), z)
    const { x: xMax, y: yMax } = lngLatToTile(bounds.getEast(), bounds.getSouth(), z)

    const wantedKeys = new Set()
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        wantedKeys.add(`${z}/${x}/${y}`)
      }
    }

    // Abort in-flight fetches for tiles that fell out of the wanted set —
    // no point letting them finish — but do NOT touch already-loaded tiles
    // here; those are evicted below, only after the new batch is ready.
    for (const [key, controller] of this._pending) {
      if (!wantedKeys.has(key)) {
        controller.abort()
        this._pending.delete(key)
      }
    }

    const fetches = []
    for (const key of wantedKeys) {
      if (this._tiles.has(key) || this._pending.has(key)) continue
      const [zStr, xStr, yStr] = key.split('/')
      fetches.push(this._fetchTile(key, Number(zStr), Number(xStr), Number(yStr)))
    }
    // `_fetchTile()` catches its own errors/aborts and never rejects, so
    // `Promise.all` always resolves once every fetch in this batch is done
    // (successfully or not) — nothing here gets stuck waiting on a reject.
    if (fetches.length > 0) await Promise.all(fetches)

    // A newer _refreshTiles() call started (and will do its own eviction
    // pass) while this one was awaiting its fetches — bail out instead of
    // evicting against this call's now-stale `wantedKeys`.
    if (requestId !== this._requestId) return

    let evicted = false
    for (const [key, tile] of this._tiles) {
      if (!wantedKeys.has(key)) {
        this._freeTile(this._gl, tile)
        this._tiles.delete(key)
        evicted = true
      }
    }
    if (evicted) this._map?.triggerRepaint()
  }

  /**
   * Fetches and uploads one tile. Tracked in `this._pending` for the
   * duration of the request so a rapid pan can abort it if the tile falls
   * out of view again before the response arrives.
   * @param {string} key `"z/x/y"`
   * @param {number} z
   * @param {number} x
   * @param {number} y
   */
  async _fetchTile (key, z, x, y) {
    const controller = new AbortController()
    this._pending.set(key, controller)

    const { lonMin, lonMax, latMin, latMax } = tileToBBox(z, x, y)
    const options = {
      longitude: { min: lonMin, max: lonMax },
      latitude: { min: latMin, max: latMax }
    }
    // Same footgun as the other two gridded-field renderings: KazarrProvider.get()
    // merges `{ ...definition.kazarr, ...options }`, so an explicit
    // `variable: undefined` here would still win over a `definition.kazarr.variable`
    // default — only include it when actually configured.
    if (this._variable) options.variable = this._variable
    if (this._time) options.time = this._time

    try {
      const response = await this._provider.get(options, { signal: controller.signal })
      if (!this._pending.has(key)) return // evicted while in flight
      this._uploadTile(key, response)
    } catch (e) {
      if (e?.name !== 'AbortError') {
        console.error(`[GriddedFieldTiledMeshLayer] "${this.id}": tile ${key} fetch failed.`, e)
      }
    } finally {
      this._pending.delete(key)
    }
  }

  /**
   * @param {string} key `"z/x/y"`
   * @param {{ vertices: number[], indices: number[], values: (number|null)[] }} response
   */
  _uploadTile (key, response) {
    const parsed = meshResponseToTypedArrays(response, this._useUint32Indices)
    if (!parsed) {
      console.error(`[GriddedFieldTiledMeshLayer] "${this.id}": unexpected Kazarr mesh response for tile ${key} (missing vertices/indices/values).`, response)
      return
    }
    const { positions, values, indices, min, max } = parsed

    const gl = this._gl
    const vertexBuffer = gl.createBuffer()
    const indexBuffer = gl.createBuffer()
    const valueBuffer = gl.createBuffer()

    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)

    gl.bindBuffer(gl.ARRAY_BUFFER, valueBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW)

    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)

    this._tiles.set(key, {
      vertexBuffer,
      indexBuffer,
      valueBuffer,
      indexCount: indices.length,
      domain: Number.isFinite(min) && Number.isFinite(max) ? [min, max] : null
    })

    this._map?.triggerRepaint()
  }

  /**
   * @param {WebGLRenderingContext} gl
   * @param {TileEntry} tile
   */
  _freeTile (gl, tile) {
    gl.deleteBuffer(tile.vertexBuffer)
    gl.deleteBuffer(tile.indexBuffer)
    gl.deleteBuffer(tile.valueBuffer)
  }
}
