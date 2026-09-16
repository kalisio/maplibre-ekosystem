/**
 * @file style-parser.js
 * @description Utilities for converting business styles to MapLibre GL specifications.
 */

import { classesToIconName, buildShapeAsImage } from './icons.js'

const KDKStylePropertiesToMapLibre = {
  point: {
    color: 'paint.circle-color',
    opacity: 'paint.circle-opacity',
    size: 'paint.circle-radius',
    shape: 'layout.icon-image',
    stroke: {
      color: 'paint.circle-stroke-color',
      width: 'paint.circle-stroke-width',
      opacity: 'paint.circle-stroke-opacity'
    },
    icon: {
      color: 'paint.icon-color',
      opacity: 'paint.icon-opacity',
      size: 'layout.icon-size',
      classes: 'layout.icon-image'
    }
  },
  line: {
    color: 'paint.line-color',
    width: 'paint.line-width',
    opacity: 'paint.line-opacity'
  },
  polygon: {
    color: 'paint.fill-color',
    opacity: 'paint.fill-opacity',
    stroke: {
      color: 'paint.polygon-stroke-color', // Those 3 properties are not standard MapLibre properties
      width: 'paint.polygon-stroke-width', // as MapLibre does not support polygon stroke width and opacity natively
      opacity: 'paint.polygon-stroke-opacity' // So we need to create another layer for the stroke
    }
  }
}

const DefaultStyle = {
  paint: {
    'circle-color': '#ff0000',
    'circle-opacity': 0.5,
    'circle-radius': 5,
    'circle-stroke-color': '#ff0000',
    'circle-stroke-width': 0,
    'circle-stroke-opacity': 1,
    'icon-color': '#ff0000',
    'icon-opacity': 1,

    'line-color': '#ff0000',
    'line-width': 1,
    'line-opacity': 1,

    'fill-color': '#ff0000',
    'fill-opacity': 0.5,
    'polygon-stroke-color': '#ff0000',
    'polygon-stroke-width': 1,
    'polygon-stroke-opacity': 1
  },
  layout: {
    'icon-size': 1,
    'icon-image': 'default-icon'
  }
}

/**
 * Detects if a style is a MapLibre style.
 *
 * @param {Object} style
 * @returns {boolean}
 */
export function isMapLibreStyle (style) {
  if (!style) return false
  if (style.paint || style.layout) return true
  return Object.keys(style).some(key => key.includes('-'))
}

/**
 * Parses a generic style, automatically detecting whether it's KDK or MapLibre,
 * merges it with the application's default style, and resolves any icon/shape
 * reference to a concrete sprite image name.
 *
 * @param {Object} style - business ("KDK") style, or a MapLibre-native `{ paint, layout }` pair; falsy falls back entirely to `appDefaultStyle`
 * @param {string} [layerType='vector'] - e.g. `'vector'`, `'raster'`, `'raster-dem'` — only used by `parseKDKStyle()` to pick the MapLibre layer `type`
 * @param {Object} [appDefaultStyle={}] - `{ paint, layout }` merged underneath the resolved style (lowest priority)
 * @param {Function} [onIconLoaded] - callback forwarded to `buildShapeAsImage()` when the resolved icon is a generated shape (not a `la-*` icon font glyph); invoked once the shape image has loaded
 * @returns {Object} `{ type, paint, layout }` MapLibre GL style object
 */
export function parseStyle (style, layerType = 'vector', appDefaultStyle = {}, onIconLoaded = null) {
  const mergedDefaultStyle = _getDefaultStyle(appDefaultStyle)

  let finalStyle = null
  if (!style) {
    finalStyle = {
      type: 'circle',
      paint: mergedDefaultStyle.paint,
      layout: mergedDefaultStyle.layout
    }
  } else if (isMapLibreStyle(style)) {
    finalStyle = {
      type: style.type,
      paint: { ...mergedDefaultStyle.paint, ...(style.paint || style) },
      layout: { ...mergedDefaultStyle.layout, ...style.layout }
    }
  } else {
    const parsedStyle = parseKDKStyle(style, layerType)
    finalStyle = {
      ...parsedStyle,
      paint: { ...mergedDefaultStyle.paint, ...parsedStyle.paint },
      layout: { ...mergedDefaultStyle.layout, ...parsedStyle.layout }
    }
  }

  const isShape = finalStyle.layout['icon-image'] && !finalStyle.layout['icon-image'].includes('la-')
  finalStyle.layout['icon-image'] = classesToIconName(finalStyle.layout['icon-image'])

  if (isShape) {
    const shapeHash = buildShapeAsImage({
      shape: finalStyle.layout['icon-image'],
      color: finalStyle.paint['circle-color'],
      opacity: finalStyle.paint['circle-opacity'],
      radius: finalStyle.paint['circle-radius'],
      margin: 5,
      stroke: {
        width: finalStyle.paint['circle-stroke-width'],
        color: finalStyle.paint['circle-stroke-color'],
        opacity: finalStyle.paint['circle-stroke-opacity']
      }
    }, onIconLoaded)

    if (shapeHash) {
      console.log('[parseStyle] Generated shape hash:', shapeHash)
      finalStyle.layout['icon-image'] = shapeHash
    }
  }

  return finalStyle
}

/**
 * Parses a KDK style into a MapLibre style, mapping business properties
 * (`point.color`, `point.stroke.width`, `polygon.stroke.*`, etc., per
 * `KDKStylePropertiesToMapLibre`) onto `paint.*`/`layout.*` paths and
 * inferring the MapLibre layer `type` (`'symbol'`, `'fill'`, `'line'`,
 * `'circle'`, or the raw `layerType` for raster layers).
 *
 * @param {Object} style - business ("KDK") style, e.g. `{ point: {...}, line: {...}, polygon: {...} }`
 * @param {string} layerType - e.g. `'vector'`, `'raster'`, `'raster-dem'`
 * @returns {Object} `{ type, paint, layout }`, not yet merged with any default style
 */
export function parseKDKStyle (style, layerType) {
  const maplibreStyle = {
    paint: {},
    layout: {},
    type: 'circle' // default type
  }

  if (layerType === 'raster' || layerType === 'raster-dem') {
    maplibreStyle.type = layerType
  } else {
    // If a specific shape or icon is detected, the type is set to "symbol"
    if (style.point && (style.point.shape === 'marker' || style.point.shape === 'icon' || style.point.icon)) {
      maplibreStyle.type = 'symbol'
    } else if (style.polygon) {
      maplibreStyle.type = 'fill'
    } else if (style.line) {
      maplibreStyle.type = 'line'
    }
  }

  // Recursive function to map the properties
  function traverseAndMap (kdkObj, mapObj) {
    if (!kdkObj) return
    for (const [key, value] of Object.entries(kdkObj)) {
      if (mapObj[key]) {
        if (typeof value === 'object' && !Array.isArray(value) && typeof mapObj[key] === 'object') {
          traverseAndMap(value, mapObj[key])
        } else if (typeof mapObj[key] === 'string') {
          const [target, mlKey] = mapObj[key].split('.')
          maplibreStyle[target][mlKey] = _parseValue(value)
        }
      }
    }
  }

  traverseAndMap(style.point, KDKStylePropertiesToMapLibre.point)
  traverseAndMap(style.line, KDKStylePropertiesToMapLibre.line)
  traverseAndMap(style.polygon, KDKStylePropertiesToMapLibre.polygon)

  return maplibreStyle
}

/**
 * Generates filters from a templated KDK style.
 *
 * @param {Object} style
 * @returns {Array} Array of filter objects
 */
export function generateFiltersFromStyle (style) {
  // TODO: to be implemented
  return []
}

/**
 * Resolves one KDK style property value: passes it through unchanged unless
 * it's a `<% ... %>` template string, in which case it's compiled into a
 * MapLibre expression via `_parseExpression()`.
 * @param {*} value
 * @returns {*} the original value, or a MapLibre expression array
 */
function _parseValue (value) {
  if (typeof value === 'string' && value.includes('<%')) {
    return _parseExpression(value)
  }
  return value
}

/**
 * Compiles one `if (...) { ... }` condition body (as found inside a `<% %>`
 * template) into a MapLibre filter expression. Supports `||`-joined
 * sub-conditions, `_.has(properties, 'key')`, `properties.key === value`
 * equality checks (string/number/boolean literals), and bare truthy checks
 * (`properties.key`); anything else falls back to `['get', cond]`.
 * @param {string} cond - the raw JS-like condition source
 * @returns {Array} a MapLibre expression, e.g. `['==', ['get', 'key'], value]`
 */
function _parseCondition (cond) {
  cond = cond.trim()

  if (cond.includes('||')) {
    const parts = cond.split('||').map(p => _parseCondition(p))
    return ['any', ...parts]
  }

  const hasMatch = cond.match(/_\.has\(\s*properties\s*,\s*['"]([^'"]+)['"]\s*\)/)
  if (hasMatch) return ['has', hasMatch[1]]

  const eqMatch = cond.match(/(?:properties|feature)\.([a-zA-Z0-9_]+)\s*===\s*(.+)/)
  if (eqMatch) {
    let val = eqMatch[2].trim()
    if (val.startsWith("'") || val.startsWith('"')) val = val.slice(1, -1)
    else if (!Number.isNaN(Number(val))) val = Number(val)
    else if (val === 'true') val = true
    else if (val === 'false') val = false
    return ['==', ['get', eqMatch[1]], val]
  }

  const truthyMatch = cond.match(/(?:properties|feature)\.([a-zA-Z0-9_]+)/)
  if (truthyMatch) return ['get', truthyMatch[1]]

  return ['get', cond]
}

/**
 * Compiles a KDK templated style value (a string mixing plain text with
 * `<% if (...) { %>...<% } else { %>...<% } %>` blocks) into a MapLibre
 * `['case', cond1, val1, cond2, val2, ..., defaultVal]` expression. Returns
 * the input unchanged if it contains no `<% %>` template markers, or if no
 * condition/value pair could be extracted.
 * @param {string} template
 * @returns {*} a MapLibre `'case'` expression array, or the original template
 */
function _parseExpression (template) {
  if (typeof template !== 'string' || !template.includes('<%')) return template

  const result = ['case']
  let defaultVal = null

  const tokens = []
  const tokenRegex = /<%([\s\S]*?)%>|((?:(?!<%).)+)/g
  let match
  while ((match = tokenRegex.exec(template)) !== null) {
    if (match[1]) tokens.push({ type: 'code', value: match[1].trim() })
    else if (match[2]) tokens.push({ type: 'text', value: match[2].trim() })
  }

  let currentCond = null

  for (const element of tokens) {
    const t = element
    if (t.type === 'code') {
      const val = t.value
      if (val.includes('if') && val.includes('{')) {
        const condMatch = val.match(/if\s*\(([\s\S]*)\)\s*\{/)
        if (condMatch) currentCond = _parseCondition(condMatch[1])
      } else if (val.includes('else') && val.includes('{')) {
        currentCond = 'else'
      }
    } else if (t.type === 'text' && t.value !== '') {
      let val = t.value
      if (!Number.isNaN(Number(val))) val = Number(val)
      if (currentCond === 'else') {
        defaultVal = val
      } else if (currentCond) {
        result.push(currentCond, val)
        currentCond = null
      }
    }
  }

  if (defaultVal !== null) result.push(defaultVal)
  return result.length > 1 ? result : template
}

/**
 * Merges an application-level default style on top of the package's own
 * hardcoded `DefaultStyle`, per `paint`/`layout` bucket.
 * @param {Object} [appDefaultStyle={}] - `{ paint, layout }`
 * @returns {Object} `{ paint, layout }`
 */
function _getDefaultStyle (appDefaultStyle = {}) {
  return {
    paint: {
      ...DefaultStyle.paint,
      ...appDefaultStyle.paint
    },
    layout: {
      ...DefaultStyle.layout,
      ...appDefaultStyle.layout
    }
  }
}
