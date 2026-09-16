/**
 * @file ThreeJsSceneManager.js
 * @description Owns the single `THREE.Scene` and the custom MapLibre `'3d'`
 * layer that renders it every frame, symmetrical to `DeckGlManager`.
 *
 * Instantiated once per map (by `LayerManager.initialize()`). Every
 * `ThreeJsLayerAdapter` calls `setGroup()`/`setGroupVisibility()`/
 * `removeGroup()` on it instead of managing its own Three.js scene/renderer,
 * so multiple 3D layers share the same WebGL renderer, camera and lighting.
 */
import * as THREE from 'three'

const SCENE_MANAGER_LAYER_ID = 'internal:threejs-scene-manager'

export class ThreeJsSceneManager {
  _map

  /**
   * Named Three.js groups added to the scene, keyed by business layer id.
   * @type {Map<string, THREE.Group>}
   */
  _groups = new Map()

  /**
   * Lazily-created Three.js objects (renderer, scene, camera, lights, ground
   * plane) that depend on the WebGL context handed to `onAdd()`, keyed by name.
   * @type {Map<string, Object>}
   */
  _threeObjects = new Map()

  /**
   * Whether the custom `'3d'` MapLibre layer has been registered yet.
   * Created lazily, on the first `setGroup()` call — not in the constructor.
   * `LayerManager.initialize()` builds a `ThreeJsSceneManager` for every map
   * unconditionally, even when the app never adds a single 3D layer. Adding
   * a custom `'3d'` layer immediately hooks a second `WebGLRenderer` into the
   * same GL context as MapLibre's own renderer, and its `render` callback
   * calls `renderer.resetState()` plus `map.triggerRepaint()` on every
   * frame from that point on — even with an empty scene. Depending on
   * exactly when MapLibre first paints the base style's tiles relative to
   * this custom layer's own `onAdd`/first `render` call (a race, so it
   * doesn't reproduce on every reload), this can leave the base map
   * rendering black until something forces a full repaint (e.g. a pitch
   * change) — deferring registration until a 3D layer actually exists avoids
   * the race entirely. `DeckGlManager` defers its own overlay creation the
   * same way, for the same reason.
   * @type {boolean}
   */
  _layerAdded = false

  /**
   * @param {import('maplibre-gl').Map} map
   */
  constructor (map) {
    this._map = map
  }

  /**
   * Registers the custom MapLibre `'3d'` rendering-mode layer that owns the
   * Three.js renderer/scene/camera and re-renders them on every MapLibre
   * frame, if not already registered. See the `_layerAdded` field doc above
   * for why this is deferred instead of happening in the constructor.
   */
  _ensureLayer () {
    if (this._layerAdded) return
    this._layerAdded = true

    const map = this._map
    map.addLayer({
      id: SCENE_MANAGER_LAYER_ID,
      type: 'custom',
      renderingMode: '3d',
      onAdd: (map, gl) => {
        this._three('renderer', new THREE.WebGLRenderer({
          canvas: map.getCanvas(),
          context: gl,
          antialias: true
        }))
        this._three('renderer').autoClear = false // Don't clear the canvas before each render, as MapLibre GL JS will handle it
        const scene = new THREE.Scene()
        this._three('scene', scene)

        this._three('camera', new THREE.Camera())

        const directionalLight = new THREE.DirectionalLight(0xffffff)
        directionalLight.position.set(0, -70, 100).normalize()
        scene.add(directionalLight)
        this._three('directionalLight', directionalLight)

        // MapLibre's own basemap (2D tiles) writes nothing to the depth
        // buffer: it's drawn with the painter's algorithm, not depth
        // testing. Without this plane, no Three.js scene object can be
        // partially occluded by the "ground" (e.g. the debug cube would
        // always render in full even when its bottom half is below z = 0).
        // An invisible plane (colorWrite: false) is added here that writes
        // only to the depth buffer, to stand in for the ground.
        const groundPlane = this._createGroundPlane()
        scene.add(groundPlane)
        this._three('groundPlane', groundPlane)
      },
      render: (gl, matrix) => {
        this._three('camera').projectionMatrix = new THREE.Matrix4().fromArray(matrix)
        // Reset the state of the renderer to avoid issues with MapLibre GL JS state
        this._three('renderer').resetState()
        this._three('renderer').render(this._three('scene'), this._three('camera'))
        map.triggerRepaint()
      }
    })
  }

  /**
   * Adds (or replaces) a named group in the shared scene, registering the
   * custom `'3d'` layer first if this is the first group ever added.
   * @param {string} name - business layer id
   * @param {THREE.Group} group
   */
  setGroup (name, group) {
    this._ensureLayer()
    const existingGroup = this._groups.get(name)
    this._groups.set(name, group)
    if (existingGroup) {
      this._three('scene').remove(existingGroup)
    }
    // The camera used here has no valid matrixWorld (only its
    // projectionMatrix is populated, from the MapLibre matrix), so
    // Three.js's frustum culling can't be trusted: an object can be
    // wrongly dropped from rendering (as happened with the ground plane,
    // which vanished silently). It's disabled for every object in this
    // group rather than fixed case by case.
    group.traverse((object) => {
      object.frustumCulled = false
    })
    this._three('scene').add(group)
    this._bringToFront()
  }

  /**
   * Removes a named group from the scene entirely.
   * Called by `ThreeJsLayerAdapter.destroy()` so a removed layer doesn't
   * leave its geometry behind in the shared Three.js scene.
   * @param {string} name
   */
  removeGroup (name) {
    const group = this._groups.get(name)
    if (!group) return
    this._three('scene').remove(group)
    this._groups.delete(name)
  }

  /**
   * Toggles the visibility of one named group without touching the others.
   * @param {string} name
   * @param {boolean} visible
   */
  setGroupVisibility (name, visible) {
    const group = this._groups.get(name)
    if (group) {
      group.visible = visible
      this._bringToFront()
    }
  }

  /**
   * Builds the invisible depth-only ground plane described in the comment
   * below.
   * @returns {THREE.Mesh}
   */
  // Invisible plane covering the whole normalized Mercator space (0 to 1
  // in X/Y), at z = 0. It draws no color but writes its depth, which lets
  // 3D objects (e.g. ThreeJsLayer's debug cube) be correctly occluded by
  // the "ground" via depthTest.
  _createGroundPlane () {
    // Oversized (beyond [0,1]) as a safety margin, e.g. for objects whose
    // origin sits near the edges of the Mercator window.
    const geometry = new THREE.PlaneGeometry(3, 3)
    const material = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      // The Three.js camera here has no valid matrixWorld (only its
      // projectionMatrix is populated, from the MapLibre matrix), so which
      // side of the plane it sits on can't be known for sure. Without
      // DoubleSide, a wrong-facing normal would simply make the plane
      // disappear (back-face culling) and the depth buffer would never be
      // written to.
      side: THREE.DoubleSide
    })
    const plane = new THREE.Mesh(geometry, material)
    plane.position.set(0.5, 0.5, 0)
    plane.renderOrder = -1 // ensure it renders before the objects that depend on it
    // Three.js's frustum culling relies on camera.matrixWorldInverse,
    // which stays at identity here (only projectionMatrix is updated from
    // MapLibre): the test could therefore wrongly cull this plane. It's
    // disabled to guarantee the plane always renders.
    plane.frustumCulled = false
    return plane
  }

  /**
   * Getter/setter for the lazily-created Three.js objects in `_threeObjects`
   * (`'renderer'`, `'scene'`, `'camera'`, `'directionalLight'`, `'groundPlane'`).
   * @param {string} name
   * @param {Object} [value] - if provided, stores it under `name` before returning it
   * @returns {Object}
   */
  _three (name, value = null) {
    if (value) {
      this._threeObjects.set(name, value)
    }
    return this._threeObjects.get(name)
  }

  /**
   * Moves the custom `'3d'` layer to the top of the MapLibre layer stack, so
   * newly (re)ordered Three.js content always renders above the 2D basemap.
   */
  _bringToFront () {
    if (this._map.getLayer(SCENE_MANAGER_LAYER_ID)) {
      this._map.moveLayer(SCENE_MANAGER_LAYER_ID)
    }
  }
}
