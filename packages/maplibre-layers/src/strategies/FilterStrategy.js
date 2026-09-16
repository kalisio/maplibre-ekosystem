import { LAYER_ID_SEPARATOR } from '../adapters/LayerAdapter.js'

/**
 * Temporal strategy by GPU filter.
 *
 * Used for **GeoJSON** layers where all data is already loaded
 * into MapLibre. No network request is performed.
 *
 * Mechanism: `map.setFilter(layerId, combinedFilter)` for every MapLibre
 * sub-layer belonging to `layer`, combining that sub-layer's own intrinsic
 * filter (geometry type / business sub-filter, set as `metadata.intrinsicFilter`
 * by `VectorLayerAdapter`) with the temporal window derived from
 * `layer._definition.temporal` and the given `time`.
 *
 * Note: this reads `layer._filters` directly (the business sub-filter state
 * already lives on the layer adapter, via `setFilterActive()`) — there is no
 * separate filter registry to consult.
 */
export class FilterStrategy {
  /**
   * @param {import('../adapters/LayerAdapter.js').LayerAdapter} layer
   * @param {Date} time
   * @returns {Promise<void>}
   */
  async apply (layer, time) {
    const map = layer._map
    const layerId = layer._id
    const temporalConfig = layer._definition?.temporal

    // ── Temporal window, e.g. ['all', ['>=', ['get', field], t], ['<', ['get', field], t + step]] ──
    let temporalFilter = null
    if (time && temporalConfig?.field) {
      const timeMs = time.getTime()
      const stepMs = temporalConfig.step ?? 0
      temporalFilter = [
        'all',
        ['>=', ['get', temporalConfig.field], timeMs],
        ['<', ['get', temporalConfig.field], timeMs + stepMs]
      ]
    }

    const style = map.getStyle()
    if (!style?.layers) return

    for (const styleLayer of style.layers) {
      if (styleLayer.id !== layerId && !styleLayer.id.startsWith(`${layerId}${LAYER_ID_SEPARATOR}`)) {
        continue
      }

      const mlLayer = map.getLayer(styleLayer.id)
      if (!mlLayer) continue

      const meta = mlLayer.metadata
      const intrinsic = meta?.intrinsicFilter
      const filterId = meta?.filterId

      let isActive = true
      if (filterId && layer._filters) {
        const filter = layer._filters.find((f) => f.id === filterId)
        if (filter) isActive = filter.active !== false
      }

      if (!isActive) {
        map.setFilter(styleLayer.id, ['has', '__hidden__']) // Hide the layer completely
        continue
      }

      if (intrinsic && temporalFilter) {
        map.setFilter(styleLayer.id, ['all', intrinsic, temporalFilter])
      } else if (intrinsic) {
        map.setFilter(styleLayer.id, intrinsic)
      } else if (temporalFilter) {
        map.setFilter(styleLayer.id, temporalFilter)
      } else {
        map.setFilter(styleLayer.id, null)
      }
    }
  }
}
