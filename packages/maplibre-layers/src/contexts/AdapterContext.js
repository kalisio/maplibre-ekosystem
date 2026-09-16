/**
 * @file AdapterContext.js
 * @description Narrow, read-only view of `LayerManager` that a `LayerAdapter`
 * actually needs (a handful of getters — never the registry, ordering
 * methods, factory, or other layers on `LayerManager`'s full surface).
 * Built once per layer by `LayerFactory` and held by the owning `Layer`
 * (see `Layer.js`), which every `LayerAdapter` reads it through.
 */
export class AdapterContext {
  _layerManager

  /**
   * @param {import('../LayerManager.js').LayerManager} layerManager
   */
  constructor (layerManager) {
    this._layerManager = layerManager
  }

  /** @returns {Date} */
  getGlobalTime () {
    return this._layerManager.getGlobalTime()
  }

  /** @returns {Object} */
  getAppDefaultStyle () {
    return this._layerManager.getAppDefaultStyle()
  }

  /** @returns {import('../ThreeJsSceneManager.js').ThreeJsSceneManager} */
  getThreeJsSceneManager () {
    return this._layerManager.getThreeJsSceneManager()
  }

  /** @returns {import('../DeckGlManager.js').DeckGlManager} */
  getDeckGlManager () {
    return this._layerManager.getDeckGlManager()
  }
}
