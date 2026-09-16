/**
 * @file ThreeJsLayerAdapter.js
 * @description `LayerAdapter` rendering a GeoJSON layer's 3D representation
 * via the shared `ThreeJsSceneManager` — converts GeoJSON geometry into a
 * `THREE.Group` (points, lines, extrusion-free polygons) in normalized
 * Mercator space, matching MapLibre's own coordinate system.
 *
 * GeoJSON altitude (each coordinate's optional 3rd value, in meters) is
 * honored everywhere, including per-vertex for polygons (a sloped/draped
 * polygon renders correctly), converted via `MercatorCoordinate`'s own
 * meters-to-Mercator-units scaling (`fromLngLat(lngLat, altitude)`), which
 * is latitude-dependent. Polygons are built as a plain indexed
 * `THREE.BufferGeometry` (2D-triangulated in Mercator X/Y via
 * `THREE.ShapeUtils.triangulateShape()` — the same triangulator
 * `THREE.ShapeGeometry` uses internally — then each vertex gets its own Z)
 * rather than `THREE.ShapeGeometry`, which only ever produces a flat mesh
 * at a single Z.
 *
 * Every converted coordinate also gets a small constant `GROUND_CLEARANCE_METERS`
 * added to its Z, so content whose GeoJSON altitude is 0 (or missing —
 * the common "on the ground" case) never lands exactly on
 * `ThreeJsSceneManager`'s invisible depth-only ground plane (itself at
 * Z=0), which previously caused z-fighting between the two.
 */
import { NDimensionalMixin } from './mixins/NDimensionalMixin.js'
import { LayerAdapter } from './LayerAdapter.js'

import * as THREE from 'three'
import { MercatorCoordinate } from 'maplibre-gl'

/**
 * Vertical clearance, in meters, added to every converted coordinate's
 * Mercator Z — keeps ground-level content (altitude 0 or missing) strictly
 * above `ThreeJsSceneManager`'s ground plane instead of coinciding with it,
 * which caused z-fighting. Small enough to be visually imperceptible at
 * normal zoom levels; tune if artifacts reappear at very close zoom.
 * @type {number}
 */
const GROUND_CLEARANCE_METERS = 0.5

export class ThreeJsLayerAdapter extends LayerAdapter {
  /** @type {THREE.Group} the group currently registered on `ThreeJsSceneManager`, if any */
  _group

  /**
   * Builds the Three.js group from `definition.data` (if present) and
   * registers it on the shared `ThreeJsSceneManager`. No-op if there's no
   * inline data — a provider-backed layer instead gets its group via
   * `getSource().setData()`, called from `_loadProviderData()`.
   */
  _initialize () {
    super._initialize()

    if (this._definition.data) {
      console.log('[ThreeJsLayerAdapter] Initializing Three.js layer with data', this._definition.data)
      this._group = this._geojsonToThree(this._definition.data)
      this._context.getThreeJsSceneManager().setGroup(this._id, this._group)
    }
  }

  /**
   * @returns {[[number, number], [number, number]] | null}
   * Same contract as `MapLibreLayerAdapter.getBounds()` — `[[minLon,minLat],[maxLon,maxLat]]`,
   * suitable for `map.fitBounds()`. Previously this returned a raw `THREE.Box3` in
   * normalized Mercator space, which broke `MapEngine.flyToLayer()` for 3D layers.
   */
  getBounds () {
    if (!this._group) return null
    const box = new THREE.Box3().setFromObject(this._group)

    const c1 = new MercatorCoordinate(box.min.x, box.min.y, box.min.z).toLngLat()
    const c2 = new MercatorCoordinate(box.max.x, box.max.y, box.max.z).toLngLat()

    return [
      [Math.min(c1.lng, c2.lng), Math.min(c1.lat, c2.lat)],
      [Math.max(c1.lng, c2.lng), Math.max(c1.lat, c2.lat)]
    ]
  }

  /**
   * Returns a source-like object exposing `setData()`, so `_loadProviderData()`
   * (which is written against MapLibre's `GeoJSONSource` contract) can push
   * fresh GeoJSON here the same way it would for a 2D adapter — rebuilding
   * the Three.js group and re-registering it on `ThreeJsSceneManager`.
   * @returns {{ group: THREE.Group, setData: (data: Object) => void }}
   */
  getSource () {
    return {
      group: this._group,
      setData: (data) => {
        const newGroup = this._geojsonToThree(data)
        this._context.getThreeJsSceneManager().setGroup(this._id, newGroup)
      }
    }
  }

  /**
   * @param {boolean} visible
   */
  setVisibility (visible) {
    console.log('[ThreeJsLayerAdapter] setVisibility', visible)
    this._context.getThreeJsSceneManager().setGroupVisibility(this._id, visible)
  }

  /**
   * Removes this layer's group from the shared Three.js scene.
   * Previously missing — the base `LayerAdapter.destroy()` is a no-op, so a
   * removed 3D layer left its geometry behind forever.
   */
  destroy () {
    this._context.getThreeJsSceneManager()?.removeGroup(this._id)
  }

  /**
   * Converts a GeoJSON `Feature`/`FeatureCollection`/geometry into a
   * `THREE.Group`, mapping each feature's geometry to a Three.js primitive
   * (`Points`, `Line`, or an indexed, per-vertex-elevated `Mesh` for
   * polygons — no extrusion) positioned in normalized Mercator space via
   * `MercatorCoordinate`, so it aligns with MapLibre's own `'3d'` custom
   * layer camera.
   * @param {Object} geojson - `Feature`, `FeatureCollection`, or a bare geometry object
   * @returns {THREE.Group}
   * @todo Unconditionally adds a red wireframe debug cube at lon/lat (0, 0)
   * to every returned group — leftover debugging aid, not layer content.
   */
  _geojsonToThree (geojson) {
    const mainGroup = new THREE.Group()

    // MapLibre conversion (lon, lat, altitude) -> (x, y, z) in normalized Mercator space
    // MapLibre uses a coordinate system where the world is 1x1 unit.
    // Altitude (the 3rd GeoJSON coordinate, in meters) is handled via the 2nd
    // argument of `fromLngLat()`, which itself applies the meters -> Mercator
    // units scaling (non-linear with latitude). We also add GROUND_CLEARANCE_METERS
    // to never coincide exactly with ThreeJsSceneManager's invisible ground plane (Z=0) —
    // avoids z-fighting, even for geometries without altitude ("on the ground").
    const lonLatToMercator = (lon, lat, altitude = 0) => {
      const mc = MercatorCoordinate.fromLngLat({ lng: lon, lat }, altitude)
      const clearance = mc.meterInMercatorCoordinateUnits() * GROUND_CLEARANCE_METERS
      return new THREE.Vector3(mc.x, mc.y, mc.z + clearance)
    }

    const materials = {
      point: new THREE.PointsMaterial({ color: 0xff0000, size: 10 }),
      line: new THREE.LineBasicMaterial({ color: 0x0000ff }),
      polygon: new THREE.MeshBasicMaterial({
        color: 0x00ff00,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.8
      })
    }

    const createPoint = (coord) => {
      const pos = lonLatToMercator(coord[0], coord[1], coord[2] ?? 0)
      const geometry = new THREE.BufferGeometry().setFromPoints([pos])
      return new THREE.Points(geometry, materials.point)
    }

    const createLineString = (coords) => {
      const points = coords.map(c => lonLatToMercator(c[0], c[1], c[2] ?? 0))
      const geometry = new THREE.BufferGeometry().setFromPoints(points)
      return new THREE.Line(geometry, materials.line)
    }

    // Projects a GeoJSON ring (list of [lon, lat, alt?]) onto the Mercator
    // X/Y plane only — altitude is handled separately, per vertex, in the
    // final positions below.
    const ringToPoints2D = (ring) => ring.map(c => {
      const mc = MercatorCoordinate.fromLngLat({ lng: c[0], lat: c[1] }, 0)
      return new THREE.Vector2(mc.x, mc.y)
    })

    // `THREE.ShapeUtils.triangulateShape()` — the same earcut-based
    // triangulator `ShapeGeometry` uses internally — expects an outer
    // contour in clockwise order and holes in counter-clockwise order (the
    // same normalization `ShapeGeometry.addShape()` applies internally).
    // The same rule is applied here, reversing the GeoJSON ring AND its
    // projected points together so they stay index-aligned downstream.
    const normalizeRingWinding = (ring, points, wantClockwise) => {
      if (THREE.ShapeUtils.isClockWise(points) !== wantClockwise) {
        return { ring: ring.slice().reverse(), points: points.slice().reverse() }
      }
      return { ring, points }
    }

    const createPolygon = (coords) => {
      const outer = normalizeRingWinding(coords[0], ringToPoints2D(coords[0]), true)
      const holes = coords.slice(1).map(ring => normalizeRingWinding(ring, ringToPoints2D(ring), false))

      // Purely 2D (X/Y) triangulation — draping comes only from each
      // vertex's own Z, applied below; the triangles themselves stay those
      // of a flat triangulation, which is the standard approach for
      // draping a surface onto terrain (the same principle MapLibre and
      // GIS tools use).
      const faces = THREE.ShapeUtils.triangulateShape(outer.points, holes.map(h => h.points))

      // Same concatenation order assumed by the indices returned by
      // triangulateShape(): the outer contour first, then each hole in
      // sequence.
      const allCoords = [outer.ring, ...holes.map(h => h.ring)].flat()

      const positions = new Float32Array(allCoords.length * 3)
      allCoords.forEach((c, i) => {
        const vertex = lonLatToMercator(c[0], c[1], c[2] ?? 0)
        positions[i * 3] = vertex.x
        positions[i * 3 + 1] = vertex.y
        positions[i * 3 + 2] = vertex.z
      })

      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geometry.setIndex(faces.flat())
      geometry.computeVertexNormals()

      return new THREE.Mesh(geometry, materials.polygon)
    }

    // 4. Recursive geometry parsing function
    const parseGeometry = (geom) => {
      const geomGroup = new THREE.Group()

      switch (geom.type) {
        case 'Point': geomGroup.add(createPoint(geom.coordinates)); break
        case 'MultiPoint': geom.coordinates.forEach(c => geomGroup.add(createPoint(c))); break
        case 'LineString': geomGroup.add(createLineString(geom.coordinates)); break
        case 'MultiLineString': geom.coordinates.forEach(c => geomGroup.add(createLineString(c))); break
        case 'Polygon': geomGroup.add(createPolygon(geom.coordinates)); break
        case 'MultiPolygon': geom.coordinates.forEach(c => geomGroup.add(createPolygon(c))); break
        case 'GeometryCollection': geom.geometries.forEach(g => geomGroup.add(parseGeometry(g))); break
      }
      return geomGroup
    }

    // 5. Processing the GeoJSON document
    if (geojson.type === 'FeatureCollection') {
      geojson.features.forEach(feature => {
        if (feature.geometry) {
          const mesh = parseGeometry(feature.geometry)
          mesh.userData = feature.properties || {}
          mainGroup.add(mesh)
        }
      })
    } else if (geojson.type === 'Feature') {
      if (geojson.geometry) {
        const mesh = parseGeometry(geojson.geometry)
        mesh.userData = geojson.properties || {}
        mainGroup.add(mesh)
      }
    } else {
      mainGroup.add(parseGeometry(geojson))
    }

    const debugLon = 0
    const debugLat = 0

    // In Mercator, the whole world is 1x1 — this makes a 0.1 cube (10% of the world).
    const debugSize = 0.1
    const debugPos = lonLatToMercator(debugLon, debugLat, 0)

    const debugGeometry = new THREE.BoxGeometry(debugSize, debugSize, debugSize)
    const debugMaterial = new THREE.MeshBasicMaterial({
      color: 0xff0000,
      transparent: true,
      opacity: 0.5,
      wireframe: true // Lets the camera see through it when positioned inside
    })
    const debugCube = new THREE.Mesh(debugGeometry, debugMaterial)

    // Positionnement et ajout au groupe principal
    debugCube.position.copy(debugPos)
    mainGroup.add(debugCube)
    console.log('[ThreeJsLayerAdapter] Debug cube added at:', debugPos, 'Size:', debugSize)

    return mainGroup
  }
}

/**
 * `ThreeJsLayerAdapter` mixed with `NDimensionalMixin`'s coordinate/level/
 * variable API. Used by `LayerFactory` for `kazarr://` vector layers (3D side).
 */
export class NDimensionalThreeJsLayerAdapter extends NDimensionalMixin(ThreeJsLayerAdapter) { }
