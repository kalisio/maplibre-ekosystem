/**
 * @file NDimensionalMixin.js
 * @description Mixin adding the multi-dimensional (Kazarr-backed) coordinate
 * API — `setLevel()`, `getVariables()`, `getCoordinates()`, `getCoordinate()`
 * — to a `LayerAdapter` subclass. All four methods delegate to `_provider`
 * (expected to be a `KazarrProvider`, the only provider implementing this
 * contract today) and no-op/return empty when there is none.
 *
 * Applied by `LayerFactory` to build `NDimensionalVectorLayerAdapter` and
 * `NDimensionalThreeJsLayerAdapter` for `kazarr://` vector layers.
 * @param {Function} BaseClass - a `LayerAdapter` subclass
 * @returns {Function} a subclass of `BaseClass` with the mixin's methods added
 */
export const NDimensionalMixin = (BaseClass) => class extends BaseClass {
  /**
   * Reloads the layer's data at a new coordinate level (e.g. a vertical/depth
   * level), via `_loadProviderData({ level })`. No-op (with a console
   * warning) if there is no provider.
   * @param {*} level
   */
  setLevel (level) {
    if (!this._provider) {
      console.warn(`[NDimensionalMixin] Cannot set level: provider not found for layer "${this._id}".`)
      return
    }

    this._loadProviderData({ level })
  }

  /**
   * @returns {string[]} the layer's available data variables, or `[]` if there is no provider
   */
  getVariables () {
    if (!this._provider) return []

    return this._provider.getVariables()
  }

  /**
   * @returns {string[]} the layer's available coordinate dimensions, or `[]` if there is no provider
   */
  getCoordinates () {
    if (!this._provider) return []

    return this._provider.getCoordinates()
  }

  /**
   * @param {string} coordinateName
   * @returns {Object | null} the values/metadata of one coordinate dimension, or `null` if there is no provider
   */
  getCoordinate (coordinateName) {
    if (!this._provider) return null

    return this._provider.getCoordinate(coordinateName)
  }
}
