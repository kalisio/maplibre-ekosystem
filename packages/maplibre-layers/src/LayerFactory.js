import { VectorLayerAdapter, NDimensionalVectorLayerAdapter } from './adapters/VectorLayerAdapter.js'
import { MapLibreLayerAdapter } from './adapters/MapLibreLayerAdapter.js'
import { ThreeJsLayerAdapter, NDimensionalThreeJsLayerAdapter } from './adapters/ThreeJsLayerAdapter.js'
import { Layer } from './Layer.js'
import { DeckGlLayerAdapter } from './adapters/DeckGlLayerAdapter.js'
import { AdapterContext } from './contexts/AdapterContext.js'

export class LayerFactory {
  /**
   * @param {Object} definition
   * @param {import('maplibre-gl').Map} map
   * @param {import('./LayerManager.js').LayerManager} layerManager
   * @returns {Layer}
   */
  createLayer (definition, map, layerManager) {
    if (!definition) {
      throw new Error('Layer definition is required')
    }
    const type = definition.type
    const protocol = definition.url ? new URL(definition.url).protocol.replace(':', '') : null

    // Each LayerAdapter only ever sees this narrow context, never the full LayerManager.
    const context = new AdapterContext(layerManager)

    // `Layer` owns `definition`/`map`/`context` — both adapters below get a
    // reference to this SAME `layer` instance (not independently-constructed
    // copies of definition/map/context), see Layer.js's file header.
    const layer = new Layer(definition, map, context)
    switch (type) {
      case 'vector':
        if (protocol === 'kazarr') {
          layer.set2DLayer(new NDimensionalVectorLayerAdapter(layer))
          layer.set3DLayer(new NDimensionalThreeJsLayerAdapter(layer))
        } else {
          layer.set2DLayer(new VectorLayerAdapter(layer))
          layer.set3DLayer(new ThreeJsLayerAdapter(layer))
        }
        break
      case 'raster':
      case 'raster-dem':
        layer.set2DLayer(new MapLibreLayerAdapter(layer))
        break
      case 'mesh':
        // A kazarr:// 'mesh' is a gridded scalar field (e.g. AROME/ARPEGE)
        // rendered as a single GPU-colored triangle mesh, native to
        // MapLibre (2D only) — see MapLibreLayerAdapter._addGriddedFieldMeshLayer().
        // Any other 'mesh' is an explicit, user-supplied static
        // { vertices, indices, values? } mesh rendered via deck.gl's
        // SimpleMeshLayer (3D) — see DeckGlLayerAdapter._createMeshLayer().
        if (protocol === 'kazarr') {
          layer.set2DLayer(new MapLibreLayerAdapter(layer))
        } else {
          layer.set3DLayer(new DeckGlLayerAdapter(layer))
        }
        break
      case 'tiled-mesh':
        // A gridded scalar field (kazarr:// only — this type has no other
        // meaning) rendered as a self-managed z/x/y tile cache of
        // GPU-colored meshes — see
        // MapLibreLayerAdapter._addGriddedFieldTiledMeshLayer() and
        // GriddedFieldTiledMeshLayer.js.
        layer.set2DLayer(new MapLibreLayerAdapter(layer))
        break
      case 'point-cloud':
        layer.set3DLayer(new DeckGlLayerAdapter(layer))
        break
    }

    return layer
  }
}
