---
title: maplibre-layers
description: Layer management for Kalisio map engine based on MapLibre
---

# maplibre-layers

_Layer management for Kalisio map engine based on MapLibre_

## Overview

`maplibre-layers` turns a business **layer definition** (a plain JS object — id, type, url/data, style, filters, temporal config...) into the right combination of MapLibre GL JS sources/layers, Three.js objects, or deck.gl layers, and keeps it all in sync as the user changes the current time, toggles filters, or switches between 2D and 3D rendering.

It exposes a single class, [`LayerManager`](#layermanager), orchestrated by `MapEngine` (`@kalisio/maplibre-core`) — nothing else in this package is meant to be imported directly by a host application. See **[Architecture](/packages/maplibre-layers/architecture)** for how `LayerManager` builds and wires up everything else internally (`Layer`, `LayerAdapter`, the per-engine adapters, `ThreeJsSceneManager`, `DeckGlManager`, the context objects, and the internal event bus) — this page covers the package's public surface and the layer definitions it accepts.

## Installation

Install with your preferred package manager:

::: code-group

```bash [pnpm]
pnpm add @kalisio/maplibre-layers
```

```bash [npm]
npm install @kalisio/maplibre-layers
```

```bash [yarn]
yarn add @kalisio/maplibre-layers
```

:::

## Public exports

```js
import { LayerManager, EngineContext, INTERNAL_EVENTS } from '@kalisio/maplibre-layers'
```

- **`LayerManager`** — instantiated once by `MapEngine`, with an `EngineContext`. Not meant to be constructed by a host application directly.
- **`EngineContext`** — the narrow, read-only view of engine state (`isRenderMode2D()`, `getTime()`, `getAppDefaultStyle()`) that `MapEngine` builds around its `StateManager` before handing it to `LayerManager`.
- **`INTERNAL_EVENTS`** — the names of the events exchanged over MapLibre's native event bus between engine subsystems (currently `RENDER_MODE_CHANGED` and `LAYER_DATA_UPDATED`). A host application should never need these — they're exported so `MapEngine` can emit `RENDER_MODE_CHANGED` without duplicating the string literal.

Everything else — `Layer`, `LayerAdapter` and its subclasses, `LayerFactory`, `AdapterContext`, `ThreeJsSceneManager`, `DeckGlManager`, the providers, the temporal strategies — is an internal implementation detail.

## Supported layer types

Set via `definition.type` in the object passed to `MapEngine.addLayer()`.

| `type` | Renders via | Notes |
|---|---|---|
| `vector` | `VectorLayerAdapter` (2D) + `ThreeJsLayerAdapter` (3D) | GeoJSON sources. Supports per-filter styling and clustering (`definition.cluster`). If `definition.url` uses the `kazarr://` protocol, uses the N-dimensional variants instead (see below). |
| `raster` | `MapLibreLayerAdapter` (2D only) | Standard raster tile source (`definition.tiles`). |
| `raster-dem` | `MapLibreLayerAdapter` (2D only) | Hillshade rendering from a raster-dem source. |
| `point-cloud` | `DeckGlLayerAdapter` (3D only) | Rendered as a deck.gl `Tile3DLayer` via the shared `DeckGlManager`. |
| `mesh` | `DeckGlLayerAdapter` (3D only) | ⚠️ Not implemented yet — `DeckGlLayerAdapter._createMeshLayer()` throws; wiring `@deck.gl/mesh-layers`' `ScenegraphLayer` is still a TODO. |

::: warning wms is not currently routed
`MapLibreLayerAdapter` has working WMS support (`_addWmsLayer()`), but `LayerFactory.createLayer()`'s `switch` on `definition.type` has no `case 'wms'` — a `{ type: 'wms', ... }` definition is silently given neither a 2D nor a 3D adapter today. This is a known gap, not a documented feature — flagged here rather than hidden.
:::

### Data sources

A layer definition can either embed `data` directly, or declare a `url`/`format` that resolves to a **provider**:

| Provider | Triggered by | Used for |
|---|---|---|
| `KazarrProvider` | `url` starting with `kazarr://` | N-dimensional gridded data (Zarr) served by a Kazarr endpoint — supports spatial/temporal/level slicing, `variable(s)`, interpolation options. |
| `KmlProvider` | `url` starting with `kml://`, or `format: 'kml'` | KML files, parsed to GeoJSON via `@loaders.gl/kml`. |

A `kazarr://` vector layer additionally gets `NDimensionalVectorLayerAdapter`/`NDimensionalThreeJsLayerAdapter`, which add `setLevel()`, `getVariables()`, `getCoordinates()`, `getCoordinate()` — surfaced on `MapEngine` as `setLayerLevel()`, `getVariables()`, `getCoordinates()`, `getCoordinate()`.

### Temporal updates

When `MapEngine.setTime()` targets a layer with a `definition.temporal` block, the layer picks a strategy based on its type (or `definition.temporalStrategy` if set explicitly):

| Strategy | Used for | Mechanism |
|---|---|---|
| `filter` | `vector` (non-Kazarr) | Composes a MapLibre GL filter expression from the temporal window and re-applies it via `map.setFilter()` — no network request. |
| `raster-url` | `raster`, `raster-dem`, `wms` | Substitutes `{time}` in `definition.temporal.urlTemplate` and calls `source.setTiles()`; MapLibre cross-fades the tiles automatically. |
| `set-data` | `point-cloud`, `mesh`, Kazarr-backed `vector` | Reloads the layer's provider for the new instant and pushes the result via `source.setData()`. |

### Filters

`definition.filters` declares named business sub-filters, each with an `id`, an `expression` (a MapLibre filter expression), and optionally a per-filter `style`. Toggle one at runtime with `MapEngine.setFilterActive(layerId, filterId, active)`.

## Ordering

`LayerManager` also exposes layer z-ordering helpers used internally by the host application's layer list UI: `getLayersOrder(map)`, `moveLayerOnTop(map, layerId)`, `moveLayerOnBottom(map, layerId)`, `moveLayerOver(map, layerId, targetLayerId)`, `moveLayerUnder(map, layerId, targetLayerId)`.
