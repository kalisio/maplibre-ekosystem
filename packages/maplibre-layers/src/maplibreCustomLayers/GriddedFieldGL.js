/**
 * @file GriddedFieldGL.js
 * @description Shared GLSL shaders, WebGL helpers, and Kazarr `format=mesh`
 * response parsing used by BOTH GPU-mesh gridded-field renderings —
 * `GriddedFieldMeshLayer.js` (one mesh per viewport) and
 * `GriddedFieldTiledMeshLayer.js` (one mesh per z/x/y tile). Factored out
 * here instead of duplicated a third time so a future fix to the
 * `format=mesh` shape assumption (still UNCONFIRMED against a real Kazarr
 * response — see either file's header) only needs to happen once.
 */

export const VERTEX_SHADER_SRC = `
  attribute vec3 a_position;
  attribute float a_value;

  uniform mat4 u_matrix;
  uniform float u_min_value;
  uniform float u_max_value;

  varying float v_t;     // normalized value [0..1]
  varying float v_valid; // 1.0 = has data, 0.0 = missing

  const float MISSING = -1.0e10;

  void main() {
    v_valid = (a_value > MISSING) ? 1.0 : 0.0;

    float range = u_max_value - u_min_value;
    if (range > 0.0 && v_valid > 0.5) {
      v_t = clamp((a_value - u_min_value) / range, 0.0, 1.0);
    } else {
      v_t = 0.0;
    }

    gl_Position = u_matrix * vec4(a_position, 1.0);
  }
`

export const FRAGMENT_SHADER_SRC = `
  precision mediump float;

  varying float v_t;
  varying float v_valid;

  uniform sampler2D u_colormap;
  uniform float u_opacity;

  void main() {
    if (v_valid < 0.5) {
      discard;
    }

    vec4 color = texture2D(u_colormap, vec2(v_t, 0.5));
    gl_FragColor = vec4(color.rgb, color.a * u_opacity);
  }
`

/** Sentinel fed to the GPU for "no data at this vertex" (see shader above). */
export const MISSING_VALUE = -1e10

/**
 * Same diverging blue/white/red default used by `GriddedFieldProtocol.js`
 * and `DeckGlLayerAdapter`'s mesh helper, for visual consistency across the
 * gridded/mesh rendering paths in this codebase.
 */
export const DEFAULT_COLOR_RANGE = ['#2166ac', '#f7f7f7', '#b2182b']

/**
 * @param {string} hex e.g. `'#2166ac'`
 * @returns {[number, number, number]}
 */
export const hexToRgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * WGS84 lon/lat/altitude(m) -> MapLibre's normalized Web Mercator [0..1]
 * coordinate space (x: west->east, y: north->south), matching the `u_matrix`
 * a MapLibre `'custom'` GL layer receives in `render()`.
 * @param {number} lng
 * @param {number} lat
 * @param {number} [alt] meters
 * @returns {[number, number, number]}
 */
export function lngLatToMercator (lng, lat, alt = 0) {
  const x = (lng + 180) / 360
  const sinLat = Math.sin((lat * Math.PI) / 180)
  const clampedSin = Math.max(-0.9999, Math.min(0.9999, sinLat))
  const y = 0.5 - Math.log((1 + clampedSin) / (1 - clampedSin)) / (4 * Math.PI)
  const z = alt / (2 * Math.PI * 6378137)
  return [x, y, z]
}

/**
 * @param {WebGLRenderingContext} gl
 * @param {number} type `gl.VERTEX_SHADER` | `gl.FRAGMENT_SHADER`
 * @param {string} source
 * @param {string} [label] included in error logs, e.g. the owning layer's id
 * @returns {WebGLShader | null}
 */
export function compileShader (gl, type, source, label = '') {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const typeName = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'
    console.error(`[GriddedFieldGL]${label ? ` "${label}":` : ''} ${typeName} shader compile error:`, gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

/**
 * @param {WebGLRenderingContext} gl
 * @param {string} vsSource
 * @param {string} fsSource
 * @param {string} [label]
 * @returns {WebGLProgram | null}
 */
export function createShaderProgram (gl, vsSource, fsSource, label = '') {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource, label)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource, label)
  if (!vs || !fs) return null

  const program = gl.createProgram()
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(`[GriddedFieldGL]${label ? ` "${label}":` : ''} shader link error:`, gl.getProgramInfoLog(program))
    gl.deleteProgram(program)
    return null
  }

  gl.deleteShader(vs)
  gl.deleteShader(fs)
  return program
}

/**
 * Builds a 256x1 RGBA texture, linearly interpolated across `colorRange`
 * (2+ hex colors) — sampled as a 1D LUT by the fragment shader.
 * @param {WebGLRenderingContext} gl
 * @param {string[]} colorRange
 * @returns {WebGLTexture}
 */
export function createColormapTexture (gl, colorRange) {
  const WIDTH = 256
  const pixels = new Uint8Array(WIDTH * 4)
  const stops = colorRange.map(hexToRgb)
  const n = stops.length - 1

  for (let i = 0; i < WIDTH; i++) {
    const t = i / (WIDTH - 1)
    const fi = t * n
    const idx = Math.min(Math.floor(fi), n - 1)
    const f = fi - idx
    const c0 = stops[idx]
    const c1 = stops[Math.min(idx + 1, n)]

    pixels[i * 4 + 0] = Math.round(c0[0] + f * (c1[0] - c0[0]))
    pixels[i * 4 + 1] = Math.round(c0[1] + f * (c1[1] - c0[1]))
    pixels[i * 4 + 2] = Math.round(c0[2] + f * (c1[2] - c0[2]))
    pixels[i * 4 + 3] = 255
  }

  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, WIDTH, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_2D, null)

  return texture
}

/**
 * Detects whether 32-bit triangle indices can be used (needed once a mesh
 * exceeds 65535 vertices) — `true` on WebGL2, or WebGL1 with the
 * `OES_element_index_uint` extension.
 * @param {WebGLRenderingContext} gl
 * @returns {boolean}
 */
export function supportsUint32Indices (gl) {
  const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext
  return isWebGL2 || !!gl.getExtension('OES_element_index_uint')
}

/**
 * Parses a Kazarr `format=mesh` response into GPU-ready typed arrays.
 *
 * @param {{ vertices: number[], indices: number[], values: (number|null)[] }} response
 * @param {boolean} useUint32Indices
 * @returns {{ positions: Float32Array, values: Float32Array, indices: Uint16Array | Uint32Array, min: number, max: number } | null}
 * `null` if the response doesn't look like a mesh at all (missing/wrong-typed fields).
 */
export function meshResponseToTypedArrays (response, useUint32Indices) {
  const { vertices, indices, values } = response || {}
  if (!Array.isArray(vertices) || !Array.isArray(indices) || !Array.isArray(values)) {
    return null
  }

  const dim = 3 // lon, lat, altitude per vertex
  const numVertices = Math.floor(vertices.length / dim)

  const positions = new Float32Array(numVertices * 3)
  for (let i = 0; i < numVertices; i++) {
    const [mx, my, mz] = lngLatToMercator(vertices[i * dim], vertices[i * dim + 1], vertices[i * dim + 2] || 0)
    positions[i * 3] = mx
    positions[i * 3 + 1] = my
    positions[i * 3 + 2] = mz
  }

  const sanitizedValues = new Float32Array(numVertices)
  let min = Infinity; let max = -Infinity
  for (let i = 0; i < numVertices; i++) {
    const v = values[i]
    const finite = v !== null && v !== undefined && Number.isFinite(v)
    sanitizedValues[i] = finite ? v : MISSING_VALUE
    if (finite) {
      if (v < min) min = v
      if (v > max) max = v
    }
  }

  const typedIndices = useUint32Indices ? Uint32Array.from(indices) : Uint16Array.from(indices)

  return { positions, values: sanitizedValues, indices: typedIndices, min, max }
}
