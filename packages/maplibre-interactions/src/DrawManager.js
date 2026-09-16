/**
 * @file DrawManager.js
 * @description Encapsulation of `terra-draw` for interactive geometric drawing.
 *
 * DrawManager exposes an abstract geometric drawing API that completely
 * hides the terra-draw library from the VueJS application. The application
 * only knows business concepts: `setTool('polygon')`, `stopDrawing()`,
 * and receives `GeoJSON.Feature` objects via `'draw:feature'` events.
 *
 * terra-draw is designed to be rendering engine agnostic.
 * Integration with MapLibre is done via `TerraDrawMapLibreGLAdapter`.
 *
 * @todo NOT WIRED UP YET. The actual terra-draw instantiation, mode list and
 * `finish` handler are present but commented out in `initialize()`/`setTool()`/
 * `stopDrawing()`. As things stand, `setTool()` only records the active tool
 * name and emits `'draw:start'` — nothing is drawn on the map, and
 * `getFeatures()`/`'draw:feature'` never produce anything since
 * `_drawnFeatures` is never actually populated.
 */

// ─────────────────────────────────────────────────────────────────────────────
// DrawManager
// ─────────────────────────────────────────────────────────────────────────────

export class DrawManager {
  /**
   * terra-draw instance.
   * Null until `initialize()` is called.
   */
  _draw = null

  /**
   * Name of the active drawing tool.
   * `null` if no tool is active.
   */
  _activeTool = null

  /**
   * Shared event bus to emit drawing events.
   */
  _eventBus

  /**
   * Cache of geometries drawn during the current session.
   */
  _drawnFeatures = []

  /**
   * @param {import('../../../packages/maplibre-core/src/EventBus.js').EventBus} eventBus - shared event bus of the engine
   */
  constructor (eventBus) {
    this._eventBus = eventBus
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Attaches terra-draw to the MapLibre instance and configures internal listeners.
   * Must be called after the MapLibre map's `'load'` event.
   *
   * @todo Currently a no-op (logs only) — the terra-draw wiring is commented
   * out below, so `_draw` never actually gets set. See the `@todo` on the
   * class doc above.
   * @param {import('maplibre-gl').Map} map - internal `maplibregl.Map` instance
   */
  initialize (map) {
    // import { TerraDraw, TerraDrawMapLibreGLAdapter } from 'terra-draw';
    // import { TerraDrawPolygonMode, TerraDrawLineStringMode, ... } from 'terra-draw';
    //
    // this._draw = new TerraDraw({
    //   adapter: new TerraDrawMapLibreGLAdapter({ map }),
    //   modes: [
    //     new TerraDrawPolygonMode(),
    //     new TerraDrawLineStringMode(),
    //     new TerraDrawPointMode(),
    //     new TerraDrawRectangleMode(),
    //     new TerraDrawCircleMode(),
    //     new TerraDrawFreehandMode(),
    //     new TerraDrawSelectMode(),
    //   ],
    // });
    //
    // this._draw.on('finish', (id, context) => {
    //   const features = this._draw.getSnapshot();
    //   const feature = features.find(f => f.id === id);
    //   if (feature) {
    //     this._drawnFeatures.push(feature);
    //     this._eventBus.emit('draw:feature', { feature });
    //   }
    // });
    //
    // this._draw.start();

    console.info('[DrawManager] terra-draw initialized on MapLibre instance.')
  }

  // ── Drawing API ────────────────────────────────────────────────────────────

  /**
   * Activates a geometric drawing tool.
   * If a tool was already active, it is replaced.
   *
   * @param {string} toolName - name of the tool to activate ('point'|'linestring'|'polygon'|'rectangle'|'circle'|'freehand'|'select'|'static')
   * @param {Object} [options] - visual options of the tool (colors, stroke, etc.)
   * @emits `'draw:start'` via EventBus
   */
  setTool (toolName, options) {
    if (!this._draw) {
      console.warn('[DrawManager] Not initialized. Call initialize() first.')
      return
    }

    this._activeTool = toolName
    this._applyToolOptions(options)

    // this._draw.setMode(toolName);

    this._eventBus.emit('draw:start', { tool: toolName })
  }

  /**
   * Deactivates the active drawing mode.
   * Retains the drawn geometries accessible via `getFeatures()`.
   *
   * @emits `'draw:stop'` via EventBus with the geometries of the session
   */
  stopDrawing () {
    if (!this._draw || !this._activeTool) return

    // this._draw.setMode('static');

    this._eventBus.emit('draw:stop', { features: this._drawnFeatures })
    this._activeTool = null
  }

  /**
   * Returns all geometries drawn during the current session.
   * @todo Always returns an empty array today — `_drawnFeatures` is never
   * populated since the terra-draw `'finish'` handler is commented out.
   * @returns {Object[]} Array of drawn GeoJSON Features
   */
  getFeatures () {
    // In production: this._draw.getSnapshot()
    return [...this._drawnFeatures]
  }

  /**
   * Clears all drawn geometries.
   */
  clearFeatures () {
    this._drawnFeatures = []
    // this._draw.clear();
  }

  /**
   * Returns the name of the active drawing tool, or `null` if inactive.
   * @returns {string | null}
   */
  getActiveTool () {
    return this._activeTool
  }

  // ── Lifecycle (destroy) ────────────────────────────────────────────────────

  /**
   * Releases terra-draw resources.
   * Called by `MapEngine.destroy()`.
   */
  destroy () {
    if (this._draw) {
      // this._draw.stop();
      this._draw = null
    }
    this._drawnFeatures = []
    this._activeTool = null
  }

  // ── Private Methods ────────────────────────────────────────────────────────

  /**
   * Applies visual options to the active drawing tool.
   * @param {Object} [options] - visual options
   */
  _applyToolOptions (options) {
    // if (!options) return
    // TODO: map options to terra-draw style properties
  }
}
