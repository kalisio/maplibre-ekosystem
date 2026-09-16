/**
 * @file InternalEvents.js
 * @description Names of the internal events exchanged over the native
 * MapLibre event bus (`map.fire()` / `map.on()`) between engine subsystems.
 *
 * These are NOT part of the public API exposed to VueJS — that contract is
 * `EventBus`, owned by `MapEngine` (see `@kalisio/maplibre-core`). This bus
 * is for many-to-many communication *inside* the engine, between actors
 * that already hold a reference to `map` (adapters, managers) and would
 * otherwise need a direct reference to each other just to react to one
 * event.
 *
 * Centralizing the names here avoids silent typos between an emitter and a
 * listener: `map.on('a-typo', fn)` never throws, it just subscribes to
 * nothing.
 */
export const INTERNAL_EVENTS = {
  /** Fired by MapEngine when the 2D/3D render mode changes. Payload: `{ mode: '2D' | '3D' }`. */
  RENDER_MODE_CHANGED: 'internal:render-mode:changed',

  /** Fired by a LayerAdapter after its provider data has been (re)loaded. Payload: `{ layerId: string }`. */
  LAYER_DATA_UPDATED: 'internal:layer:data:updated'
}
