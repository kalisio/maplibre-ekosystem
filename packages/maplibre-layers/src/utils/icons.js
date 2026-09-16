/**
 * @file icons.js
 * @description Icon/shape helpers shared with `style-parser.js`: resolving a
 * Line Awesome CSS class string to a sprite name, and rendering a
 * `ShapeFactory` shape to a loadable image for use as a MapLibre sprite.
 */

import { ShapeFactory } from '@kalisio/common-graphics'

/**
 * Converts a Line Awesome CSS class string (e.g. `'las la-map-marker'`,
 * `'lar la-star'`) into the bare icon name MapLibre's sprite lookup expects
 * (e.g. `'map-marker-solid'`, `'star'`). A single-class string (no icon-font
 * prefix) is returned unchanged.
 * @param {string} classes - e.g. `'las la-map-marker'`
 * @returns {string | null} the bare sprite name, or `null` if `classes` is falsy
 */
export function classesToIconName (classes) {
  if (!classes) return null
  const classList = classes.split(' ')
  if (classList.length === 1) {
    return classList[0]
  }

  classList[1] = classList[1].replace('la-', '')

  if (classList[0] === 'las') return classList[1] + '-solid'

  return classList[1]
}

/**
 * Renders a `ShapeFactory` shape (`options.shape` plus its color/size/stroke
 * options) to an SVG data URI, loads it as an `Image`, and invokes
 * `callback(shapeHash, image)` once loaded — used to register the generated
 * shape as a MapLibre sprite image via `map.addImage(shapeHash, image)`.
 * `shapeHash` is a deterministic hash of `options`, so the same shape config
 * always resolves to the same image name (avoiding duplicate `addImage`
 * calls and MapLibre's `{token}` string-expression evaluation).
 * @param {Object} options - shape options, e.g. `{ shape, color, opacity, radius, margin, stroke: { width, color, opacity } }`
 * @param {Function} callback - `(shapeHash, image) => void`, called asynchronously once the SVG has loaded
 * @returns {string | null} the computed `shapeHash` (`'shape-<hash>'`), or `null` if `options.shape` is missing or unknown to `ShapeFactory`
 */
export function buildShapeAsImage (options, callback) {
  if (!options?.shape) return null
  const jsonStr = JSON.stringify(options)
  // Create a simple numeric hash to avoid MapLibre's {token} evaluation
  let hash = 0
  for (let i = 0; i < jsonStr.length; i++) {
    hash = ((hash << 5) - hash) + jsonStr.codePointAt(i)
    hash = Math.trunc(hash)
  }
  const shapeHash = `shape-${Math.abs(hash)}`

  const factory = new ShapeFactory()

  if (!factory.has(options.shape)) return null

  const shape = factory.build(options)
  const shapeSVG = shape.toSVG()

  const encodedSvg = encodeURIComponent(shapeSVG)
  const dataUri = `data:image/svg+xml;charset=utf-8,${encodedSvg}`

  const img = new Image()
  img.onload = () => callback(shapeHash, img)
  img.src = dataUri

  return shapeHash
}
