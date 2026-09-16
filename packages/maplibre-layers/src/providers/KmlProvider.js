/**
 * @file KmlProvider.js
 * @description Provider for data in KML (Keyhole Markup Language) format.
 *
 * Parses KML (XML) files and converts them into a `GeoJSON.FeatureCollection`
 * so that `MapLibreNativeAdapter` can consume them via a GeoJSON source.
 *
 * Data flow:
 * 1. Download KML file (URL or inline string)
 * 2. XML parsing of the KML document
 * 3. Extraction of Placemarks (points, lines, polygons)
 * 4. Conversion to GeoJSON.FeatureCollection with preservation of properties
 */

// import { kml } from '@tmcw/togeojson';
import { parse } from '@loaders.gl/core'
import { KMLLoader } from '@loaders.gl/kml'
// KMLLoader use @tmcw/togeojson internally, but also use web workers for parsing, which is more efficient for large files.
// In addition, it will be easier to use only @loaders.gl for all formats

export class KmlProvider {
  _layerDefinition

  /**
   * @param {Object} definition - layer definition; either `definition.data`
   *   (inline KML string) or `definition.url` (a `kml://` URL, rewritten to
   *   `https://`) must be set
   */
  constructor (definition) {
    this._layerDefinition = definition
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Returns the layer's data as GeoJSON: parses `definition.data` directly
   * if provided, otherwise downloads and parses `definition.url`. KML data
   * is static (non-temporal), so `options` is currently unused.
   * @param {Object} [options] - unused
   * @returns {Promise<{ type: 'FeatureCollection', features: Object[] }>}
   * @throws {Error} if the layer has neither `data` nor `url` configured
   */
  async get (options = {}) {
    if (this._layerDefinition.data) {
      // Direct data provided, may need format conversion
      return this._parse(this._layerDefinition.data)
    } else if (this._layerDefinition.url) {
      return this._fetch()
    } else {
      throw new Error(`[KmlProvider] Layer "${this._layerDefinition.id}" has neither 'data' nor 'url' configured.`)
    }
  }

  // ── Private Methods ────────────────────────────────────────────────────────

  /**
   * Parses raw KML data directly into a GeoJSON FeatureCollection.
   *
   * @param {string} rawData - raw KML XML string
   * @returns {Promise<{ type: 'FeatureCollection', features: Object[] }>}
   */
  async _parse (rawData) {
    // const kmlDocument = this._parseXml(rawData);
    // return kml(kmlDocument);
    const geojson = await parse(rawData, KMLLoader)
    return geojson
  }

  /**
   * Downloads and parses a KML file, returning a GeoJSON FeatureCollection.
   * KML data is static (non-temporal), so no time parameter is involved.
   *
   * @returns {Promise<{ type: 'FeatureCollection', features: Object[] }>}
   * @throws {Error} if the URL is inaccessible or the KML is invalid
   */
  async _fetch () {
    if (!this._layerDefinition.url) {
      throw new Error(`[KmlProvider] Layer "${this._layerDefinition.id}" has no url configured.`)
    }

    const targetUrl = this._layerDefinition.url.replace(/^kml:\/\//, 'https://')
    const kmlText = await this._fetchKml(targetUrl)

    return this._parse(kmlText)
  }

  /**
   * Downloads the text content of a KML file from a URL.
   * @param {string} url - KML file URL
   * @returns {Promise<string>}
   */
  async _fetchKml (url) {
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.google-earth.kml+xml, application/xml, text/xml' }
    })

    if (!response.ok) {
      throw new Error(`[KmlProvider] Cannot fetch KML at ${url}: ${response.statusText}`)
    }

    return response.text()
  }

  /**
   * Parses an XML string into a DOM Document.
   * @todo Currently unused/dead code — `_parse()` uses `@loaders.gl/kml`'s
   * `KMLLoader` instead (see the commented-out `@tmcw/togeojson` alternative
   * in `_parse()`, which this method was written to support).
   *
   * @param {string} xmlText - raw XML content
   * @returns {Document}
   * @throws {Error} if the XML is malformed
   */
  _parseXml (xmlText) {
    const parser = new DOMParser()
    const doc = parser.parseFromString(xmlText, 'application/xml')

    const parseError = doc.querySelector('parsererror')
    if (parseError) {
      throw new Error(`[KmlProvider] Malformed KML XML: ${parseError.textContent}`)
    }

    return doc
  }
}
