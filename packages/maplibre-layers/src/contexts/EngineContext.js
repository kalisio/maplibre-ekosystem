/**
 * @file EngineContext.js
 * @description Narrow, read-only view of the engine state that `LayerManager`
 * actually needs.
 *
 * `MapEngine` never hands its `StateManager` instance directly to
 * `LayerManager` — `StateManager` also exposes `setTime()`,
 * `setAppDefaultStyle()`, `setRenderMode()`, none of which `LayerManager`
 * should be able to call. `EngineContext` wraps it down to the three getters
 * `LayerManager` is actually built around.
 */
export class EngineContext {
  _stateManager

  /**
   * @param {{ isRenderMode2D: () => boolean, getTime: () => Date | null, getAppDefaultStyle: () => Object }} stateManager
   */
  constructor (stateManager) {
    this._stateManager = stateManager
  }

  /** @returns {boolean} */
  isRenderMode2D () {
    return this._stateManager.isRenderMode2D()
  }

  /** @returns {Date | null} */
  getTime () {
    return this._stateManager.getTime()
  }

  /** @returns {Object} */
  getAppDefaultStyle () {
    return this._stateManager.getAppDefaultStyle()
  }
}
