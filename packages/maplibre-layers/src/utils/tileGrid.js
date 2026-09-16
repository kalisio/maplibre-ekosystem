/**
 * @file tileGrid.js
 * @description Standard Web Mercator z/x/y tile grid math, shared by every
 * gridded-field rendering that needs to convert between MapLibre's tile
 * coordinate system and lon/lat: `GriddedFieldProtocol.js` (raster tiles,
 * MapLibre-driven) and `GriddedFieldTiledMeshLayer.js` (GPU mesh tiles,
 * self-managed — see that file's header for why it doesn't use a real
 * MapLibre Source/tile pyramid).
 */

/**
 * z/x/y tile -> lon/lat bounding box.
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {{ lonMin: number, lonMax: number, latMin: number, latMax: number }}
 */
export function tileToBBox (z, x, y) {
  const n = 2 ** z
  const lonMin = (x / n) * 360 - 180
  const lonMax = ((x + 1) / n) * 360 - 180
  const latOfRow = (row) => {
    const yFrac = Math.PI * (1 - (2 * row) / n)
    return (Math.atan(Math.sinh(yFrac)) * 180) / Math.PI
  }
  return { lonMin, lonMax, latMax: latOfRow(y), latMin: latOfRow(y + 1) }
}

/**
 * lon/lat -> the z/x/y tile containing it (inverse of `tileToBBox()`).
 * @param {number} lon
 * @param {number} lat
 * @param {number} z
 * @returns {{ x: number, y: number }}
 */
export function lngLatToTile (lon, lat, z) {
  const n = 2 ** z
  const x = Math.floor(((lon + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  )
  return {
    x: Math.min(Math.max(x, 0), n - 1),
    y: Math.min(Math.max(y, 0), n - 1)
  }
}
