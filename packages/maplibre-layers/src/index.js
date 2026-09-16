/**
 * @file index.js
 * @description Public entry point of the maplibre-layers package.
 *
 * Only `LayerManager` and the small wiring types `MapEngine` needs to build
 * it correctly (`EngineContext`, `INTERNAL_EVENTS`) are exported. Everything
 * else — `Layer`, `LayerAdapter` and its subclasses, `LayerFactory`,
 * `AdapterContext`, `ThreeJsSceneManager`, `DeckGlManager`, the providers and
 * strategies — is an internal implementation detail orchestrated by
 * `LayerManager` itself.
 */

export { LayerManager } from './LayerManager.js'
export { EngineContext } from './contexts/EngineContext.js'
export { INTERNAL_EVENTS } from './InternalEvents.js'
