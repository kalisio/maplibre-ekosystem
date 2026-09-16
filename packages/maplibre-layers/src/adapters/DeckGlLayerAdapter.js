/**
 * @file DeckGlLayerAdapter.js
 * @description `LayerAdapter` for `'mesh'` and `'point-cloud'` layer types,
 * rendered via deck.gl through the shared `DeckGlManager`. `'mesh'` renders
 * a raw indexed, explicitly user-supplied `{ vertices, indices, values }`
 * mesh via `SimpleMeshLayer` (see `_createMeshLayer()`); `'point-cloud'`
 * renders 3D Tiles or LAS/LAZ point clouds via `Tile3DLayer`/`PointCloudLayer`
 * (see `_createPointCloudLayer()`).
 *
 * `LayerFactory.createLayer()` only routes a `'mesh'` definition here when
 * `definition.url` does NOT use the `kazarr://` protocol — a `kazarr://`
 * `'mesh'` is a gridded scalar field (e.g. AROME/ARPEGE) instead, routed to
 * `MapLibreLayerAdapter._addGriddedFieldMeshLayer()`/`GriddedFieldMeshLayer.js`
 * (2D, MapLibre-native, data fetched per viewport from Kazarr) — a
 * different feature entirely from this file's single, explicit, statically-
 * supplied mesh.
 *
 * @todo Does not override `getBounds()` or `getSource()` — both fall back to
 * `LayerAdapter`'s base implementation, which throws
 * `"... must be implemented by subclasses"`. `MapEngine.flyToLayer()` and
 * any temporal strategy relying on `getSource()` will throw for these layer
 * types today.
 */
import { LayerAdapter } from './LayerAdapter.js'
import { Tile3DLayer } from '@deck.gl/geo-layers'
import { PointCloudLayer } from '@deck.gl/layers'
import { SimpleMeshLayer } from '@deck.gl/mesh-layers'
import { COORDINATE_SYSTEM } from '@deck.gl/core'
import { LASLoader } from '@loaders.gl/las'

/**
 * Default diverging color ramp (blue -> white -> red) used to map a raw
 * mesh's per-vertex scalar `values` to colors when the definition doesn't
 * supply its own `colorRange`.
 * @type {string[]}
 */
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
 * Maps one scalar per vertex to a flat RGBA buffer (4 bytes/vertex),
 * linearly interpolating across `colorRange` (2+ hex colors) after
 * normalizing each value against `domain`.
 * @param {number[]} values one scalar per vertex
 * @param {string[]} [colorRange] hex colors, low -> high; defaults to `DEFAULT_COLOR_RANGE`
 * @param {[number, number]} [domain] `[min, max]`; defaults to `values`' own min/max
 * @returns {Uint8Array}
 */
const valuesToVertexColors = (values, colorRange = DEFAULT_COLOR_RANGE, domain) => {
  const stops = colorRange.map(hexToRgb)
  const [min, max] = domain ?? [Math.min(...values), Math.max(...values)]
  const span = max - min || 1

  const colors = new Uint8Array(values.length * 4)
  values.forEach((v, i) => {
    const t = Math.min(1, Math.max(0, (v - min) / span))
    const segment = t * (stops.length - 1)
    const idx = Math.min(stops.length - 2, Math.floor(segment))
    const localT = segment - idx
    const [r0, g0, b0] = stops[idx]
    const [r1, g1, b1] = stops[idx + 1]
    colors[i * 4] = r0 + (r1 - r0) * localT
    colors[i * 4 + 1] = g0 + (g1 - g0) * localT
    colors[i * 4 + 2] = b0 + (b1 - b0) * localT
    colors[i * 4 + 3] = 255
  })
  return colors
}

export class DeckGlLayerAdapter extends LayerAdapter {
  /**
   * Builds the deck.gl layer instance for `definition.type` (`'mesh'` via
   * `_createMeshLayer()`, `'point-cloud'` via `_createPointCloudLayer()`)
   * and registers it on the shared `DeckGlManager`.
   */
  _initialize () {
    const type = this._definition.type

    // Create the actual deck.gl layer based on type
    let deckLayer
    if (type === 'mesh') {
      deckLayer = this._createMeshLayer(this._definition)
    } else if (type === 'point-cloud') {
      deckLayer = this._createPointCloudLayer(this._definition)
    } else {
      console.error(`[DeckGlLayerAdapter] Unsupported layer type: "${type}"`)
      return
    }

    this._context.getDeckGlManager().setLayer(this._id, deckLayer)
  }

  /**
   * @param {boolean} visible
   */
  setVisibility (visible) {
    this._context.getDeckGlManager().setLayerVisibility(this._id, visible)
  }

  /**
   * Unregisters this layer from the shared `DeckGlManager`. Previously this
   * only cleared a single static `_deckLayer` field shared by every
   * `MapEngine` instance in the process — see `DeckGlManager` for why.
   */
  destroy () {
    this._context.getDeckGlManager().removeLayer(this._id)
  }

  /**
   * Builds a `SimpleMeshLayer` (`@deck.gl/mesh-layers`) from a raw indexed
   * mesh — `definition.mesh = { vertices, indices, values? }` — rendered as
   * a single static mesh. deck.gl has no lower-level "just draw this
   * triangle mesh once" layer, so this uses `SimpleMeshLayer` with exactly
   * one instance (`data: [{}]`) rather than its usual per-instance-repeated
   * geometry mode.
   *
   * `vertices` is a flat `[x, y, z, x, y, z, ...]` array (or an array of
   * `[x, y, z]` triplets) in local space, positioned relative to
   * `definition.coordinateOrigin` (`[lon, lat, altitude]`) — meter offsets
   * by default, see `definition.coordinateSystem` to change that (same
   * convention as `_createPointCloudLayer()`'s LAS branch). `indices` is a
   * flat triangle index array. `values`, if given, is one scalar per
   * vertex, mapped to a per-vertex color via `valuesToVertexColors()`
   * (`definition.colorRange`/`definition.domain` to customize the ramp);
   * omit it for a flat white mesh.
   *
   * `material: false` disables `SimpleMeshLayer`'s default Phong shading —
   * for a scalar-field visualization the per-vertex colors already *are*
   * the data, so directional lighting would just distort them.
   *
   * @todo No `NORMAL` attribute is computed, so the mesh has no lighting
   * information even if `material` is re-enabled later — fine for the
   * flat-colormap case above, but would need per-vertex normals computed
   * (mirroring `ThreeJsLayerAdapter.createPolygon()`'s
   * `computeVertexNormals()`) if shaded rendering is ever wanted.
   * @param {Object} definition
   * @returns {SimpleMeshLayer}
   */
  _createMeshLayer (definition) {
    const { vertices, indices, values } = definition.mesh
    const positions = Float32Array.from(vertices.flat ? vertices.flat() : vertices)

    const colors = values
      ? valuesToVertexColors(values, definition.colorRange, definition.domain)
      : new Uint8Array((positions.length / 3) * 4).fill(255)

    const mesh = {
      attributes: {
        POSITION: { value: positions, size: 3 },
        COLOR: { value: colors, size: 4, normalized: true }
      },
      indices: { value: Uint32Array.from(indices), size: 1 }
    }

    return new SimpleMeshLayer({
      id: definition.id,
      data: [{}],
      mesh,
      coordinateOrigin: definition.coordinateOrigin ?? [0, 0, 0],
      coordinateSystem: definition.coordinateSystem ?? COORDINATE_SYSTEM.METER_OFFSETS,
      getPosition: () => [0, 0, 0],
      getColor: [255, 255, 255, 255], // multiplied with the mesh's own per-vertex COLOR — kept neutral
      material: false
    })
  }

  /**
   * Builds a `Tile3DLayer` (`@deck.gl/geo-layers`) pointing at
   * `definition.url` (a 3D Tiles tileset JSON).
   * @param {Object} definition
   * @returns {Tile3DLayer}
   */
  _createPointCloudLayer (definition) {
    const format = definition.format || '3d-tiles'
    if (format === '3d-tiles') {
      return new Tile3DLayer({
        id: definition.id,
        data: definition.url,
        pointSize: 2
      })
    } else if (format === 'las') {
      return new PointCloudLayer({
        id: definition.id,
        data: definition.url,
        loaders: [LASLoader],
        // `LASLoader` parses in a Web Worker by default. Inside that worker,
        // a relative `definition.url` is resolved against the worker
        // script's own location (deep in node_modules), not the page's URL —
        // a classic loaders.gl footgun that silently fails the worker's own
        // fetch of the file, which is what produces the parser-side
        // "Failed to open file: undefined" error (the worker never actually
        // received the file's bytes). Forcing main-thread parsing sidesteps
        // that URL-resolution issue entirely; it also gives a clearer stack
        // trace if the real problem turns out to be something else (e.g. the
        // file genuinely 404ing).
        loadOptions: { core: { worker: false } },
        pointSize: 2
      })
    }
  }
}
