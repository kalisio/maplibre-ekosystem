/**
 * @file EventBus.js
 * @description Internal, typed and decoupled event bus.
 * Used for asynchronous communication between the internal components
 * of the engine (StateManager, LayerManager, DrawManager, etc.) without creating
 * direct dependencies between them.
 *
 * This bus is INTERNAL to the library. Public events bubble up
 * to VueJS via the `on()`/`off()` methods of `MapEngine`, which rely
 * on this bus.
 */

export class EventBus {
  /**
   * Internal registry of listeners, indexed by event type.
   * Uses a plain object for O(1) access performance.
   * @type {Record<string, Function[]>}
   */
  _listeners = {}

  // ── Subscription API ───────────────────────────────────────────────────────

  /**
   * Subscribes a callback to an event type.
   *
   * @param {string} event - event type to listen to
   * @param {Function} callback - function called on each emission
   *
   * @example
   * bus.on('layer:added', (e) => console.log(e.layerId));
   */
  on (event, callback) {
    if (!this._listeners[event]) {
      this._listeners[event] = []
    }
    this._listeners[event].push(callback)
  }

  /**
   * Unsubscribes a callback from an event type.
   * If the callback is not found, the operation is silent.
   *
   * @param {string} event - event type
   * @param {Function} callback - exact reference of the callback to remove
   */
  off (event, callback) {
    const listeners = this._listeners[event]
    if (!listeners) return

    const index = listeners.indexOf(callback)
    if (index !== -1) {
      listeners.splice(index, 1)
    }
  }

  /**
   * Unsubscribes all listeners of a specific event type.
   * @param {string} event - event type to clear
   */
  offAll (event) {
    delete this._listeners[event]
  }

  // ── Event Emission ─────────────────────────────────────────────────────────

  /**
   * Emits an event and notifies all subscribed listeners.
   * Automatically enriches the payload with the emission `timestamp`.
   *
   * Listeners are called synchronously in their subscription order.
   * Errors thrown in a listener are captured and logged so as not to
   * interrupt the notification chain.
   *
   * @param {string} event - event type
   * @param {Object} [data] - event payload (without `type` or `timestamp`, added automatically)
   *
   * @example
   * bus.emit('layer:added', { layerId: 'wind', layerType: 'point-cloud' });
   */
  emit (event, data) {
    const payload = {
      type: event,
      timestamp: Date.now(),
      ...data
    }

    const listeners = this._listeners[event]
    if (!listeners || listeners.length === 0) return

    // Defensive copy: avoids array mutations during iteration
    const snapshot = [...listeners]
    for (const listener of snapshot) {
      try {
        listener(payload)
      } catch (error) {
        // A failing listener should not block subsequent ones
        console.error(`[EventBus] Error in listener for event "${event}":`, error)
      }
    }
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  /**
   * Returns the count of active listeners for an event type.
   * Useful for debugging and testing.
   * @param {string} event
   * @returns {number}
   */
  listenerCount (event) {
    return this._listeners[event]?.length ?? 0
  }

  /**
   * Removes all listeners for all events.
   * Called by `MapEngine.destroy()` to ensure memory cleanup.
   */
  destroy () {
    this._listeners = {}
  }
}
