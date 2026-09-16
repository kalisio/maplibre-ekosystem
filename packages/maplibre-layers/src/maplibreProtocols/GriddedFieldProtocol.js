/**
 * @file GriddedFieldProtocol.js
 * @description Registers the `kazarr-field://` MapLibre protocol
 * (`maplibregl.addProtocol()`) used by `MapLibreLayerAdapter._addGriddedFieldLayer()`
 * to render a Kazarr-served gridded scalar field (e.g. a full AROME/ARPEGE
 * model output, `definition.type === 'raster'` with a `kazarr://` url) as
 * native MapLibre raster tiles, computed on demand as MapLibre requests
 * each tile.
 *
 * This is one of THREE renderings for a `kazarr://` gridded field, selected
 * by `definition.type` itself: `'raster'` (this file), `'mesh'` — a single
 * GPU-colored triangle mesh, refetched per viewport instead of per-tile,
 * see `GriddedFieldMeshLayer.js` for that alternative and its trade-offs
 * versus this one — or `'tiled-mesh'`, the same GPU-mesh idea as `'mesh'`
 * but split into a self-managed z/x/y tile cache instead of one whole-
 * viewport mesh, see `GriddedFieldTiledMeshLayer.js`. This file's
 * `tileToBBox()` (now in the shared `tileGrid.js`) is reused by
 * `GriddedFieldTiledMeshLayer.js` for the same deterministic-bbox-per-tile
 * property that makes this raster path's tile requests cacheable.
 * (Unrelated: `DeckGlLayerAdapter._createMeshLayer()` also renders a
 * `'mesh'`, but only for an explicit, user-supplied static mesh with no
 * `kazarr://` url — a different, single-object-with-real-relief use case
 * entirely.)
 *
 * Why raster tiles can still make sense over a mesh: AROME/ARPEGE outputs
 * are already gridded (regular for AROME, a stretched/reduced Gaussian grid
 * for global ARPEGE), not an arbitrary irregular triangulation, and the
 * display is a flat colormap (no relief) — so there's nothing inherently
 * gained from an explicit triangle mesh. Rendering as MapLibre-native
 * raster tiles reuses its battle-tested tiling/culling/zoom pipeline for
 * free. In practice this path shows visible seams between
 * independently-sampled tiles (see `GriddedFieldMeshLayer.js`'s header for
 * the fuller performance/seam trade-off) — prefer `'mesh'` unless there's a
 * specific reason not to.
 *
 * How one tile is produced: MapLibre requests
 * `kazarr-field://<layerId>/{z}/{x}/{y}`. `<layerId>` is looked up in
 * `_registry` (populated by `registerGriddedFieldSource()`, cleared by
 * `unregisterGriddedFieldSource()`) to find that layer's `KazarrProvider`,
 * variable, and color mapping. `z/x/y` is converted to a lon/lat bounding
 * box (`tileToBBox()`), used to call Kazarr's `format=raw` endpoint, which
 * returns:
 *   - `shape`: `[latCount, lonCount]`
 *   - `longitudes` / `latitudes`: FLAT arrays of length `latCount * lonCount`,
 *     one coordinate pair per flattened grid cell, in row-major order (the
 *     `lonCount` distinct longitudes repeat every `lonCount` entries; each
 *     of the `latCount` distinct latitudes holds constant for `lonCount`
 *     consecutive entries)
 *   - `values`: an OBJECT keyed by variable name (e.g. `values.temperature`),
 *     each entry itself a flat array of length `latCount * lonCount`
 *     (`null` where data is missing/out of domain)
 * This is unwrapped into per-axis coordinate arrays (`_axesFromFlatGrid()`)
 * and a flat per-cell value array for the requested variable, then
 * rasterized pixel-by-pixel into the tile via nearest-neighbor sampling and
 * returned as a PNG.
 *
 * @todo Sampling assumes the grid is rectangular — a fixed `lonCount` of
 * distinct longitudes repeated identically for every one of `latCount` rows
 * (true for AROME and for any bbox Kazarr has already resampled to a
 * regular sub-grid). It is NOT true of a raw, un-resampled reduced/stretched
 * Gaussian ARPEGE row (varying point count per latitude band) — if Kazarr
 * ever returns that shape directly, sampling would need to search the
 * nearest lon within each lat row instead of doing direct index math, or
 * Kazarr could be adapted server-side to resample before responding.
 * @todo No cache-busting on time change: once a tile is fetched, MapLibre
 * caches it by URL forever. Switching `variable` is fine today (that
 * rebuilds the whole layer/source), but per-timestep animation would need
 * the tile URL (or the protocol handler's request) to fold the current
 * time in, plus an explicit source reload
 * (`map.style.sourceCaches[id].clearTiles()` + `update()`, or rebuilding
 * the source) when time changes — no such mechanism exists yet.
 * @todo Requires `OffscreenCanvas` (all evergreen browsers support it).
 */
import maplibregl from 'maplibre-gl'
import { tileToBBox } from '../utils/tileGrid.js'

/**
 * @type {Map<string, { provider: import('../providers/KazarrProvider.js').KazarrProvider, variable?: string, colorRange?: string[], domain?: [number, number], tileSize: number }>}
 */
const _registry = new Map()

let _protocolRegistered = false

/**
 * Registers the `kazarr-field://` protocol handler, once per process.
 * Safe to call repeatedly — later calls are no-ops.
 */
export function ensureGriddedFieldProtocol () {
  if (_protocolRegistered) return
  _protocolRegistered = true
  maplibregl.addProtocol('kazarr-field', async (params, abortController) => {
    try {
      return await _handleTileRequest(params.url, abortController?.signal)
    } catch (e) {
      // An aborted tile is expected/routine (MapLibre cancelled it because the
      // viewport moved on before Kazarr responded) — only genuine failures
      // are worth logging as errors.
      if (e?.name !== 'AbortError') {
        console.error('[GriddedFieldProtocol] Tile request failed for', params.url, e)
      }
      throw e
    }
  })
}

/**
 * @param {string} layerId
 * @param {{ provider: import('../providers/KazarrProvider.js').KazarrProvider, variable?: string, colorRange?: string[], domain?: [number, number], tileSize: number }} config
 */
export function registerGriddedFieldSource (layerId, config) {
  _registry.set(layerId, config)
}

/**
 * @param {string} layerId
 */
export function unregisterGriddedFieldSource (layerId) {
  _registry.delete(layerId)
}

/**
 * Index of the entry closest to `value` in a monotonic (ascending or
 * descending) array, via binary search.
 * @param {number[]} arr
 * @param {number} value
 * @returns {number}
 */
function nearestIndex (arr, value) {
  const n = arr.length
  if (n === 1) return 0
  const ascending = arr[n - 1] >= arr[0]
  const at = (i) => (ascending ? arr[i] : -arr[i])
  const v = ascending ? value : -value

  let lo = 0; let hi = n - 1
  if (v <= at(lo)) return lo
  if (v >= at(hi)) return hi
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (at(mid) < v) lo = mid; else hi = mid
  }
  return v - at(lo) <= at(hi) - v ? lo : hi
}

const DEFAULT_COLOR_RANGE = ['#2166ac', '#f7f7f7', '#b2182b']

/**
 * @param {string} hex e.g. `'#2166ac'`
 * @returns {[number, number, number]}
 */
const hexToRgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * @param {number} value
 * @param {string[]} colorRange
 * @param {[number, number]} domain
 * @returns {[number, number, number]}
 */
function valueToColor (value, colorRange, domain) {
  const stops = colorRange.map(hexToRgb)
  const [min, max] = domain
  const span = max - min || 1
  const t = Math.min(1, Math.max(0, (value - min) / span))
  const segment = t * (stops.length - 1)
  const idx = Math.min(stops.length - 2, Math.floor(segment))
  const localT = segment - idx
  const [r0, g0, b0] = stops[idx]
  const [r1, g1, b1] = stops[idx + 1]
  return [r0 + (r1 - r0) * localT, g0 + (g1 - g0) * localT, b0 + (b1 - b0) * localT]
}

/**
 * @param {number[]} values flat array covering every (lat, lon) pair
 * @param {number} latIdx
 * @param {number} lonIdx
 * @param {number} lonCount
 * @returns {number}
 */
function sampleValue (values, latIdx, lonIdx, lonCount) {
  return values[latIdx * lonCount + lonIdx]
}

/**
 * Kazarr's `format=raw` response gives `longitudes`/`latitudes` as FLAT
 * arrays (one coordinate pair per flattened `[latCount, lonCount]` grid
 * cell, row-major), not two independent 1D coordinate axes. This derives
 * the per-axis coordinate arrays `nearestIndex()` needs: the longitude axis
 * is just the first row (`lonCount` entries), and the latitude axis is one
 * entry per row (the value held constant across that row).
 * @param {number[]} longitudes flat, length `latCount * lonCount`
 * @param {number[]} latitudes flat, length `latCount * lonCount`
 * @param {[number, number]} shape `[latCount, lonCount]`
 * @returns {{ lonAxis: number[], latAxis: number[] }}
 */
function _axesFromFlatGrid (longitudes, latitudes, shape) {
  const [latCount, lonCount] = shape
  const lonAxis = longitudes.slice(0, lonCount)
  const latAxis = new Array(latCount)
  for (let i = 0; i < latCount; i++) {
    latAxis[i] = latitudes[i * lonCount]
  }
  return { lonAxis, latAxis }
}

/**
 * @param {string} url `kazarr-field://<layerId>/<z>/<x>/<y>`
 * @param {AbortSignal} [signal] MapLibre's own per-tile abort signal — if the
 * tile is panned/zoomed away from before the Kazarr response arrives,
 * MapLibre aborts it, which is forwarded into `KazarrProvider.get()` so the
 * underlying `fetch()` itself is cancelled (not just the CPU-heavy
 * rasterization/PNG-encode work below it, which is skipped for free since
 * we never reach it — the `await` rejects with an `AbortError` instead).
 * @returns {Promise<{ data: ArrayBuffer }>}
 */
async function _handleTileRequest (url, signal) {
  const match = url.match(/^kazarr-field:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/)
  if (!match) {
    throw new Error(`[GriddedFieldProtocol] Malformed tile URL: ${url}`)
  }
  const [, layerId, zStr, xStr, yStr] = match
  const config = _registry.get(layerId)
  if (!config) {
    throw new Error(`[GriddedFieldProtocol] No gridded field registered for layer "${layerId}" (removed while a tile was in flight?).`)
  }

  const z = Number(zStr); const x = Number(xStr); const y = Number(yStr)
  const { lonMin, lonMax, latMin, latMax } = tileToBBox(z, x, y)

  // `KazarrProvider.get()` merges `{ ...definition.kazarr, ...options }` —
  // an explicit `variable: undefined` key here would still win that merge
  // and silently wipe out a `definition.kazarr.variable` default, so only
  // include it when actually set on this layer's config.
  const options = {
    longitude: { min: lonMin, max: lonMax },
    latitude: { min: latMin, max: latMax }
  }
  if (config.variable) options.variable = config.variable
  // Always resolve the app's current global time at request time (not once
  // at layer-registration time), so long-lived tiles at least request the
  // freshest time available — though switching time later still won't force
  // already-cached tiles to re-fetch (see the file header's @todo).
  const time = config.context?.getGlobalTime?.()
  if (time) options.time = time

  const response = await config.provider.get(options, { signal })
  const { longitudes, latitudes, shape, values: valuesByVariable } = response

  if (!Array.isArray(shape) || shape.length !== 2) {
    throw new Error(`[GriddedFieldProtocol] Unexpected Kazarr response for ${url}: missing/invalid "shape".`)
  }
  const [, lonCount] = shape

  // `values` is an object keyed by variable name (e.g. `{ temperature: [...] }`),
  // not a directly-indexable array — resolve the flat per-cell array for the
  // variable this layer actually wants. Fall back to the only/first key when
  // no `variable` was configured, so a single-variable request still works.
  const variableName = config.variable || Object.keys(valuesByVariable || {})[0]
  const values = valuesByVariable?.[variableName]
  if (!Array.isArray(values)) {
    throw new Error(`[GriddedFieldProtocol] Unexpected Kazarr response for ${url}: no values for variable "${variableName}".`)
  }

  const { lonAxis, latAxis } = _axesFromFlatGrid(longitudes, latitudes, shape)

  const tileSize = config.tileSize
  const colorRange = config.colorRange || DEFAULT_COLOR_RANGE

  let domain = config.domain
  if (!domain) {
    let min = Infinity; let max = -Infinity
    for (let i = 0; i < values.length; i++) {
      const v = values[i]
      if (Number.isFinite(v)) {
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    domain = [min, max]
  }

  const canvas = new OffscreenCanvas(tileSize, tileSize)
  const ctx = canvas.getContext('2d')
  const imageData = ctx.createImageData(tileSize, tileSize)

  for (let py = 0; py < tileSize; py++) {
    const tileLat = latMax - ((py + 0.5) / tileSize) * (latMax - latMin)
    const latIdx = nearestIndex(latAxis, tileLat)
    for (let px = 0; px < tileSize; px++) {
      const tileLon = lonMin + ((px + 0.5) / tileSize) * (lonMax - lonMin)
      const lonIdx = nearestIndex(lonAxis, tileLon)
      const value = sampleValue(values, latIdx, lonIdx, lonCount)

      const i = (py * tileSize + px) * 4
      if (value === null || value === undefined || !Number.isFinite(value)) {
        imageData.data[i + 3] = 0 // no data at this grid cell -> transparent
        continue
      }
      const [r, g, b] = valueToColor(value, colorRange, domain)
      imageData.data[i] = r
      imageData.data[i + 1] = g
      imageData.data[i + 2] = b
      imageData.data[i + 3] = 255 // overall transparency is the layer's own raster-opacity paint property
    }
  }

  ctx.putImageData(imageData, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return { data: await blob.arrayBuffer() }
}
