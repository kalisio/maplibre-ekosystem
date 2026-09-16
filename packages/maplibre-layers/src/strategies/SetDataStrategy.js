/**
 * Temporal strategy by data reloading.
 *
 * Used for **point-cloud** and **mesh** layers, and for **`kazarr://`
 * vector** layers (see `LayerAdapter._resolveTemporalStrategy()`) — cases
 * where data varies over time and must be reloaded from the network rather
 * than filtered client-side.
 *
 * Mechanism: invokes the provider for the new temporal slice via
 * `layer.reloadData({ time })`, which pushes the result to the adapter's
 * source (`getSource().setData()`).
 */
export class SetDataStrategy {
  /**
   * @param {import('../adapters/LayerAdapter.js').LayerAdapter} layer
   * @param {Date} time
   * @returns {Promise<void>}
   */
  async apply (layer, time) {
    if (!layer || !time) {
      console.warn('[SetDataStrategy] Invalid parameters provided.')
      return
    }

    await layer.reloadData({ time })
  }
}
