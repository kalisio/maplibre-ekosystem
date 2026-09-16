/**
 * @file StateManager.js
 * @description Engine-wide state manager of the cartographic engine.
 *
 * Responsibilities (deliberately narrow):
 * - Store the current global time
 * - Store the application default style
 * - Track the current 2D/3D render mode
 *
 * Everything related to individual layers — the layer registry, business
 * sub-filters, combined MapLibre GL filter composition — is owned by
 * `LayerManager` and the layer adapters themselves (see `LayerAdapter`,
 * `FilterStrategy`). StateManager only holds state that is global to the
 * engine, not tied to any single layer.
 */

export class StateManager {
  /**
   * Current global time of the engine.
   * @type {Date | null}
   */
  _currentTime = null

  /**
   * Application default style.
   * @type {Object}
   */
  _appDefaultStyle = {}

  /**
   * Whether the engine is currently rendering in 2D (vs 3D).
   * @type {boolean}
   */
  _is2DMode = true

  // ── Time Management ───────────────────────────────────────────────────────

  /**
   * Updates the global time of the engine.
   * @param {Date} time - new temporal instant
   */
  setTime (time) {
    this._currentTime = time
  }

  /**
   * Returns the current global time.
   * @returns {Date | null}
   */
  getTime () {
    return this._currentTime
  }

  // ── Style Management ──────────────────────────────────────────────────────

  /**
   * Sets the application default style.
   * @param {Object} style - business or MapLibre GL style object
   */
  setAppDefaultStyle (style) {
    this._appDefaultStyle = style
  }

  /**
   * Returns the application default style.
   * @returns {Object}
   */
  getAppDefaultStyle () {
    return this._appDefaultStyle
  }

  // ── 2D/3D Mode Management ─────────────────────────────────────────────────

  /**
   * @returns {boolean} `true` if the engine currently renders in 2D.
   */
  isRenderMode2D () {
    return this._is2DMode
  }

  /**
   * @param {boolean} is2D
   */
  setRenderMode (is2D) {
    this._is2DMode = is2D
  }
}
