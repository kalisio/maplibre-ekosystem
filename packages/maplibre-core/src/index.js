/**
 * @file index.js
 * @description Public entry point of the maplibre-core package.
 *
 * This file defines the "API surface" exposed to the VueJS application.
 * Only the elements listed here are importable from the library.
 * Internal subsystems (adapters, providers, internal managers)
 * are NOT exported — they remain private implementation details.
 *
 * @example
 * // In a Vue component or Pinia store
 * import { MapEngine } from '@kalisio/maplibre-core';
 *
 * const engine = new MapEngine(container, { center: [2.35, 48.85] });
 * await engine.addLayer('wind', { type: 'point-cloud', providerType: 'kazarr', ... });
 * engine.on('layer:added', (e) => console.log('Layer added:', e.layerId));
 */

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT 1 — Main Class (instantiable by VueJS)
// ─────────────────────────────────────────────────────────────────────────────

export { MapEngine } from './MapEngine.js'

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT 2 — Style utilities (allow VueJS to pre-validate a style before addLayer)
// ─────────────────────────────────────────────────────────────────────────────

// export { parseStyle, isMapLibreStyle, parseKDKStyle, generateFiltersFromStyle } from '@kalisio/maplibre-utils';

// ─────────────────────────────────────────────────────────────────────────────
// NOTE TO DEVELOPERS
// ─────────────────────────────────────────────────────────────────────────────
//
// The following elements are INTENTIONALLY NOT exported:
//
// ❌ LayerAdapter, MapLibreLayerAdapter, VectorLayerAdapter,
//    ThreeJsLayerAdapter, DeckGlLayerAdapter — internal implementation detail
// ❌ ThreeJsSceneManager, DeckGlManager — internal implementation detail
// ❌ KazarrProvider         — automatically instantiated by LayerManager
// ❌ KmlProvider            — automatically instantiated by LayerManager
// ❌ LayerManager           — orchestrated by MapEngine
// ❌ EngineContext, AdapterContext, INTERNAL_EVENTS — internal wiring
// ❌ StateManager           — orchestrated by MapEngine
// ❌ EventBus               — orchestrated by MapEngine
// ❌ DrawManager            — accessible via engine.setDrawTool() / engine.stopDrawing()
// ❌ SelectManager          — accessible via engine.on('select:changed', ...)
// ❌ PopupManager           — accessible via engine.on('popup:open', ...)
