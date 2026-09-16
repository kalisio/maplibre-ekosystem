/**
 * @file PopupManager.js
 * @description Manager for the MapLibre GL popup lifecycle.
 *
 * Encapsulates MapLibre popups so that VueJS can open, close,
 * and update popups without importing `maplibre-gl` directly.
 */

import { Popup } from 'maplibre-gl'

export class PopupManager {
  /**
   * MapLibre instance.
   */
  _map

  /**
   * Shared event bus.
   */
  _eventBus

  /**
   * Registry of active popups, indexed by business identifier.
   * Enables multi-popup management and updates by ID.
   * @type {Map<string, import('maplibre-gl').Popup>}
   */
  _popups = new Map()

  /**
   * @param {import('maplibre-gl').Map} map - internal `maplibregl.Map` instance
   * @param {import('../../../packages/maplibre-core/src/EventBus.js').EventBus} eventBus - shared event bus of the engine
   */
  constructor (map, eventBus) {
    this._map = map
    this._eventBus = eventBus
  }

  // ── Open ───────────────────────────────────────────────────────────────────

  /**
   * Opens a popup at a geographical position with a given content.
   * If a popup with the same ID already exists, it is closed and replaced.
   *
   * @param {string} id - business identifier of the popup
   * @param {[number, number]} lngLat - geographical position [longitude, latitude]
   * @param {string | HTMLElement} content - HTML content of the popup
   * @param {Object} [options] - configuration options for the popup
   * @emits `'popup:open'` via EventBus
   */
  open (id, lngLat, content, options = {}) {
    // Close existing popup with same ID before opening a new one
    if (this._popups.has(id)) {
      this.close(id)
    }

    const popup = new Popup({
      offset: options.offset,
      closeButton: options.closeButton ?? true,
      closeOnClick: options.closeOnClick ?? true,
      anchor: options.anchor ?? 'bottom',
      className: options.className,
      maxWidth: options.maxWidth ?? '240px'
    })
      .setLngLat(lngLat)
      .addTo(this._map)

    if (content instanceof HTMLElement) {
      popup.setDOMContent(content)
    } else {
      popup.setHTML(content)
    }

    popup.on('close', () => {
      this._popups.delete(id)
      this._eventBus.emit('popup:close', { popupId: id })
    })

    this._popups.set(id, popup)

    this._eventBus.emit('popup:open', { popupId: id, lngLat })
  }

  // ── Close ──────────────────────────────────────────────────────────────────

  /**
   * Closes a popup identified by its ID.
   * Silent operation if the popup does not exist.
   *
   * @param {string} id - identifier of the popup to close
   * @emits `'popup:close'` via EventBus
   */
  close (id) {
    const popup = this._popups.get(id)
    if (!popup) return

    popup.remove()
    this._popups.delete(id)
    this._eventBus.emit('popup:close', { popupId: id })
  }

  /**
   * Closes all open popups.
   */
  closeAll () {
    for (const id of this._popups.keys()) {
      this.close(id)
    }
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  /**
   * Updates the content of an already open popup without closing/reopening it.
   *
   * @param {string} id - identifier of the popup to update
   * @param {string | HTMLElement} content - new HTML content
   */
  update (id, content) {
    const popup = this._popups.get(id)
    if (!popup) return

    if (content instanceof HTMLElement) {
      popup.setDOMContent(content)
    } else {
      popup.setHTML(content)
    }
  }

  /**
   * Repositions an open popup to new coordinates.
   * @param {string} id - popup identifier
   * @param {[number, number]} lngLat - new coordinates [longitude, latitude]
   */
  moveTo (id, lngLat) {
    const popup = this._popups.get(id)
    popup?.setLngLat(lngLat)
  }

  // ── Access ─────────────────────────────────────────────────────────────────

  /**
   * Indicates if a given popup is currently open.
   * @param {string} id - popup identifier
   * @returns {boolean}
   */
  isOpen (id) {
    return this._popups.has(id)
  }

  /**
   * Returns the IDs of all currently open popups.
   * @returns {string[]}
   */
  getOpenPopupIds () {
    return Array.from(this._popups.keys())
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Closes all popups and releases resources.
   * Called by `MapEngine.destroy()`.
   */
  destroy () {
    this.closeAll()
  }
}
