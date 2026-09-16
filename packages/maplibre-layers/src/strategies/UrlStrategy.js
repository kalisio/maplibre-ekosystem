/**
 * Temporal strategy by request URL.
 *
 * Used for **raster** and **WMS** layers whose tiles are served dynamically
 * with a temporal parameter in the URL, and for the three Kazarr
 * gridded-field renderings (`'raster'`, `'mesh'`, `'tiled-mesh'` with a
 * `kazarr://` url — see `LayerAdapter.isKazarrGriddedField()`), whose
 * requests likewise carry `time` as a parameter, just not always via a
 * literal MapLibre tile URL.
 *
 * Mechanism: for a plain raster/WMS layer, reconstructs the tile URL from
 * `definition.temporal.urlTemplate` and updates the MapLibre source via
 * `source.setTiles()`; MapLibre handles the cross-fade between the old and
 * new image automatically. For a Kazarr gridded field, no `urlTemplate` is
 * required — this delegates to the adapter's own `reloadUrlData(time)`
 * instead, since each of the three renderings fetches its data differently
 * (a real tile URL for `'raster'`, a direct provider call for `'mesh'`/
 * `'tiled-mesh'`) and knows how to refetch itself.
 */
export class UrlStrategy {
  /**
   * @param {import('../adapters/LayerAdapter.js').LayerAdapter} layer
   * @param {Date} time
   * @returns {Promise<void>}
   */
  async apply (layer, time) {
    const definition = layer._definition
    const protocol = definition.url ? new URL(definition.url).protocol.replace(':', '') : null

    if (protocol === 'kazarr') {
      // Kazarr's own requests already carry `time` — reloading here just
      // means asking the adapter to refetch for the new time, however this
      // rendering fetches its data.
      return layer.reloadUrlData?.(time)
    }

    if (!definition?.temporal?.urlTemplate) {
      console.warn(`[UrlStrategy] Layer "${layer._id}" has no urlTemplate configured. Skipping.`)
      return
    }

    // Construct the new URL by substituting the {time} placeholder
    const isoTime = time.toISOString()
    const newUrl = definition.temporal.urlTemplate.replace('{time}', isoTime)

    // Update the raster source — MapLibre automatically handles the cross-fade
    const source = layer._map.getSource(layer._id)
    if (source && 'setTiles' in source) {
      source.setTiles([newUrl])
    }
  }
}
