/**
 * @file index.js
 * @description Entry point of this package's internal `utils/` folder —
 * pure, stateless helpers with no MapLibre/deck.gl/Three.js dependency of
 * their own (only `@kalisio/common-graphics` for shape/icon rendering).
 * Consumed by `adapters/LayerAdapter.js` and `adapters/VectorLayerAdapter.js`.
 * Not part of this package's public `exports` map — imported internally via
 * relative paths (`../utils/index.js`), same as `providers/index.js` and
 * `strategies/index.js`.
 */

export {
  parseStyle,
  isMapLibreStyle,
  parseKDKStyle,
  generateFiltersFromStyle
} from './style-parser.js'

export { classesToIconName } from './icons.js'
export { DEFAULT_CLUSTER_PALETTE, resolveClusterColors, buildClusterMarkerElement } from './cluster.js'
