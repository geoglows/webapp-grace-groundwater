import "@arcgis/core/assets/esri/themes/light/main.css";
import "./style.css";

import "@arcgis/map-components/components/arcgis-map";
import "@arcgis/map-components/components/arcgis-layer-list";
import "@arcgis/map-components/components/arcgis-locate";
import "@arcgis/map-components/components/arcgis-scale-bar";
import GeoJSONLayer from "@arcgis/core/layers/GeoJSONLayer.js";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer.js";
import SketchViewModel from "@arcgis/core/widgets/Sketch/SketchViewModel.js";
import * as reactiveUtils from "@arcgis/core/core/reactiveUtils.js";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import Graphic from "@arcgis/core/Graphic.js";
import SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
import * as intersectionOperator from "@arcgis/core/geometry/operators/intersectionOperator.js";
import * as shapePreservingProjectOperator from "@arcgis/core/geometry/operators/shapePreservingProjectOperator.js";
import * as geodeticAreaOperator from "@arcgis/core/geometry/operators/geodeticAreaOperator.js";

import {get} from "zarrita";

import {cellPolygonFromCenter} from "./cells.js";
import {MASCONS_URL, REGION_SETS_URL, ZARR_URL, ZARR_URL_HALF_DEGREE, regionSetUrl} from "./config.js";
import {clearCacheDB, getOrFetchCoords} from "./db.js";
import {loadGlobalVariable} from "./globalFramesClient.js";
import {createGlobalRenderer} from "./globalLayer.js";
import {hydrateIcons} from "./icons.js";
import Polygon from "@arcgis/core/geometry/Polygon.js";
import {parseGeoJSONFile} from "./polygonUploads.js";
import {deleteUserRegion, listUserRegions, newUserRegionId, putUserRegion} from "./userRegions.js";
import {INSUFFICIENT, TREND_CATEGORIES, classify, computeFit, computeSlope, fitEndpoints, perCellSlopes, regionMeanSeries} from "./trends.js";
import {createTimeControl} from "./timeControl.js";
import {
  COLOR_PALETTES,
  DEFAULT_VIEW,
  DISPLAY_DEFAULTS,
  TREND_MIN_MONTHS,
  TREND_THRESHOLDS,
  GLOBAL_PLAY_RATE_MS,
  MAP_BASEMAP,
  MAP_CENTER,
  MAP_ZOOM,
  paletteCssGradient,
  PREFETCH_VARIABLES,
  REGIONAL_PLAY_RATE_MS,
  UNITS,
  VALUE_LABEL,
  VARIABLES,
} from "./settings.js";
import {initPanelSplitter} from "./splitPanels.js";
import {renderTimeseriesChart, seriesToCsv} from "./timeseriesChart.js";
import {pruneStaleCache} from "./db.js";
import {openZarrArray} from "./zarrStore.js";

hydrateIcons();  // heroicons

// Clear out entries from an earlier DATA_VERSION. Fire and forget: nothing
// waits on it, and failing leaves the old rows rather than breaking the load.
pruneStaleCache().catch((err) => console.warn("Could not prune the cache", err));

// Branding (logo, its link, its alt text) is not set here: index.html carries it
// as %VITE_*% template strings that Vite substitutes at build time.

const displayConfig = {...DISPLAY_DEFAULTS};

// Variables the user has added to the chart beyond the displayed layer, which is
// always plotted. A display preference like the palette: it outlives one region
// and follows the user to the next.
const extraSeries = new Set();

// The displayed layer first — renderTimeseriesChart treats that position as the
// one the map agrees with — then the extras in the order VARIABLES declares, so
// the legend does not reshuffle as they are toggled.
const plottedVariables = () => [
  displayConfig.variable,
  ...Object.keys(VARIABLES).filter((k) => k !== displayConfig.variable && extraSeries.has(k)),
];

// Generate color stops scaled to max value (dynamic or fixed based on toggle)
// Stops for a symmetric +/-maxVal range in `unit`. The palette is the same
// either way; only the numbers on it change, which is what lets the trend map
// reuse the anomaly color bar.
const stopsFor = (maxVal, unit, {decimals = 0} = {}) => {
  const {stops} = COLOR_PALETTES[displayConfig.colorPalette];
  return stops.map(({position, color}) => {
    const value = Number((position * maxVal).toFixed(decimals));
    const label = value === 0 ? "0" : `${value} ${unit}`;
    return {value, color, label};
  });
};

const generateStops = () => {
  const maxVal = displayConfig.dynamicColorScale ? displayConfig.maxValue : displayConfig.fixedMaxValue;
  return stopsFor(maxVal, UNITS);
};

/**
 * Stops that draw the five trend categories as flat bands rather than a ramp,
 * so the global per-cell map uses the same colors and the same class boundaries
 * as the region classification.
 *
 * buildLut interpolates between adjacent stops, so each boundary gets a pair a
 * hair apart: the band's color right up to the threshold, the next band's color
 * immediately after. Beyond the outermost stops the lookup clamps, which is
 * what gives the two "extreme" classes their open ends.
 */
const trendCategoryStops = () => {
  const {moderate, extreme} = TREND_THRESHOLDS;
  const color = (key) => TREND_CATEGORIES.find((c) => c.key === key).color;
  const EPS = 1e-4;
  const outer = extreme * 1.5; // anything past this clamps to the extreme color
  return [
    {value: -outer, color: color("extreme-decline")},
    {value: -extreme, color: color("extreme-decline")},
    {value: -extreme + EPS, color: color("decline")},
    {value: -moderate, color: color("decline")},
    {value: -moderate + EPS, color: color("static")},
    {value: moderate, color: color("static")},
    {value: moderate + EPS, color: color("increase")},
    {value: extreme, color: color("increase")},
    {value: extreme + EPS, color: color("extreme-increase")},
    {value: outer, color: color("extreme-increase")},
  ];
};

// Map elements
const arcgisMap = document.querySelector("arcgis-map");
// The basemaps the picker offers, in aquiferx's order and under its names. The
// ids are ArcGIS's own, so switching is an assignment rather than a tile-layer
// swap — aquiferx has to name the tile URLs because Leaflet has no equivalent.
const BASEMAPS = [
  {id: "osm", label: "OpenStreetMap"},
  {id: "topo-vector", label: "Topographic (Esri)"},
  {id: "satellite", label: "Imagery (Esri)", dark: true},
  {id: "streets-vector", label: "Streets (Esri)"},
  {id: "gray-vector", label: "Light Gray (Esri)"},
  {id: "dark-gray-vector", label: "Dark Gray (Esri)", dark: true},
  {id: "terrain", label: "Terrain (Esri)"},
];

// Imagery is a dark, busy ground: the blue the outlines use over a pale basemap
// disappears into it. Everything the app draws on the map picks its colors from
// this rather than assuming a light background.
const isDarkBasemap = (id) => BASEMAPS.find((b) => b.id === id)?.dark ?? false;
// Tracked rather than read back from arcgisMap.basemap, which normalizes the id
// it is assigned into a Basemap instance — there is no id left to compare.
let darkBasemap = isDarkBasemap(MAP_BASEMAP);

// Drawing is a SketchViewModel behind our own button rather than <arcgis-sketch>:
// the widget's toolbar carried a selection arrow, five polygon drawing modes, an
// undo/redo pair and a snapping menu, and only the mode picker can't be switched
// off through a hide* property. Owning the button is the only way to one button.
const drawLayer = new GraphicsLayer({title: "User drawn polygons", listMode: "hide"});
// Uploaded regions live apart from the sketch layer: a sketch is scratch work
// that the next one replaces, an upload is kept and belongs beside the built-in
// outlines. resetLayers clears the first and leaves this one alone, which is why
// an upload used to vanish on the way Home.
const uploadedLayer = new GraphicsLayer({title: "Uploaded regions", listMode: "hide"});
// The one cell picked out of the whole-world raster. Its own layer so clearing
// it never disturbs a sketch or an uploaded outline.
const cellPickLayer = new GraphicsLayer({title: "Selected cell", listMode: "hide"});

// Green, so an upload stands apart from the built-in outlines (blue, or amber
// over imagery) and from a sketch (cyan). The list rows use the same hue.
const uploadedSymbolFor = (dark) => ({
  type: "simple-fill",
  color: dark ? [74, 222, 128, 0.16] : [34, 197, 94, 0.14],
  outline: {color: dark ? [134, 239, 172, 0.95] : [21, 128, 61, 0.95], width: 1.5},
});
// Shared by the sketch and by an uploaded boundary — both are "the polygon this
// analysis is for", so both are drawn the same way.
const drawnSymbol = {
  type: "simple-fill",
  color: [56, 189, 248, 0.15],
  outline: {color: [56, 189, 248, 0.9], width: 2},
};
const zoomControl = document.getElementById("zoom-control");
const zoomInButton = document.getElementById("zoom-in");
const zoomOutButton = document.getElementById("zoom-out");
const basemapControl = document.getElementById("basemap-control");
const basemapButton = document.getElementById("basemap-button");
const basemapMenu = document.getElementById("basemap-menu");
const drawControl = document.getElementById("draw-control");
const drawButton = document.getElementById("draw-button");
const drawLabel = drawButton.querySelector("[data-draw-label]");
let sketch = null; // created once the view exists (bootMapUi)
const timeControlRoot = document.getElementById("time-control");
// Built on first use rather than at module load: its index space is the full
// date list, which only exists after the store's time axis has been read.
let timeControl = null;
const timeseriesPlotDiv = document.getElementById("timeseries-plot");
const appInstructions = timeseriesPlotDiv.innerHTML;

// The same centred prompt the panel ships with, for the other things the panel
// has to say. Built from a template rather than repeated so the styling of an
// empty chart panel lives in index.html and nowhere else.
const panelPrompt = (text) =>
  appInstructions.replace(/>[^<>]+</, `>${text}<`);
const GLOBAL_PROMPT = panelPrompt("Select a cell to view time series");

arcgisMap.basemap = MAP_BASEMAP;
arcgisMap.center = MAP_CENTER;

// The draggable divider between the map and the chart. Owns the visibility of
// the chart panel from here on: showing or hiding it any other way would leave
// the divider floating under a map with nothing beneath it.
const panels = initPanelSplitter({
  stack: document.getElementById("panel-stack"),
  chartPanel: timeseriesPlotDiv,
  splitter: document.getElementById("panel-splitter"),
});

// The Chart.js instance currently occupying the timeseries panel, or null. Held
// at module scope because the panel is torn down from several unrelated places
// (entering the global view, resetting, a failed variable load); replacing its
// innerHTML without destroying the chart would orphan a live Chart.js instance
// along with its resize observer.
let activeChart = null;
const clearTimeseriesPanel = (html = "") => {
  activeChart?.destroy();
  activeChart = null;
  timeseriesPlotDiv.innerHTML = html;
};
// Settings modal
const settingsModal = document.getElementById("settings-modal");
const borderToggle = document.getElementById("border-toggle");
const borderWidthSlider = document.getElementById("border-width");
const borderWidthValue = document.getElementById("border-width-value");
const dynamicScaleToggle = document.getElementById("dynamic-scale-toggle");
const dynamicScaleNote = document.getElementById("dynamic-scale-note");
const legendToggle = document.getElementById("legend-toggle");
const seriesToggles = document.getElementById("series-toggles");
const trendsButton = document.getElementById("trends-button");
const trendWindowField = document.getElementById("trend-window");
const trendWindowSelect = document.getElementById("trend-window-select");
const trendsLabel = document.querySelector("[data-trends-label]");
const trendLegendDiv = document.getElementById("trend-legend");
const trendLegendTitle = document.getElementById("trend-legend-title");
const trendLegendSub = document.getElementById("trend-legend-sub");
const trendLegendRows = document.getElementById("trend-legend-rows");
const regionSetSelect = document.getElementById("region-set-select");
const regionAttribution = document.getElementById("region-attribution");
const regionList = document.getElementById("region-list");
const regionFilter = document.getElementById("region-filter");
const breadcrumb = document.getElementById("breadcrumb");
const crumbHome = document.getElementById("crumb-home");
const regionNamesToggle = document.getElementById("region-names-toggle");
const masconToggle = document.getElementById("mascon-toggle");
const masconWidthSlider = document.getElementById("mascon-width");
const masconWidthValue = document.getElementById("mascon-width-value");
const opacitySlider = document.getElementById("opacity-slider");
const opacityValue = document.getElementById("opacity-value");
const paletteSelect = document.getElementById("palette-select");
const palettePreview = document.getElementById("palette-preview");
const fillGapsToggle = document.getElementById("fill-gaps-toggle");

// Build the two lists that are generated from data rather than written out in
// index.html — the layer dropdown from VARIABLES, the palette radios from
// COLOR_PALETTES — then put every control in the settings modal at the value
// .env asked for. Called once, before anything listens for changes.
const syncSettingsControls = () => {
  variableSelect.replaceChildren(
    ...Object.entries(VARIABLES).map(([key, {longName}]) => {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = `${longName} (${key})`;
      return option;
    }),
  );
  variableSelect.value = displayConfig.variable;

  paletteSelect.replaceChildren(
    ...Object.entries(COLOR_PALETTES).map(([key, {label}]) => {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = label;
      return option;
    }),
  );
  paletteSelect.value = displayConfig.colorPalette;
  palettePreview.style.background = paletteCssGradient(displayConfig.colorPalette);

  seriesToggles.replaceChildren(
    ...Object.entries(VARIABLES).map(([key, {color}]) => {
      const row = document.createElement("label");
      row.className = "rfs-check";

      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = key;
      box.dataset.series = key;

      const swatch = document.createElement("span");
      swatch.className = "rfs-check-swatch";
      swatch.style.background = color;

      const name = document.createElement("span");
      name.textContent = key;

      row.append(box, swatch, name);
      return row;
    }),
  );

  opacitySlider.value = String(displayConfig.opacity);
  opacityValue.textContent = `${Math.round(displayConfig.opacity * 100)}%`;
  borderToggle.checked = displayConfig.showBorders;
  borderWidthSlider.value = String(displayConfig.borderWidth);
  borderWidthValue.textContent = `${displayConfig.borderWidth}px`;
  legendToggle.checked = displayConfig.showLegend;
  regionNamesToggle.checked = displayConfig.showRegionNames;
  masconToggle.checked = displayConfig.showMascons;
  fillGapsToggle.checked = displayConfig.fillGaps;
  masconWidthSlider.value = String(displayConfig.masconWidth);
  masconWidthValue.textContent = `${displayConfig.masconWidth}px`;
  dynamicScaleToggle.checked = displayConfig.dynamicColorScale;
  // The fixed range is configurable, so the sentence explaining it has to be too.
  dynamicScaleNote.textContent = `When enabled, the color scale fits the actual min/max values in the selected region, with 0 always shown as the center color. When disabled, uses a fixed range of -${displayConfig.fixedMaxValue} to +${displayConfig.fixedMaxValue} ${UNITS}.`;
};

// The displayed layer is checked and locked: the chart always carries what the
// map is showing, and a box that could turn it off would be lying.
const syncSeriesToggles = () => {
  for (const box of seriesToggles.querySelectorAll("[data-series]")) {
    const key = box.dataset.series;
    const isDisplayed = key === displayConfig.variable;
    box.checked = isDisplayed || extraSeries.has(key);
    box.disabled = isDisplayed;
    box.title = isDisplayed ? "The displayed layer is always plotted" : "";
  }
};

// Which of the two resolutions the app is currently reading. Every zarr read,
// every IndexedDB cache key, and every derived quantity (cell size, the raster's
// georeferencing) follows this, so the 1.0 and 0.5 degree stores never mix —
// and switching back to one already loaded costs nothing but a cache hit.
// Two frames: one for the browser to lay out the chart panel that exitGlobalView
// just revealed, one for the view's resize observer to pick up its new size.
const afterLayout = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

// Hand the browser a turn so it can paint. setTimeout rather than
// requestAnimationFrame: rendering happens between tasks, and a rAF callback
// resumes *before* the paint it was waiting for, so rAF would yield the frame
// without ever letting one be drawn.
const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));
// How long a synchronous slice may run before giving the renderer a turn. Above
// a frame's worth of work the map visibly stops moving.
const SLICE_MS = 12;

// Resolution is a property of the variable (see VARIABLES in settings.js), so
// the store a read goes to follows from what is being read rather than from any
// setting. Both stores carry the same 290 month time axis and their grids nest,
// which is what lets one analysis mix them.
const ZARR_URLS = {"1.0": ZARR_URL, "0.5": ZARR_URL_HALF_DEGREE};
const RESOLUTIONS = Object.keys(ZARR_URLS);
const resolutionOf = (varName) => VARIABLES[varName].resolution;
const zarrUrlFor = (resolution) => ZARR_URLS[resolution];
// The grid the map's raster is drawn on: whichever the displayed layer uses.
const displayedResolution = () => resolutionOf(displayConfig.variable);

// Cell boundaries for the global raster: the same black-on-pale, white-on-dark
// rule the regional cells follow, at partial opacity so the grid reads as edges
// between cells rather than as a mesh drawn over them.
const globalBorderConfig = () => ({
  show: displayConfig.showBorders,
  width: displayConfig.borderWidth,
  color: darkBasemap ? [255, 255, 255, 0.5] : [0, 0, 0, 0.5],
});
// Both stores carry the same 290 month axis, so the time array is read from one
// of them rather than once per grid.
const TIME_RESOLUTION = "1.0";

const openArray = (name, resolution) => openZarrArray(zarrUrlFor(resolution), name);

// ---- Lazily-loaded shared inputs -------------------------------------------
// NOTHING in this module may sit at the top level behind `await`. A module with
// a top-level await runs its whole body only after that await settles, so a
// slow or failing network call would prevent the rest of the file — including
// the arcgisViewReadyChange listener that wires up every button and starts the
// initial load — from ever executing. That produced exactly the "map and
// stylesheets render but the progress bar never appears and nothing recovers"
// state: the app was structurally unable to reach its own bootstrap code.
// Instead each shared input is a memoized promise that clears itself on
// failure, so pressing the globe button retries it.

const coordsPromises = {};
const ensureCoords = (resolution) => {
  coordsPromises[resolution] ??= getOrFetchCoords({zarrUrl: zarrUrlFor(resolution)}).catch((err) => {
    delete coordsPromises[resolution];
    delete geoPromises[resolution];
    throw err;
  });
  return coordsPromises[resolution];
};

// Grid origin derived from the coordinate arrays; needed by the renderer to
// georeference the raster and by the workers to pick preview time steps.
const geoPromises = {};
const ensureGeo = (resolution) => {
  geoPromises[resolution] ??= ensureCoords(resolution).then(({lat, lon}) => {
    const cellSize = lat.data[1] - lat.data[0];
    return {cellSize, lat0: lat.data[0], lon0: lon.data[0], latEdgeMin: lat.data[0] - cellSize / 2};
  });
  return geoPromises[resolution];
};

// The time array holds plain numbers; the CF `units` attribute on it is what
// says what they count and from when ("days since 2002-01-01"). Assuming an
// epoch instead of reading this is a silent, total failure — every date in the
// slider, the chart, and the CSV export is simply wrong by the difference
// between the assumed and actual epochs, with nothing anywhere to indicate it.
const TIME_UNIT_MS = {
  days: 86_400_000,
  hours: 3_600_000,
  minutes: 60_000,
  seconds: 1_000,
  milliseconds: 1,
};
const parseTimeUnits = (units) => {
  const match = /^\s*(\w+)\s+since\s+(.+?)\s*$/i.exec(units ?? "");
  if (!match) return null;
  const step = TIME_UNIT_MS[match[1].toLowerCase().replace(/s$/, "") + "s"];
  if (!step) return null;
  // "2002-01-01", "2002-01-01 00:00:00", and the ISO form all appear in the
  // wild. A reference time with no zone is UTC by CF convention, and Date.parse
  // would otherwise read the date-time form as local.
  let stamp = match[2].trim().replace(" ", "T");
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(stamp)) stamp = `${stamp.includes("T") ? stamp : `${stamp}T00:00:00`}Z`;
  const epochMs = Date.parse(stamp);
  return Number.isFinite(epochMs) ? {step, epochMs} : null;
};

// The stored instants are absolute UTC, and the calendar date is the datum: a
// month labelled April 2002 must read as April 2002 in Denver and in Tokyo
// alike. But every renderer downstream formats a Date in the browser's local
// zone — the ArcGIS time slider's labels, and Chart.js ticks and tooltips
// through date-fns — so west of Greenwich 2002-04-01T00:00Z prints as
// "3/31/2002". Each instant is therefore rebased to the local Date holding the
// same wall-clock fields its UTC value had. The true instant is deliberately
// discarded: nothing downstream wants an instant, only the month it names.
//
// Built from the parts rather than by adding a fixed offset on purpose. An
// offset taken once (or taken today) is wrong for every value on the other side
// of a DST boundary, and being an hour out at midnight moves the date a whole
// day. Passing the parts to the local-time constructor makes the engine resolve
// the offset in effect for that particular date.
const toDisplayDate = (ms) => {
  const utc = new Date(ms);
  return new Date(
    utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(),
    utc.getUTCHours(), utc.getUTCMinutes(), utc.getUTCSeconds(),
  );
};

// The shared time axis. `timeDates` is null until ensureTimeDates() resolves;
// every caller that indexes it awaits that first. These are display dates in
// the sense above — read their local fields, never their UTC ones.
let timeDates = null;
let timeDatesPromise = null;
const ensureTimeDates = () => {
  timeDatesPromise ??= (async () => {
    const timeNode = await openArray("time", TIME_RESOLUTION);
    const timeIntegers = await get(timeNode, [null]);
    const units = parseTimeUnits(timeNode.attrs?.units);
    if (!units) {
      // Nothing better to do than the historical assumption, but say so: dates
      // that are quietly wrong are worse than dates that are wrong and logged.
      console.warn(`The time array has no usable "units" attribute (got ${JSON.stringify(timeNode.attrs?.units)}); falling back to days since 2000-01-01, which is very likely wrong.`);
    }
    const {step, epochMs} = units ?? {step: TIME_UNIT_MS.days, epochMs: Date.UTC(2000, 0, 1)};
    timeDates = Array.from(timeIntegers.data).map((t) => toDisplayDate(epochMs + Number(t) * step));
    return timeDates;
  })().catch((err) => {
    timeDatesPromise = null; // allow the globe button to retry
    throw err;
  });
  return timeDatesPromise;
};

// Variable nodes are opened lazily and memoized: a variable listed in the
// dropdown before its arrays exist in the store only errors when displayed.
// A missing <var>_unc array is tolerated (unc: null -> no uncertainty band).
const varNodePromises = {};
const getVarNodes = (varName) => {
  const resolution = resolutionOf(varName);
  varNodePromises[varName] ??= Promise.all([
    openArray(varName, resolution),
    openArray(`${varName}_unc`, resolution).catch(() => null),
  ])
    .then(([value, unc]) => ({value, unc}))
    .catch((err) => {
      delete varNodePromises[varName]; // allow retry once the array exists
      throw err;
    });
  return varNodePromises[varName];
};

// value arrays are int16 with a sentinel fill for missing months -> NaN
const maskFill = (node, {data, shape, stride}) => {
  const fill = node.attrs?._FillValue ?? -9999;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] === fill ? NaN : data[i];
  return {data: out, shape, stride};
};
// A tinted fill with a thin outline, rather than the heavy black outline this
// started with: at world zoom the 81 regions overlap enough that 2px black
// reads as scribble (dense clusters like the US High Plains lose their
// individual shapes entirely). The fill is what makes a region legible when its
// outline is only a few pixels across.
// Amber over imagery rather than a brighter blue: satellite tiles are mostly
// blues and greens, so a warm hue is the one that separates from them at any
// zoom. It is the same hue aquiferx gives its aquifer outlines, for the same
// reason. The outline also thickens slightly — imagery has texture to compete
// with where a flat basemap does not.
const regionSymbolFor = (dark) => ({
  type: "simple-fill",
  color: dark ? [250, 204, 21, 0.10] : [37, 99, 235, 0.12],
  outline: {
    color: dark ? [250, 204, 21, 0.95] : [30, 64, 175, 0.75],
    width: dark ? 1.25 : 1,
  },
});

// Names are drawn by the layer rather than as separate graphics so the SDK's
// label engine handles collisions. minScale is what keeps the map readable:
// collision dropping alone still leaves continent zoom covered in names longer
// than the regions under them, so nothing is labeled until the view is closer
// in than regionLabelMinScale.
// Over imagery the halo inverts: white text on a dark halo, which is how a
// label stays readable when the ground underneath it changes from ocean to
// cloud to desert within one name.
const regionLabelFor = (dark) => ({
  labelExpressionInfo: {expression: "$feature.n"},
  labelPlacement: "always-horizontal",
  minScale: displayConfig.regionLabelMinScale,
  symbol: {
    type: "text",
    color: dark ? [255, 255, 255, 1] : [23, 37, 84, 1],
    haloColor: dark ? [0, 0, 0, 0.85] : [255, 255, 255, 0.95],
    haloSize: 1.5,
    font: {size: 9, weight: "bold"},
  },
});

// Renderers are immutable once assigned, so a basemap change means handing each
// layer a new one rather than editing what it has.
const applyBasemapContrast = (basemapId) => {
  darkBasemap = isDarkBasemap(basemapId);
  // Trends own the region fill while they are showing, so they are recolored
  // rather than replaced.
  boundaryLayer.renderer = trendState.on
    ? (applyTrendRenderer(), boundaryLayer.renderer)
    : {type: "simple", symbol: regionSymbolFor(darkBasemap)};
  boundaryLayer.labelingInfo = [regionLabelFor(darkBasemap)];
  masconLayer.renderer = masconRenderer();
  paintUploadedSymbols();
  if (globalView.renderer) {
    globalView.renderer.setBorders(globalBorderConfig());
    if (globalView.active) globalView.renderer.redraw();
  }
};

// Every set is a separate file, so switching means a new layer rather than a new
// URL on the old one: a GeoJSONLayer infers its fields when it loads, and
// swapping the source under a loaded layer is not something the SDK promises to
// handle. `boundaryLayer` is therefore rebound rather than mutated. Everything
// else in this module reads it when it runs, so nothing holds a stale one.
const makeBoundaryLayer = (url) => new GeoJSONLayer({
  title: "Region Boundaries",
  url,
  outFields: ["*"],
  definitionExpression: "1=1", // start with none selected
  renderer: {type: "simple", symbol: regionSymbolFor(darkBasemap)},
  // Clicking a region analyzes it directly (see the view click handler in
  // init) — the popup this used to open only ever held one button.
  popupEnabled: false,
  labelingInfo: [regionLabelFor(darkBasemap)],
  labelsVisible: displayConfig.showRegionNames,
});

// The sets from the manifest, plus "My Regions" — the uploads, which have no
// file and are drawn from IndexedDB instead.
const MY_REGIONS = {id: "my-regions", label: "My Regions", file: null, attribution: null};
let regionSets = [MY_REGIONS];
let activeRegionSet = MY_REGIONS;

// Starts on My Regions, which needs no network, and is replaced the moment the
// manifest resolves. A layer always exists so nothing has to null-check it.
let boundaryLayer = makeBoundaryLayer(null);

// Swap the outlines to another set. Everything keyed on a region id belongs to
// one set — ids collide across them — so the classification, the cached rings
// and the current selection are all dropped.
// select:false for a caller that is about to analyze something itself — the
// upload flow, which knows exactly which region it wants and would otherwise
// have the auto-select run the same analysis first.
// Which of the two outline layers is showing follows from the active set and
// the active view, and from nothing else. Carrying the previous layer's
// visibility across a switch is what emptied a published set after a visit to
// My Regions: that set hides boundaryLayer, so coming back computed
// "has a file AND was visible" and left it hidden.
const applyOutlineVisibility = () => {
  const showOutlines = !globalView.active; // the whole-world raster covers them
  boundaryLayer.visible = showOutlines && Boolean(activeRegionSet.file);
  uploadedLayer.visible = showOutlines && !activeRegionSet.file;
  // Drawing belongs to My Regions: a sketch is a region of the user's own, and
  // the published sets are not theirs to add to. Hidden rather than disabled,
  // since there is nothing to explain — it simply is not part of those sets.
  drawControl.classList.toggle("hidden", Boolean(activeRegionSet.file) || globalView.active);
  if (activeRegionSet.file && sketch?.state === "active") sketch.cancel();
};

const setRegionSet = async (set, {select = true} = {}) => {
  activeRegionSet = set;
  if (trendState.on) setTrendsOff();
  regionRingsPromise = null;
  setActiveRegion(null);
  setBreadcrumb(null);

  const index = arcgisMap.map?.layers?.indexOf(boundaryLayer) ?? -1;
  const previous = boundaryLayer;
  boundaryLayer = makeBoundaryLayer(set.file ? regionSetUrl(set.file) : null);
  applyOutlineVisibility();
  if (arcgisMap.map) {
    arcgisMap.map.remove(previous);
    // Back where it was, so the mascons and the anomaly raster keep their order.
    if (index >= 0) arcgisMap.map.add(boundaryLayer, index);
    else arcgisMap.map.add(boundaryLayer);
  }

  regionAttribution.textContent = set.attribution ?? "";
  regionAttribution.classList.toggle("hidden", !set.attribution);

  builtinRows = [];
  paintRegionList();
  if (!set.file) {
    // My Regions: nothing to load, the uploads are the set.
    await loadUserRegions();
    if (!firstRegionSet && select) fitOrSelectRegionSet();
    firstRegionSet = false;
    return;
  }
  await boundaryLayer.load();
  await buildRegionList();
  await loadUserRegions();
  // Not on the first load: the app opens on the view VITE_DEFAULT_VIEW asks for,
  // at the camera .env configured, and refitting here would override it.
  if (!firstRegionSet && select) fitOrSelectRegionSet();
  firstRegionSet = false;
};

// The initial set is applied during boot, where the camera belongs to whichever
// view the app opens in.
let firstRegionSet = true;

// The uploads' combined extent, unioned from the graphics themselves.
// GraphicsLayer.fullExtent is not derived from what the layer holds — it is the
// whole world until something sets it — so trusting it zoomed the camera past
// the globe instead of onto the uploads.
const uploadedExtent = () => {
  let union = null;
  for (const graphic of uploadedLayer.graphics) {
    const extent = graphic.geometry?.extent;
    if (!extent) continue;
    union = union ? union.union(extent) : extent.clone();
  }
  return union;
};

// A set with exactly one region analyzes it rather than framing it and waiting
// to be clicked: there is nothing else in the set to choose, so the click would
// only be ceremony. The analysis fits the camera itself, so this replaces the
// fit rather than following it.
const fitOrSelectRegionSet = () => {
  if (regionRows.length === 1) {
    activateRegionRow(regionRows[0]);
    return;
  }
  fitRegionSet();
};

// Frame whatever the new set covers, so switching does not leave the camera
// over a region that is not in it. An empty My Regions has nothing to frame, so
// the camera is left where it is rather than sent somewhere arbitrary.
const fitRegionSet = () => {
  const extent = activeRegionSet.file ? boundaryLayer.fullExtent : uploadedExtent();
  if (!extent) return;
  // A single uploaded region can be small enough that its own extent is a
  // street-level camera, so the fit is floored at a scale that still shows
  // context around it.
  const target = extent.clone().expand(1.1);
  arcgisMap.view?.goTo(target)
    .then(() => {
      if (arcgisMap.view.scale < MIN_FIT_SCALE) arcgisMap.view.scale = MIN_FIT_SCALE;
    })
    .catch(() => {});
};

// ~1:2M, a few counties across: closer than this and a small uploaded polygon
// fills the screen with no idea where on Earth it is.
const MIN_FIT_SCALE = 2_000_000;

// ---- Trend classification --------------------------------------------------
// Every region colored by the slope of its own area-mean series, computed off
// the whole-world frames the global view already downloads rather than by
// running the per-region analysis 81 times. See trends.js for what that trades.
const trendState = {
  on: false,
  running: false,
  // "region" (outlines classified) or "global" (per-cell trend raster). The two
  // belong to different views, so a view change clears whichever does not fit.
  mode: null,
  // varName the showing classification was computed for, so switching the
  // displayed layer recomputes rather than mislabeling.
  varName: null,
  // Years back from the newest month, or null for the whole record. A shorter
  // window answers a different question — what storage has been doing lately,
  // rather than over the mission — and the two can disagree in sign.
  years: null,
  byRegion: new Map(), // region id -> category
};

// Rings per region, queried once. The boundary layer holds them already; this
// pulls them into plain arrays so the point-in-polygon test in trends.js can
// work without the geometry operators.
let regionRingsPromise = null;
const ensureRegionRings = () => {
  regionRingsPromise ??= (async () => {
    // My Regions carries its rings already; the classification reads them from
    // the list rather than from a layer.
    if (!activeRegionSet.file) {
      return userRows.map((r) => ({
        id: r.id,
        name: r.name,
        rings: r.rings,
        extent: ringsExtent(r.rings),
      }));
    }
    await boundaryLayer.load();
    const q = boundaryLayer.createQuery();
    q.where = "1=1";
    q.outFields = ["id", "n"];
    q.returnGeometry = true;
    const {features} = await boundaryLayer.queryFeatures(q);
    return features.map((f) => ({
      id: f.attributes.id,
      name: f.attributes.n,
      rings: f.geometry.rings,
      extent: f.geometry.extent,
    }));
  })().catch((err) => {
    regionRingsPromise = null;
    throw err;
  });
  return regionRingsPromise;
};

// The window offered in the strip. The record starts in 2002-04, so "All" is
// around 24 years and the shorter options are the ones that fit inside it.
const TREND_WINDOWS = [5, 10, 15, 20];

// Set in bootMapUi: fills the window dropdown, which cannot be built until the
// time axis is known. Held as a hook because the dropdown lives with the other
// UI wiring and the fits below are module scope.
let onTrendWindowsReady = () => {};

// First month index inside the trend window, and how it is described. Measured
// back from the newest month with data rather than from today, so the label
// still matches the data after a gap at the end of the record.
const trendWindow = () => {
  const last = timeDates[timeDates.length - 1];
  if (!trendState.years) {
    return {from: 0, label: `${timeDates[0].getFullYear()}\u2013${last.getFullYear()}`};
  }
  const cutoff = new Date(last);
  cutoff.setFullYear(cutoff.getFullYear() - trendState.years);
  const from = timeDates.findIndex((d) => d >= cutoff);
  return {
    from: from < 0 ? 0 : from,
    label: `last ${trendState.years} yr`,
  };
};

// How many cells fell in each class. Land only: a NaN slope is ocean or a cell
// with too few months, and neither is a classification.
const countCellCategories = (slopes) => {
  const counts = new Map();
  for (let i = 0; i < slopes.length; i++) {
    const s = slopes[i];
    if (!Number.isFinite(s)) continue;
    const key = classify(s, TREND_THRESHOLDS).key;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

// Shared by both modes: the region classification counts regions, the global
// map counts cells, and the classes are the same either way.
// The manifest, then the picker. My Regions is appended rather than listed in
// the file: it is the user's own and has no source to name.
const loadRegionSets = async () => {
  const res = await fetch(REGION_SETS_URL, {cache: "no-cache"});
  if (!res.ok) throw new Error(`Region set manifest: HTTP ${res.status}`);
  const {sets} = await res.json();
  if (!Array.isArray(sets) || !sets.length) throw new Error("Region set manifest lists no sets");
  regionSets = [...sets, MY_REGIONS];

  regionSetSelect.replaceChildren(
    ...regionSets.map(({id, label}) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = label;
      return option;
    }),
  );
  regionSetSelect.value = regionSets[0].id;
  return regionSets[0];
};

// Bounding box of a ring set, for the uploads, which have no layer to ask.
const ringsExtent = (rings) => {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < xmin) xmin = x;
      if (x > xmax) xmax = x;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
  }
  return {xmin, ymin, xmax, ymax};
};

const renderTrendLegend = ({varName, counts, noun, window}) => {
  const {moderate, extreme} = TREND_THRESHOLDS;
  trendLegendTitle.textContent = `${varName} trend (${UNITS}/yr)`;
  trendLegendSub.textContent = `${window} · ${noun} · ±${moderate} and ±${extreme}`;

  // Increase at the top, decline at the bottom: the legend reads the way the
  // values do.
  const ordered = [...TREND_CATEGORIES].reverse().concat(INSUFFICIENT);
  trendLegendRows.replaceChildren(
    ...ordered.map((cat) => {
      const row = document.createElement("div");
      row.className = "trend-legend-row";
      const swatch = document.createElement("span");
      swatch.className = "trend-legend-swatch";
      swatch.style.background = cat.color;
      const label = document.createElement("span");
      label.textContent = cat.label;
      const count = document.createElement("span");
      count.className = "trend-legend-count";
      count.textContent = String(counts.get(cat.key) ?? 0);
      row.append(swatch, label, count);
      return row;
    }),
  );
};

// A unique-value renderer keyed on the region id, rather than a second layer of
// filled graphics: the geometry is already on the map and 81 symbols are
// cheaper than 81 copies of it.
// The uploads are graphics on their own layer rather than features with a
// renderer, so their trend colors are set per graphic. Called wherever the
// default symbol would otherwise be applied, so a classification survives a
// basemap change and a reload of the list.
const paintUploadedSymbols = () => {
  const showingTrends = trendState.on && trendState.mode === "region";
  for (const graphic of uploadedLayer.graphics) {
    const cat = showingTrends ? trendState.byRegion.get(graphic.attributes?.regionId) : null;
    graphic.symbol = cat
      ? {
        type: "simple-fill",
        color: [...hexToRgb(cat.color), 0.55],
        outline: {color: darkBasemap ? [255, 255, 255, 0.5] : [30, 41, 59, 0.55], width: 1.5},
      }
      : uploadedSymbolFor(darkBasemap);
  }
};

const applyTrendRenderer = () => {
  // My Regions has no features to render — its outlines are on uploadedLayer —
  // so the classification is painted there instead. Without this the trend ran,
  // the legend filled in, and nothing on the map changed.
  paintUploadedSymbols();
  boundaryLayer.renderer = {
    type: "unique-value",
    field: "id",
    defaultSymbol: {
      type: "simple-fill",
      color: [100, 116, 139, 0.18],
      outline: {color: INSUFFICIENT.color, width: 1},
    },
    uniqueValueInfos: [...trendState.byRegion].map(([id, cat]) => ({
      value: id,
      symbol: {
        type: "simple-fill",
        color: [...hexToRgb(cat.color), 0.55],
        outline: {color: darkBasemap ? [255, 255, 255, 0.5] : [30, 41, 59, 0.55], width: 0.75},
      },
    })),
  };
};

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

const setTrendsOff = () => {
  trendState.on = false;
  trendState.mode = null;
  trendState.varName = null;
  trendState.byRegion.clear();
  boundaryLayer.renderer = {type: "simple", symbol: regionSymbolFor(darkBasemap)};
  paintUploadedSymbols(); // back to green now that byRegion is empty
  trendLegendDiv.classList.add("hidden");
  trendWindowField.classList.add("hidden");
  trendsButton.setAttribute("aria-pressed", "false");
  trendsLabel.textContent = "Analyze trends";
  regionalSeriesHandler?.(); // drop the fitted line from a showing chart
};

// Trends belong to the view that produced them. Entering the global view drops
// a region classification and leaving it drops the trend raster, so the button
// never offers to hide something that is no longer on screen.
const clearTrendsOnViewChange = (entering) => {
  if (!trendState.on || trendState.mode === entering) return;
  if (trendState.mode === "region") {
    setTrendsOff(); // restores the outline symbol
  } else {
    // The global raster is being torn down by the caller; only the flags remain.
    trendState.on = false;
    trendState.mode = null;
    trendState.varName = null;
    trendsButton.setAttribute("aria-pressed", "false");
    trendsLabel.textContent = "Analyze trends";
    trendWindowField.classList.add("hidden");
  }
};

// The whole-world trend map: one slope per cell, drawn through the same raster
// renderer the animation uses. Static by nature, so the animation control goes
// away while it is showing — there are no frames to step through.
const runGlobalTrends = async () => {
  const varName = displayConfig.variable;
  trendState.running = true;
  trendsButton.disabled = true;
  trendsLabel.textContent = "Analyzing…";
  globalProgressLabel.textContent = `Fitting ${varName} trends\u2026`;
  globalProgressFill.style.width = "100%";
  globalProgressDiv.classList.remove("hidden");
  try {
    await ensureTimeDates();
    onTrendWindowsReady();
    await ensureGlobalData(varName);
    const {frames, nT, nLat, nLon} = globalView.byVar[varName].data;
    // One frame of gradients out of 290 of anomalies.
    const {from, label} = trendWindow();
    const slopes = perCellSlopes({frames, nT, nLat, nLon, dates: timeDates, minPoints: TREND_MIN_MONTHS, from});
    if (!globalView.active || displayConfig.variable !== varName) return;

    const {latEdgeMin, cellSize} = globalView.geo[resolutionOf(varName)];
    globalView.renderer.setStops(trendCategoryStops());
    globalView.renderer.setGrid({frames: slopes, nT: 1, nLat, nLon, latEdgeMin, cellSize});
    // Not this variable's animation grid any more, so re-entering the animation
    // has to rebuild it rather than reuse what is on screen.
    globalView.gridVar = null;
    globalView.renderer.drawFrame(0);

    timeStepHandler = null;
    timeControl?.hide();
    // The category legend replaces the continuous color bar: the map is five
    // flat classes now, and a gradient would misdescribe it.
    setLegendAvailable(false);
    const counts = countCellCategories(slopes);
    const classified = [...counts.values()].reduce((a, b) => a + b, 0);
    renderTrendLegend({varName, counts, noun: `${classified.toLocaleString()} cells`, window: label});
    trendLegendDiv.classList.remove("hidden");
    trendWindowField.classList.remove("hidden");
    globalProgressDiv.classList.add("hidden");

    trendState.on = true;
    trendState.mode = "global";
    trendState.varName = varName;
    trendsButton.setAttribute("aria-pressed", "true");
    trendsLabel.textContent = "Hide trends";
  } catch (err) {
    console.error("Could not fit the global trends", err);
    globalProgressLabel.textContent = `Could not fit ${varName} trends — see the console.`;
    globalProgressFill.style.width = "0%";
    trendsLabel.textContent = "Analyze trends";
    trendsButton.setAttribute("aria-pressed", "false");
  } finally {
    trendState.running = false;
    trendsButton.disabled = false;
  }
};

const runTrends = async () => {
  const varName = displayConfig.variable;
  trendState.running = true;
  trendsButton.disabled = true;
  trendsLabel.textContent = "Analyzing…";
  try {
    await ensureTimeDates();
    onTrendWindowsReady();
    // The same frames and the same worker the global view uses, so a variable
    // already loaded there costs nothing here.
    const [regions, {frames, nT, nLat, nLon}, {lat, lon}] = await Promise.all([
      ensureRegionRings(),
      ensureGlobalData(varName).then(() => globalView.byVar[varName].data),
      ensureCoords(resolutionOf(varName)),
    ]);

    const {from, label} = trendWindow();
    trendState.byRegion.clear();
    for (const region of regions) {
      const series = regionMeanSeries({
        rings: region.rings,
        extent: region.extent,
        frames, nT, nLat, nLon,
        lat: lat.data, lon: lon.data,
      });
      const slope = series ? computeSlope(timeDates, series, {minPoints: TREND_MIN_MONTHS, from}) : null;
      trendState.byRegion.set(region.id, classify(slope, TREND_THRESHOLDS));
    }

    trendState.on = true;
    trendState.mode = "region";
    trendState.varName = varName;
    applyTrendRenderer();
    const counts = new Map();
    for (const cat of trendState.byRegion.values()) counts.set(cat.key, (counts.get(cat.key) ?? 0) + 1);
    renderTrendLegend({varName, counts, noun: `${trendState.byRegion.size} regions`, window: label});
    trendLegendDiv.classList.remove("hidden");
    trendWindowField.classList.remove("hidden");
    trendsButton.setAttribute("aria-pressed", "true");
    trendsLabel.textContent = "Hide trends";
    // A showing analysis picks up its fitted line, or a new one for a changed
    // window. No-op when no region is being analyzed.
    regionalSeriesHandler?.();
  } catch (err) {
    console.error("Could not classify the region trends", err);
    setTrendsOff();
    trendsLabel.textContent = "Trends unavailable";
  } finally {
    trendState.running = false;
    trendsButton.disabled = false;
  }
};

// ---- Picking one cell out of the whole-world raster -------------------------
// The global view draws into a canvas rather than into features, so there is
// nothing to hit test. The click is resolved arithmetically instead: the cell
// whose centre is nearest the point, in that variable's own grid.
let pickedCell = null; // {resolution, iy, ix} — kept so a variable change can re-read the same cell

const cellIndexAt = (lon, lat, coords) => {
  const nearest = (arr, v) => {
    let best = 0;
    for (let i = 1; i < arr.length; i++) {
      if (Math.abs(arr[i] - v) < Math.abs(arr[best] - v)) best = i;
    }
    return best;
  };
  return {iy: nearest(coords.lat.data, lat), ix: nearest(coords.lon.data, lon)};
};

// A cell's series straight out of the frame buffer, which is time-major.
const cellSeries = ({frames, nT, nLat, nLon}, iy, ix) => {
  const frameSize = nLat * nLon;
  const offset = iy * nLon + ix;
  const out = new Float64Array(nT);
  for (let t = 0; t < nT; t++) out[t] = frames[t * frameSize + offset];
  return out;
};

const formatLatLon = (lat, lon) =>
  `${Math.abs(lat).toFixed(2)}\u00b0${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(2)}\u00b0${lon >= 0 ? "E" : "W"}`;

const clearPickedCell = () => {
  pickedCell = null;
  cellPickLayer.removeAll();
};

/**
 * Plot the picked cell. Draws the same variables the series toggles ask for,
 * each read from its own grid — TWSa is half-degree, so its cell is a different
 * cell from GWSa's at the same click, which is the honest thing to plot.
 */
const plotPickedCell = async (lon, lat) => {
  const wanted = plottedVariables();
  const runId = ++analysisRunSeq; // a second click abandons the first
  const series = [];

  for (const varName of wanted) {
    const resolution = resolutionOf(varName);
    try {
      await ensureGlobalData(varName);
      if (runId !== analysisRunSeq) return;
      const coords = await ensureCoords(resolution);
      const {iy, ix} = cellIndexAt(lon, lat, coords);
      const data = globalView.byVar[varName]?.data;
      if (!data) continue;
      const values = cellSeries(data, iy, ix);
      if (!values.some(Number.isFinite)) continue; // ocean, or no data in this cell
      const {longName, color} = VARIABLES[varName];
      const entry = {name: varName, longName, color, values, uncertainty: null};

      if (trendState.on) {
        const {from, label} = trendWindow();
        const fit = computeFit(timeDates, values, {minPoints: TREND_MIN_MONTHS, from});
        const pts = fitEndpoints(timeDates, values, fit, {from});
        if (pts) {
          entry.trendPoints = pts;
          entry.trendLabel = `${varName} trend ${fit.slope >= 0 ? "+" : ""}${fit.slope.toFixed(2)} ${UNITS}/yr (${label})`;
        }
      }
      series.push(entry);
      if (varName === displayConfig.variable) {
        // Outline the cell actually read, which is the displayed layer's — the
        // other variables' cells may be bigger or smaller.
        const half = (coords.lat.data[1] - coords.lat.data[0]) / 2;
        cellPickLayer.removeAll();
        cellPickLayer.add(new Graphic({
          geometry: cellPolygonFromCenter({
            xCenter: coords.lon.data[ix], yCenter: coords.lat.data[iy], halfWidth: half,
          }),
          symbol: {
            type: "simple-fill",
            color: [56, 189, 248, 0.15],
            outline: {color: [56, 189, 248, 0.95], width: 2},
          },
        }));
        pickedCell = {resolution, iy, ix, lon: coords.lon.data[ix], lat: coords.lat.data[iy]};
      }
    } catch (err) {
      console.error(`Could not read ${varName} for this cell`, err);
    }
  }

  if (runId !== analysisRunSeq) return;
  if (!series.length) {
    // Ocean, ice sheet, or a month range with nothing in it. Back to the prompt
    // rather than an empty chart or a panel that shuts on you.
    clearPickedCell();
    clearTimeseriesPanel(GLOBAL_PROMPT);
    setBreadcrumb("Global map", {home: false});
    return;
  }

  panels.setChartVisible(true);
  activeChart?.destroy();
  activeChart = renderTimeseriesChart({
    container: timeseriesPlotDiv,
    dates: timeDates,
    series,
    units: UNITS,
    valueLabel: VALUE_LABEL,
    fillGaps: displayConfig.fillGaps,
    fileStem: `grace_cell_${lat.toFixed(2)}_${lon.toFixed(2)}`,
    getCsv: async () => {
      const all = Object.keys(VARIABLES);
      const cols = [];
      for (const v of all) {
        try {
          await ensureGlobalData(v);
          const coords = await ensureCoords(resolutionOf(v));
          const {iy, ix} = cellIndexAt(lon, lat, coords);
          const data = globalView.byVar[v]?.data;
          if (data) cols.push({name: v, values: cellSeries(data, iy, ix), uncertainty: null});
        } catch { /* a variable that will not load is left out of the file */ }
      }
      return seriesToCsv({dates: timeDates, series: cols});
    },
  });
  activeChart.setMarker(timeControl?.currentDate ?? null);
  setBreadcrumb(formatLatLon(pickedCell?.lat ?? lat, pickedCell?.lon ?? lon), {home: false});
  // A variable toggle re-reads the same point rather than the same region.
  regionalSeriesHandler = () => plotPickedCell(lon, lat);
};

// ---- Left panel: region list and breadcrumb --------------------------------
// One row per region, built once from the layer's own features so the list and
// the outlines can never disagree about what exists. Clicking a row runs the
// same analysis clicking the polygon does.
let regionRows = []; // {id, name, button}, in the order they are shown

const setActiveRegion = (regionId) => {
  const active = regionId == null ? null : String(regionId);
  for (const row of regionRows) {
    const isActive = active !== null && String(row.id) === active;
    row.button.setAttribute("aria-current", isActive ? "true" : "false");
    if (isActive) row.button.scrollIntoView({block: "nearest"});
  }
};

// The trailing crumb names whatever is being analyzed — a region, a drawn
// polygon, an uploaded file. Passing null leaves "Home" alone as the only crumb.
//
// home:false drops the "Home" crumb itself, for the global view: Home means the
// full set of region outlines, which is not a parent of the whole-world
// animation, so offering it there would be a trail that leads somewhere the
// user did not come from.
const setBreadcrumb = (label, {home = true} = {}) => {
  breadcrumb.querySelectorAll("[data-crumb]").forEach((el) => el.remove());
  crumbHome.hidden = !home;
  if (!label) return;
  const crumbs = [];
  if (home) {
    const sep = document.createElement("span");
    sep.className = "rfs-crumb-sep";
    sep.dataset.crumb = "";
    sep.setAttribute("aria-hidden", "true");
    sep.textContent = "›";
    crumbs.push(sep);
  }
  const current = document.createElement("span");
  current.className = "rfs-crumb-current";
  current.dataset.crumb = "";
  current.setAttribute("aria-current", "page");
  current.title = label;
  current.textContent = label;
  crumbs.push(current);
  breadcrumb.append(...crumbs);
};

// One row, built the same way whichever kind of region it is. `user` rows carry
// their own geometry and a remove control; built-in rows are analyzed by id out
// of the boundary layer.
const activateRegionRow = (row) =>
  row.user ? analyzeUserRegion(row) : analyzeGlobalRegion({regionId: row.id, name: row.name});

const regionRowElement = (row) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "rfs-list-item";
  button.textContent = row.name;
  button.title = row.name;
  button.setAttribute("role", "listitem");
  button.setAttribute("aria-current", "false");
  if (row.user) button.dataset.user = "true";
  button.addEventListener("click", () => activateRegionRow(row));
  if (!row.user) return {element: button, button};

  // Uploads accumulate with nothing to remove them otherwise, and this is the
  // only place they are listed.
  const wrapper = document.createElement("div");
  wrapper.className = "rfs-list-row";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "rfs-list-remove";
  remove.title = `Remove ${row.name}`;
  remove.setAttribute("aria-label", `Remove ${row.name}`);
  remove.textContent = "\u00d7";
  remove.addEventListener("click", () => removeUserRegion(row.id));
  wrapper.append(button, remove);
  return {element: wrapper, button};
};

let builtinRows = [];
let userRows = [];
const paintRegionList = () => {
  // Uploads are their own set now, so they list under My Regions rather than
  // appended to whichever published set happens to be showing.
  regionRows = activeRegionSet.file ? builtinRows : userRows;
  regionList.replaceChildren(...regionRows.map((r) => r.element));
  applyRegionFilter();
};

const buildRegionList = async () => {
  if (!activeRegionSet.file) {
    builtinRows = [];
    paintRegionList();
    return;
  }
  const q = boundaryLayer.createQuery();
  q.where = "1=1";
  q.outFields = ["id", "n"];
  q.returnGeometry = false;
  const {features} = await boundaryLayer.queryFeatures(q);

  builtinRows = features
    .map((f) => ({id: f.attributes.id, name: f.attributes.n}))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((row) => ({...row, ...regionRowElement(row)}));
  paintRegionList();
};

// Uploaded regions, drawn and listed. Read once at boot and kept in step from
// there; the store is the record, these are its view.
const loadUserRegions = async () => {
  const saved = await listUserRegions();
  saved.sort((a, b) => a.addedAt - b.addedAt);
  uploadedLayer.removeAll();
  // Drawn only while their own set is showing, for the same reason they are
  // listed only there.
  applyOutlineVisibility();
  userRows = saved.map((rec) => {
    const row = {id: rec.id, name: rec.name, rings: rec.rings, user: true};
    uploadedLayer.add(new Graphic({
      geometry: new Polygon({rings: rec.rings, spatialReference: SpatialReference.WGS84}),
      symbol: uploadedSymbolFor(darkBasemap),
      attributes: {regionId: rec.id},
    }));
    return {...row, ...regionRowElement(row)};
  });
  // The uploads are the regions in My Regions, so adding or removing one
  // changes what a classification covers.
  regionRingsPromise = null;
  paintUploadedSymbols();
  paintRegionList();
};

const addUserRegion = async ({name, polygon}) => {
  const rec = {
    id: newUserRegionId(),
    name,
    // Plain arrays, so a record outlives any one SDK version.
    rings: polygon.rings.map((ring) => ring.map(([x, y]) => [x, y])),
    addedAt: Date.now(),
  };
  await putUserRegion(rec);
  await loadUserRegions();
  return rec;
};

const removeUserRegion = async (id) => {
  await deleteUserRegion(id);
  await loadUserRegions();
};

// Substring match on the name, case-insensitive. Hiding rather than rebuilding
// keeps each row's listener and its aria-current state.
const applyRegionFilter = () => {
  const needle = regionFilter.value.trim().toLowerCase();
  let shown = 0;
  for (const row of regionRows) {
    const match = !needle || row.name.toLowerCase().includes(needle);
    // element, not button: an uploaded row is a wrapper around the button and
    // its remove control, and hiding the button alone would leave the × behind.
    row.element.hidden = !match;
    if (match) shown++;
  }
  const empty = regionList.querySelector(".rfs-list-empty");
  if (shown === 0 && !empty) {
    const p = document.createElement("p");
    p.className = "rfs-list-empty";
    p.textContent = "No regions match.";
    regionList.append(p);
  } else if (shown > 0) {
    empty?.remove();
  }
};

// The native 3 degree GRACE mascon footprints (data/mascon_boundaries.py). This
// is an interpretation aid rather than data: every half degree cell inside one
// outline came from the same independent mascon estimate, so a gradient within
// a single outline is interpolation, not measurement.
//
// Outline only and popups off — a popupTemplate here would swallow the clicks
// the region layer and the cell handlers rely on, and the layer has nothing to
// say that the outline itself does not.
const masconRenderer = () => ({
  type: "simple",
  symbol: {
    type: "simple-fill",
    color: [255, 255, 255, 0],
    // Solid, and a color of its own. Dashes were tried and could not work here:
    // this is a mesh of 1706 polygons that tile the globe, so every interior
    // edge belongs to two mascons and gets stroked twice. Solid, the second pass
    // lands invisibly on the first; dashed, each ring starts its dash pattern at
    // its own first vertex, so the two passes fall out of phase and the shared
    // edge comes out as ragged overlapping dashes.
    //
    // Hue is what separates these from the anomaly cell boundaries instead. The
    // two grids are nested — 3 degree caps aligned to the 0.5 degree graticule —
    // so a mascon edge always lies along a cell edge and can never be told apart
    // by position. Fuchsia because nothing else on the map uses it: the cell
    // borders are black or white, the regions blue or amber, a drawn polygon
    // cyan.
    outline: {
      color: darkBasemap ? [240, 171, 252, 0.95] : [192, 38, 211, 0.9],
      width: displayConfig.masconWidth,
    },
  }
});
const masconLayer = new GeoJSONLayer({
  title: "GRACE Mascon Footprints",
  url: MASCONS_URL,
  popupEnabled: false,
  renderer: masconRenderer()
});

// Deferred rather than added at boot: a GeoJSONLayer fetches its whole source on
// load() to infer fields, so adding it to the map is what costs the download.
// Nobody who leaves the setting off ever pays for it.
let masconLayerAdded = false;
const applyMasconVisibility = () => {
  if (displayConfig.showMascons && !masconLayerAdded) {
    masconLayerAdded = true;
    // Below the region outlines, which stay clickable on top, and above the
    // anomaly raster, which both views insert at index 0.
    arcgisMap.map.add(masconLayer, arcgisMap.map.layers.indexOf(boundaryLayer));
  }
  masconLayer.visible = displayConfig.showMascons;
};

const analyzeGlobalRegion = async ({regionId, name}) => {
  setActiveRegion(regionId);
  setBreadcrumb(name ?? regionRows.find((r) => String(r.id) === String(regionId))?.name ?? "Region");
  await boundaryLayer.load();

  // Show only the picked region. definitionExpression filters the features the
  // layer already holds, so it needs no refresh() — that call re-fetched and
  // re-parsed the whole 2.3 MB source on every click, which is what stood
  // between the click and the camera moving.
  boundaryLayer.definitionExpression = `id='${regionId}'`;

  // One query for the geometry, which the analysis needs anyway; its extent is
  // the same extent queryExtent() used to make a second round trip for.
  const q = boundaryLayer.createQuery();
  q.where = `id='${regionId}'`;
  q.returnGeometry = true;
  q.outFields = [];

  const fs = await boundaryLayer.queryFeatures(q);
  if (!fs.features.length) throw new Error("No features found");
  const boundaryGeom = fs.features[0].geometry;

  // expand() rather than a bare extent: goTo takes no padding, and a tight fit
  // puts the region's edges against the viewport edges.
  await main({polygon: boundaryGeom, zoomTarget: boundaryGeom.extent.clone().expand(1.2)});
}

const analyzeUserRegion = async (row) => {
  setActiveRegion(row.id);
  setBreadcrumb(row.name);
  const polygon = new Polygon({rings: row.rings, spatialReference: SpatialReference.WGS84});
  // The built-in outlines stay visible: an upload does not replace them, and its
  // own outline is already drawn on the uploaded layer.
  drawLayer.removeAll();
  await main({polygon, zoomTarget: polygon.extent.clone().expand(1.2)});
};

const analyzeDrawnPolygon = async ({polygon}) => {
  if (polygon.spatialReference.wkid !== 4326) {
    await shapePreservingProjectOperator.load()
    polygon = shapePreservingProjectOperator.execute(polygon, SpatialReference.WGS84);
  }
  // A sketch is its own area of interest, so the set's outlines step aside for
  // it — whichever layer they are on.
  boundaryLayer.visible = false;
  uploadedLayer.visible = false;
  setActiveRegion(null);
  if (!breadcrumb.querySelector("[data-crumb]")) setBreadcrumb("Drawn polygon");
  await main({polygon, zoomTarget: polygon.extent});
}

// ---- Whole-world animated view ----
// Every spatial chunk of the zarr holds the full time series, so a global
// frame costs the same as all frames: the whole downsampled vis copy (a few
// MB compressed; ocean chunks are never stored) is fetched once, cached in
// IndexedDB, and rendered as a Mercator-warped raster (globalLayer.js)
// instead of thousands of per-frame polygon edits. No time series chart is
// shown in this mode.
// Captured once here: view.ui.add() later moves these nodes into the
// arcgis-map shadow DOM where document.getElementById can't see them.
const globalProgressDiv = document.getElementById("global-progress");
const globalProgressLabel = document.getElementById("global-progress-label");
const globalProgressFill = document.getElementById("global-progress-fill");
// Shared color-ramp legend, used by both the regional and global views.
const mapLegendDiv = document.getElementById("map-legend");
const mapLegendTitle = document.getElementById("map-legend-title");
const mapLegendBar = document.getElementById("map-legend-bar");
const mapLegendMin = document.getElementById("map-legend-min");
const mapLegendMax = document.getElementById("map-legend-max");
// Layer dropdown, docked under the color bar; switches both views' data.
const variableSelect = document.getElementById("variable-select");
syncSettingsControls(); // .env -> every control, including this dropdown

// The color bar is shown when two things agree: an anomaly layer is on the map
// with a meaningful ramp (set by the views, below) and the user/deployment has
// asked to see it (VITE_SETTINGS_MAP_LEGEND_VISIBLE and the settings checkbox).
// Keeping them apart means toggling the checkbox can never make a color bar
// appear over a map that has no data behind it.
let legendAvailable = false;
const applyLegendVisibility = () => {
  mapLegendDiv.classList.toggle("hidden", !(legendAvailable && displayConfig.showLegend));
};
const setLegendAvailable = (available) => {
  legendAvailable = available;
  applyLegendVisibility();
};

const globalView = {
  active: false,
  runSeq: 0,       // bumped on every enter/exit so stale async runs abandon
  renderer: null,
  // Which variable's COMPLETE frame series the renderer grid holds. A partial
  // preview paint sets this back to null, because the grid then holds a single
  // frame rather than the full time series and must be replaced before the
  // time slider can drive it.
  gridVar: null,
  // resolution -> {cellSize, lat0, lon0, latEdgeMin}. Per grid, because TWSa is
  // read at 0.5 degree and the rest at 1.0, and the raster is georeferenced from
  // whichever the displayed variable belongs to.
  geo: {},
  // per-variable loads: varName -> {dataPromise, data: {frames, nT, nLat, nLon},
  // stats: {validTimeIndices, suggestedMax}}; each variable is downloaded in its
  // own worker, independently of the others and of whichever one is displayed
  byVar: {}
};

// The regional and global buttons form a mutually-exclusive group: whichever
// mode is active shows its button pressed. exitGlobalView() and
// analyzeGlobalView() are the single choke points for the two modes, so the
// indicator is flipped from there. aria-pressed is the only state carrier —
// the .rfs-btn[aria-pressed="true"] rule in style.css styles the pressed button.
const regionalViewButton = document.querySelector("#refresh-layers");
const globalViewButton = document.querySelector("#global-view-button");
const setActiveViewButton = (mode) => {
  const regionalActive = mode === "regional";
  regionalViewButton.setAttribute("aria-pressed", String(regionalActive));
  globalViewButton.setAttribute("aria-pressed", String(!regionalActive));
};
setActiveViewButton("global"); // whole-world animation is the initial view

// Route animation-control steps to whichever view is active (regional applyEdits
// or global raster). A single watcher instead of one per analysis run.
let timeStepHandler = null;
// Set by a completed regional analysis: re-renders the map layer + chart from
// the already-fetched data when the GWSa/TWSa toggle flips. Null while no
// regional analysis is showing (the toggle then only updates displayConfig).
let regionalVariableHandler = null;
// Redraws the chart alone, for a comparison curve being toggled: the raster and
// the color bar are unaffected by which curves the chart carries.
let regionalSeriesHandler = null;
// Bumped whenever any analysis (regional or global) starts or the app resets,
// so an in-flight regional run abandons before mutating shared UI state.
let analysisRunSeq = 0;
// The polygon the showing regional analysis was run for, or null when none is
// showing. Only the resolution switch reads it, to redo that analysis against
// the other store instead of making the user re-select the region.
let lastAnalyzedPolygon = null;
const ensureTimeControl = () => {
  if (timeControl) return;
  timeControl = createTimeControl({
    root: timeControlRoot,
    allDates: timeDates,
    onStep: (idx) => timeStepHandler?.(idx),
  });
};

// keepCurrent preserves the slider position across a GWSa/TWSa toggle (the
// whole point of toggling is comparing the two at the same month); it falls
// back to the first date when the current one isn't in the new stop list.
const configureTimeControl = (dates, {keepCurrent = false} = {}) => {
  ensureTimeControl();
  timeControl.configure(dates, {keepCurrent});
};

const updateGlobalProgress = (fraction) => {
  globalProgressLabel.textContent = `Loading global data… ${Math.round(fraction * 100)}%`;
  globalProgressFill.style.width = `${Math.round(fraction * 100)}%`;
};

// Both views share this small color-ramp legend, built from the current stops.
// (MediaLayer rasters never appeared in the ArcGIS legend widget, and that
// widget has been removed, so this is the only legend in the app.)
const updateMapLegend = ({stops = generateStops(), unit = UNITS, title} = {}) => {
  const min = stops[0].value;
  const max = stops[stops.length - 1].value;
  const gradient = stops.map((s) => `${s.color} ${(((s.value - min) / (max - min)) * 100).toFixed(1)}%`).join(", ");
  mapLegendTitle.textContent = title ?? `${VARIABLES[displayConfig.variable].longName} (${unit})`;
  mapLegendBar.style.background = `linear-gradient(to right, ${gradient})`;
  mapLegendMin.textContent = `${min} ${unit}`;
  mapLegendMax.textContent = `${max} ${unit}`;
};

const setGlobalGrid = (varName) => {
  const entry = globalView.byVar[varName];
  // Georeferencing belongs to the grid the variable was read on, not to the app.
  const {latEdgeMin, cellSize} = globalView.geo[resolutionOf(varName)];
  globalView.renderer.setGrid({...entry.data, latEdgeMin, cellSize});
  globalView.gridVar = varName;
};

// Shown in the chart area when a selected variable can't be loaded — most
// likely one listed in the dropdown ahead of its arrays landing in the store.
const showVariableUnavailable = (varName) => {
  clearTimeseriesPanel(`<div class="flex h-full w-full items-center justify-center px-8 text-center text-2xl font-bold text-[var(--text-faint)]">${VARIABLES[varName].longName} (${varName}) could not be loaded. It may not be available yet &mdash; choose another layer from the dropdown.</div>`);
};

// Paint a partial world sent up by a still-downloading worker. The message
// carries a single frame (~216 KB) rather than the whole series, so the grid is
// installed with nT: 1 and gridVar is cleared — the full series replaces it when
// the load finishes.
const drawGlobalPreview = (varName, zarrUrl, {frame, nLat, nLon}) => {
  // A worker started against the other resolution keeps running to finish its
  // cache entry, but its previews and progress belong to a store the map is no
  // longer showing.
  if (zarrUrl !== zarrUrlFor(resolutionOf(varName))) return;
  if (!globalView.active || displayConfig.variable !== varName || !globalView.renderer) return;
  const {latEdgeMin, cellSize} = globalView.geo[resolutionOf(varName)] ?? {};
  if (cellSize == null) return;
  globalView.renderer.setStops(generateStops());
  globalView.renderer.setGrid({frames: frame, nT: 1, nLat, nLon, latEdgeMin, cellSize});
  globalView.gridVar = null;
  globalView.renderer.drawFrame(0);
};

// Each variable gets its own worker, started on first request and memoized.
// Loads are fully independent: a variable keeps downloading (and caching) if the
// user toggles away mid-load, it just stops painting previews and driving the
// progress bar, both of which follow whichever variable is currently displayed.
const ensureGlobalData = (varName) => {
  const entry = (globalView.byVar[varName] ??= {});
  if (!entry.dataPromise) {
    // The store follows the variable, so each worker reads the grid that
    // variable belongs on — TWSa at 0.5 degree, the rest at 1.0. geo is kept per
    // grid for the same reason: it georeferences the raster, and the two grids
    // have different cell sizes and origins.
    const resolution = resolutionOf(varName);
    const zarrUrl = zarrUrlFor(resolution);
    entry.dataPromise = (async () => {
      const geo = await ensureGeo(resolution);
      globalView.geo = {...globalView.geo, [resolution]: geo};
      const {frames, nT, nLat, nLon, fromCache, stats} = await loadGlobalVariable({
        varName,
        zarrUrl,
        geo,
        onProgress: (fraction) => {
          if (!globalView.active || displayConfig.variable !== varName) return;
          updateGlobalProgress(fraction);
        },
        onPreview: (preview) => drawGlobalPreview(varName, zarrUrl, preview),
      });
      entry.data = {frames, nT, nLat, nLon, fromCache};
      entry.stats = stats;
      console.info(`Global ${varName} ready (${fromCache ? "from cache" : "from network"}): ${stats.validTimeIndices.length}/${nT} months with data, dynamic color scale ±${stats.suggestedMax} ${UNITS}`);
    })().catch((err) => {
      entry.dataPromise = null; // allow retry after a failure
      throw err;
    });
  }
  return entry.dataPromise;
};

// Kick off every prefetched variable at once, before and independently of the
// map being ready to display any of them. Failures are logged rather than
// surfaced here; the variable the user is actually looking at reports its own
// failure through analyzeGlobalView's error path.
const prefetchGlobalVariables = () => {
  for (const varName of PREFETCH_VARIABLES) {
    ensureGlobalData(varName).catch((err) => {
      console.warn(`Background load of global ${varName} failed`, err);
    });
  }
};

// keepView: a GWSa/TWSa toggle inside the global view keeps the user's camera
// and slider position; entering global view from anywhere else flies home to
// the whole world and rewinds to the first populated month.
const analyzeGlobalView = async ({keepView = false} = {}) => {
  setActiveRegion(null);
  setBreadcrumb("Global map", {home: false});
  // keepView is a variable toggle, which should re-read the same point rather
  // than lose it; entering the view afresh starts with nothing picked.
  if (!keepView) clearPickedCell();
  clearTrendsOnViewChange("global");
  const runId = ++globalView.runSeq;
  analysisRunSeq++; // abandon any in-flight regional analysis
  globalView.active = true;
  const varName = displayConfig.variable;
  setActiveViewButton("global");

  // ---- clear any regional analysis state
  regionalVariableHandler = null;
  drawLayer.removeAll();
  // The whole-world raster covers the map; the region outlines would only
  // clutter it, so hide them here (exitGlobalView restores them). globalView
  // .active is already true above, so this hides whichever layer is up.
  applyOutlineVisibility();
  boundaryLayer.definitionExpression = "1=1";
  const possiblyExistingLayer = arcgisMap.map.layers.find((l) => l.title === "GRACE Anomalies");
  if (possiblyExistingLayer) arcgisMap.map.layers.remove(possiblyExistingLayer);
  timeControl?.stop();
  // Open, and saying what to do with it. Closed, nothing told the user a cell
  // could be clicked at all; a variable toggle keeps whatever is already there.
  if (!keepView) {
    clearTimeseriesPanel(GLOBAL_PROMPT);
    panels.setChartVisible(true);
  }

  // The camera waits for the chart panel just revealed above to take its space,
  // for the reason main() does: goTo resolves its target against the viewport it
  // was handed, so a resize mid-flight re-aims the animation.
  const zoomPromise = keepView
    ? Promise.resolve()
    : afterLayout().then(() => arcgisMap.view.goTo({center: MAP_CENTER, zoom: MAP_ZOOM})).catch(() => {});

  if (!globalView.renderer) globalView.renderer = createGlobalRenderer({title: "GRACE Anomalies (Global)"});
  if (!arcgisMap.map.layers.includes(globalView.renderer.layer)) {
    arcgisMap.map.layers.add(globalView.renderer.layer, 0);
  }

  // Show the progress bar BEFORE awaiting anything, so the very first paint of
  // the app already tells the user something is downloading.
  if (!globalView.byVar[varName]?.data) {
    globalProgressDiv.classList.remove("hidden");
    updateGlobalProgress(0);
  }
  try {
    // The time axis is a separate small read that the slider needs; awaiting it
    // here (rather than at module scope) keeps a failure recoverable.
    await ensureTimeDates();
    if (globalView.runSeq !== runId || !globalView.active) return;
    await ensureGlobalData(varName);
  } catch (err) {
    console.error(`Failed to load the global ${varName} dataset`, err);
    if (globalView.runSeq === runId && globalView.active) {
      // The store a variable is read from follows from the variable, so naming
      // the grid says which one failed to publish.
      globalProgressLabel.textContent =
        `Failed to load ${VARIABLES[varName].longName} at ${resolutionOf(varName)} degree resolution. ` +
        `That dataset may not be published — choose another layer, or press the globe to retry.`;
      globalProgressFill.style.width = "0%";
      // don't leave another variable's raster on screen looking like this one
      if (globalView.gridVar !== varName) {
        globalView.renderer.clear();
        globalView.gridVar = null;
        setLegendAvailable(false);
      }
    }
    return;
  }
  if (globalView.runSeq !== runId || !globalView.active) return;

  const {stats} = globalView.byVar[varName];
  // A store whose chunks are all fill loads perfectly and contains nothing. That
  // is not an error anywhere in the fetch path, so without this check the app
  // hides the progress bar and paints an empty world — indistinguishable from a
  // rendering bug. Say what actually happened instead.
  if (!stats.validTimeIndices.length) {
    console.warn(`Global ${varName} loaded but every value is a fill value — the store has no data for this variable`);
    globalProgressDiv.classList.remove("hidden");
    globalProgressLabel.textContent = `${VARIABLES[varName].longName} has no data in this dataset — every cell of every month is a fill value. Choose another layer, or point the app at a store that has ${varName}.`;
    globalProgressFill.style.width = "0%";
    globalView.renderer.clear();
    globalView.gridVar = null;
    setLegendAvailable(false);
    return;
  }
  globalProgressDiv.classList.add("hidden");

  // Fit the color scale to the 95th percentile of |values| across the whole
  // dataset; a plain max would let a few extreme cells wash out the ramp.
  displayConfig.maxValue = stats.suggestedMax;
  setGlobalGrid(varName);
  globalView.renderer.setStops(generateStops());
  globalView.renderer.setBorders(globalBorderConfig());
  globalView.renderer.layer.opacity = displayConfig.opacity;
  updateMapLegend();
  setLegendAvailable(true);

  const validDates = stats.validTimeIndices.map((t) => timeDates[t]);
  timeStepHandler = (idx) => {
    globalView.renderer.drawFrame(idx);
    // A picked cell's chart is showing beneath the map, so its marker tracks the
    // animation the same way the regional one does.
    if (pickedCell) activeChart?.setMarker(timeDates[idx]);
  };
  ensureTimeControl();
  configureTimeControl(validDates.length ? validDates : timeDates, {keepCurrent: keepView});
  timeControl.playRate = GLOBAL_PLAY_RATE_MS;
  timeControl.loop = true; // loop when the user presses play
  const start = timeControl.currentDate;
  const startIdx = start ? timeDates.findIndex((d) => d.getTime() === start.getTime()) : -1;
  globalView.renderer.drawFrame(startIdx >= 0 ? startIdx : (stats.validTimeIndices[0] ?? 0));

  await zoomPromise;
  // Leave the animation paused on the first frame; the user starts it with the
  // time slider's play button when ready.
};

const exitGlobalView = () => {
  clearTrendsOnViewChange("region");
  clearPickedCell();
  globalView.runSeq++;
  globalView.active = false;
  setActiveViewButton("regional");
  timeStepHandler = null;
  timeControl?.stop();
  if (timeControl) {
    timeControl.playRate = REGIONAL_PLAY_RATE_MS;
    timeControl.loop = false;
  }
  if (globalView.renderer) {
    globalView.renderer.clear();
    arcgisMap.map.layers.remove(globalView.renderer.layer);
  }
  // Undo the global-view state changes; callers (main/resetLayers) re-show the
  // shared legend when a regional layer takes over. My Regions has no outlines
  // to restore — its layer carries no file.
  applyOutlineVisibility();
  globalProgressDiv.classList.add("hidden");
  setLegendAvailable(false);
  panels.setChartVisible(true);
};

const main = async ({polygon, zoomTarget}) => {
  exitGlobalView();

  // The camera goes first, and everything below waits for it to have *started*.
  //
  // Two constraints pull against each other. It cannot start before the chart
  // panel exitGlobalView just revealed has taken its space, because goTo
  // resolves its target against the viewport it was handed and a mid-flight
  // resize re-aims the animation. But the wait for that layout is two animation
  // frames, and animation frames do not fire while the main thread is busy —
  // so anything started before the wait pushes the camera out behind it. The
  // reads below decompress zarr chunks synchronously (blosc/zstd through WASM),
  // which is exactly that kind of busy, and is why the zoom used to sit still
  // for a second or more after a click.
  //
  // Awaiting the layout here, before any of that work exists, keeps the wait to
  // the two frames it is supposed to be.
  let zoomPromise = Promise.resolve();
  if (zoomTarget) {
    await afterLayout();
    // A camera the user interrupts by panning is not a failed analysis, so a
    // rejected goTo is swallowed rather than thrown out of the await below.
    zoomPromise = arcgisMap.view.goTo(zoomTarget).catch(() => {});
  }

  // Remembered so a resolution switch can re-run this same region against the
  // other store; cleared by resetLayers, which throws the analysis away.
  lastAnalyzedPolygon = polygon;
  const runId = ++analysisRunSeq;
  regionalVariableHandler = null; // reinstalled once this run's data is ready
  regionalSeriesHandler = null;
  await ensureTimeDates();
  await arcgisMap.map.when();
  await arcgisMap.view.when();
  if (!geodeticAreaOperator.isLoaded()) await geodeticAreaOperator.load();
  intersectionOperator.accelerateGeometry(polygon);

  // Cells whose overlap with the region is below this are neither drawn nor
  // averaged: a sliver of a cell is mostly somewhere else.
  const displayThreshold = 0.35;

  // Everything below is per grid, not per analysis. TWSa is read at 0.5 degree
  // and every other variable at 1.0 (VARIABLES in settings.js), so a chart
  // comparing them needs both, and nothing about one transfers to the other —
  // different cell geometry, different read window, different overlap weights.
  //
  // Split in two because the halves cost very different amounts. The read
  // window needs only the coordinate arrays, so the download can start while
  // the expensive part runs; the cell intersection is thousands of WASM calls.

  const windows = {};
  const windowFor = (resolution) => {
    windows[resolution] ??= ensureCoords(resolution).then(({lat, lon}) => {
      const cellSize = lat.data[1] - lat.data[0];
      const filteredLats = lat.data.filter((y) => y >= polygon.extent.ymin - 2 * cellSize && y <= polygon.extent.ymax + 2 * cellSize);
      const filteredLons = lon.data.filter((x) => x >= polygon.extent.xmin - 2 * cellSize && x <= polygon.extent.xmax + 2 * cellSize);
      const yStart = lat.data.indexOf(filteredLats[0]);
      const yStop = lat.data.indexOf(filteredLats[filteredLats.length - 1]) + 1;
      const xStart = lon.data.indexOf(filteredLons[0]);
      const xStop = lon.data.indexOf(filteredLons[filteredLons.length - 1]) + 1;
      return {
        cellSize,
        filteredLats,
        filteredLons,
        readWindow: [null, {start: yStart, stop: yStop}, {start: xStart, stop: xStop}],
      };
    });
    return windows[resolution];
  };

  // Null when a newer analysis took over while this was building: the loop
  // yields, so that can happen part way through. Every caller checks.
  const grids = {};
  const gridFor = async (resolution) => {
    if (grids[resolution]) return grids[resolution];
    const {cellSize, filteredLats, filteredLons, readWindow} = await windowFor(resolution);
    if (runId !== analysisRunSeq) return null;
    const HALF = cellSize / 2;

    // Three or four WASM geometry calls per cell, over every cell in the
    // region's bounding box — a second or more of uninterrupted synchronous
    // work on a large region. That is what froze the map mid-zoom: the camera
    // was animating, but no frame could be painted until the loop finished, so
    // the view sat still and then snapped to its destination.
    //
    // Slicing by elapsed time rather than by a cell count keeps the pause
    // bounded whatever the cell size and however fast the machine is. The check
    // sits in the outer loop so it stays off the hot path.
    const intersectingCells = [];
    let sliceStart = performance.now();
    for (const y of filteredLats) {
      for (const x of filteredLons) {
        const cell = cellPolygonFromCenter({xCenter: x, yCenter: y, halfWidth: HALF});
        const cellArea = geodeticAreaOperator.execute(cell);
        const intersectsGeom = intersectionOperator.execute(polygon, cell);
        const intersectArea = intersectsGeom ? geodeticAreaOperator.execute(intersectsGeom) : 0;
        const frac = intersectArea / cellArea;
        intersectingCells.push({lon: x, lat: y, frac, cell, intersects: !!intersectsGeom, overlapArea: intersectArea});
      }
      if (performance.now() - sliceStart > SLICE_MS) {
        await yieldToBrowser();
        if (runId !== analysisRunSeq) return null;
        sliceStart = performance.now();
      }
    }

    const validCellIndices = intersectingCells
      .map((cell, idx) => (cell.intersects && cell.frac >= displayThreshold) ? idx : -1)
      .filter((idx) => idx !== -1);

    grids[resolution] = {resolution, cellSize, intersectingCells, validCellIndices};
    return grids[resolution];
  };

  // Reads are lazy per variable: the displayed one starts downloading now, over
  // the top of the cell intersection below, and the others are fetched only
  // when first selected, then memoized so toggling back is instant. The window
  // comes from that variable's own grid.
  const varReads = {};
  const startVarRead = (varName) => {
    varReads[varName] ??= Promise.all([windowFor(resolutionOf(varName)), getVarNodes(varName)])
      .then(([{readWindow}, nodes]) => Promise.all([
        get(nodes.value, readWindow).then((raw) => maskFill(nodes.value, raw)), // int16 sentinel -> NaN
        nodes.unc ? get(nodes.unc, readWindow) : null,                          // float, already NaN-filled
      ]))
      .catch((err) => {
        delete varReads[varName]; // allow retry (e.g. once the array is added)
        throw err;
      });
    return varReads[varName];
  };
  startVarRead(displayConfig.variable).catch(() => {}); // rethrown where it is awaited

  // Calculate max absolute value only for displayed cells
  const findMaxAbsForValidCells = (data, shape, stride, validIndices) => {
    const [T, , nLon] = shape;
    const [sT, sY, sX] = stride;
    let max = 0;
    for (let t = 0; t < T; t++) {
      const tOffset = t * sT;
      for (const idx of validIndices) {
        // validIndices are row-major positions in the window: idx = y * nLon + x
        const v = data[tOffset + Math.floor(idx / nLon) * sY + (idx % nLon) * sX];
        if (!Number.isNaN(v) && Math.abs(v) > max) {
          max = Math.abs(v);
        }
      }
    }
    return max;
  };

  const weightedMeanTimeSeries = (data, shape, stride, cells, indices) => {
    const [T, , nLon] = shape;
    const [sT, sY, sX] = stride;
    const result = new Float64Array(T);
    for (let t = 0; t < T; t++) {
      const tOffset = t * sT;
      let weightedSum = 0;
      let weightTotal = 0;
      for (const idx of indices) {
        const v = data[tOffset + Math.floor(idx / nLon) * sY + (idx % nLon) * sX];
        if (Number.isNaN(v)) continue;
        const w = cells[idx].overlapArea;
        weightedSum += v * w;
        weightTotal += w;
      }
      result[t] = weightTotal > 0 ? weightedSum / weightTotal : NaN;
    }
    return result;
  };
  // ---- Per-variable derived data, computed once that variable's read resolves
  const varData = {};
  // Null when a newer analysis took over while this was loading.
  const loadVarData = async (varName) => {
    if (varData[varName]) return varData[varName];
    const grid = await gridFor(resolutionOf(varName));
    if (!grid) return null;
    const {intersectingCells, validCellIndices} = grid;
    const [values, unc] = await startVarRead(varName);
    const meanSeries = weightedMeanTimeSeries(values.data, values.shape, values.stride, intersectingCells, validCellIndices);
    // Time steps where the selection actually has data. GRACE has missing months
    // plus the GRACE/GRACE-FO gap; the slider only stops on populated dates.
    const validTimeIndices = [];
    for (let t = 0; t < timeDates.length; t++) {
      if (Number.isFinite(meanSeries[t])) validTimeIndices.push(t);
    }
    const validTimeDates = validTimeIndices.map((t) => timeDates[t]);
    varData[varName] = {
      values,
      meanSeries,
      // The band is the per-cell sigma averaged the same way the values are,
      // which is the formula for errors that are perfectly correlated across the
      // region — every cell wrong in the same direction at once. That is
      // deliberate, and for most regions it is also exact: the 0.5 degree cells
      // inside one 3 degree mascon are downsampled from a single GRACE estimate,
      // so their errors are identical by construction. 49 of the 81 shipped
      // regions fit inside a single mascon and the median spans 0.6 of one.
      //
      // Treating cells as independent instead (quadrature, shrinking as 1/sqrt n)
      // was considered and rejected: it would be wrong within a mascon, where
      // the cells carry one estimate copied.
      //
      // Doing it properly (correlated within a mascon, independent across) needs
      // a mascon id per cell, and measuring it first showed it is not worth the
      // data change: only five regions span enough mascons to matter, and GWSa
      // barely moves even there. Median per-cell sigma read from the 1.0 degree
      // store, in cm:
      //
      //     chunk                TWSa   SMa   SWEa   GWSa
      //     tropical S. America  3.85  4.44   0.00   6.21
      //     arid Africa          1.57  1.17   0.00   2.17
      //     snowy N. America     2.51  4.54   5.22  11.29
      //
      // GRACE is never the dominant term — GLDAS inter-model spread equals or
      // exceeds it everywhere — and only the GRACE term would narrow, so GWSa's
      // band on the largest region (Great Artesian, ~16 mascons) would reach 77%
      // of its current width in the tropics and 94% in snow. TWSa alone would
      // reach 25%, which is the only visible win.
      //
      // So the band being wide is mostly GLDAS models disagreeing with each
      // other (data/main.py computes SWEa_unc/SMa_unc/CANa_unc as the standard
      // deviation across Noah, VIC and CLSM, and GWSa_unc sums all four in
      // quadrature). Narrowing it is a question about those models, not about
      // this aggregation.
      uncMeanSeries: unc ? weightedMeanTimeSeries(unc.data, unc.shape, unc.stride, intersectingCells, validCellIndices) : null,
      // Color scale bound for this variable's displayed cells
      maxValue: Math.ceil(findMaxAbsForValidCells(values.data, values.shape, values.stride, validCellIndices)) || 30,
      firstValidStep: validTimeIndices.length ? validTimeIndices[0] : 0,
      sliderDates: validTimeDates.length ? validTimeDates : timeDates,
      // False when the read succeeded but every cell is a fill value — an empty
      // variable in the store, not a failed fetch. renderVariable says so rather
      // than drawing an empty chart over uncolored cells.
      hasData: validTimeIndices.length > 0,
      // The raster indexes `values` by position in this grid's window, so the
      // two travel together.
      grid,
    };
    return varData[varName];
  };

  const seriesFor = (varName) => {
    const {longName, color} = VARIABLES[varName];
    const d = varData[varName];
    const entry = {
      name: varName,
      longName,
      color,
      values: d.meanSeries,
      uncertainty: d.uncMeanSeries, // null when the store has no <var>_unc array
    };

    // While the region classification is showing, each plotted series carries
    // the fit behind it — the same least-squares line over the same window that
    // decided the region's color, so the chart shows the reasoning rather than
    // just the verdict. Fitted on this region's exact area-weighted mean, where
    // the classification used the cheaper whole-world approximation, so the two
    // can differ slightly; this is the more accurate of the two.
    if (trendState.on && trendState.mode === "region") {
      const {from, label} = trendWindow();
      const fit = computeFit(timeDates, d.meanSeries, {minPoints: TREND_MIN_MONTHS, from});
      const trendPoints = fitEndpoints(timeDates, d.meanSeries, fit, {from});
      if (trendPoints) {
        entry.trendPoints = trendPoints;
        entry.trendLabel = `${varName} trend ${fit.slope >= 0 ? "+" : ""}${fit.slope.toFixed(2)} ${UNITS}/yr (${label})`;
      }
    }
    return entry;
  };

  // Draw the displayed layer plus whatever comparisons are toggled on. Each is
  // loaded on demand and memoized for this analysis, so a variable toggled off
  // and on again costs nothing the second time.
  const plotTimeseries = async () => {
    const wanted = plottedVariables();
    const runId = analysisRunSeq;
    await Promise.all(wanted.map((v) => loadVarData(v).catch((err) => {
      // One comparison that cannot be read should not take the chart down with
      // it; it is dropped below and the rest are drawn.
      console.error(`Could not load the ${v} time series`, err);
    })));
    if (runId !== analysisRunSeq) return; // a newer analysis or reset took over

    const series = wanted.filter((v) => varData[v]?.hasData).map(seriesFor);
    if (!series.length) return;
    activeChart?.destroy();
    activeChart = renderTimeseriesChart({
      container: timeseriesPlotDiv,
      dates: timeDates,
      series,
      units: UNITS,
      valueLabel: VALUE_LABEL,
      fillGaps: displayConfig.fillGaps,
      fileStem: `grace_${displayConfig.variable.toLowerCase()}`,
      // Every variable, not only the plotted ones: a file whose columns depend
      // on what happened to be toggled is a poor record of the region. The ones
      // never plotted are read here, on the first download that needs them.
      getCsv: async () => {
        const all = Object.keys(VARIABLES);
        await Promise.all(all.map((v) => loadVarData(v).catch(() => null)));
        return seriesToCsv({
          dates: timeDates,
          series: all.filter((v) => varData[v]?.hasData).map(seriesFor),
        });
      },
    });
    activeChart.setMarker(timeControl?.currentDate ?? null);
  };

  const cellFields = [
    {name: "oid", type: "oid"},
    {name: "idx", type: "integer"},
    {name: "lon", type: "double"},
    {name: "lat", type: "double"},
    {name: "frac", type: "double"},
    {name: "anomaly", type: "double"}
  ];

  // Create renderer for a given field using current display config
  const createRenderer = (field) => {
    return {
      type: "simple",
      symbol: {
        type: "simple-fill",
        // Black over a pale basemap, white over imagery, for the same reason
        // the region outlines switch. The mascon outlines take a hue of their
        // own so the two grids stay apart where their edges coincide.
        outline: displayConfig.showBorders
          ? {color: darkBasemap ? [255, 255, 255, 0.85] : [0, 0, 0, 1], width: displayConfig.borderWidth}
          : {color: [0, 0, 0, 0], width: 0}
      },
      visualVariables: [{
        type: "color",
        field,
        stops: generateStops(),
        legendOptions: {
          title: `${VALUE_LABEL} (${UNITS})`,
          showLegend: true  // show the color ramp
        }
      }]
    };
  };

  // The raster is drawn on the displayed layer's grid, so switching to a layer
  // on the other grid rebuilds it — the cells are a different size and there are
  // four times as many of them. Only TWSa sits at 0.5 degree, so that is the one
  // switch that pays for a rebuild; moving between the 1.0 degree variables
  // reuses what is already there.
  let raster = null;
  const buildRaster = (grid) => {
    const cellSource = grid.intersectingCells
      .map(({lon, lat, frac, cell, intersects}, idx) => {
        if (!intersects || frac < displayThreshold) return null;
        return new Graphic({
          geometry: cell,
          attributes: {oid: idx, idx, lon, lat, frac, anomaly: 0},
        });
      })
      .filter(Boolean);

    const layer = new FeatureLayer({
      title: "GRACE Anomalies",
      source: cellSource,
      objectIdField: "oid",
      fields: cellFields,
      geometryType: "polygon",
      spatialReference: SpatialReference.WGS84,
      renderer: createRenderer("anomaly"),
      opacity: displayConfig.opacity,
      visible: true
    });

    const existing = arcgisMap.map.layers.find((l) => l.title === "GRACE Anomalies");
    if (existing) arcgisMap.map.layers.remove(existing);
    arcgisMap.map.layers.add(layer, 0);

    return {
      resolution: grid.resolution,
      layer,
      // idx -> oid lookup, precomputed for the per-step edits below
      oids: cellSource.map((g) => g.attributes.oid),
      idxs: cellSource.map((g) => g.attributes.idx),
      count: cellSource.length,
    };
  };

  const ensureRaster = (grid) => {
    if (raster?.resolution !== grid.resolution) raster = buildRaster(grid);
    return raster;
  };

  // ---- make updates serial so slider scrubbing doesn't overlap edits ----
  let editsInFlight = Promise.resolve();

  const updateMapToTimeStep = (timeStep) => {
    editsInFlight = editsInFlight.then(async () => {
      const d = varData[displayConfig.variable];
      if (!d?.values) return; // displayed variable failed to load
      // The indices below address this variable's own window, so a raster built
      // for the other grid cannot be edited from it. renderVariable installs the
      // right one; this is the guard for an edit already queued when it changed.
      if (raster?.resolution !== d.grid.resolution) return;
      const {values} = d;
      const nLon = values.shape[2];
      const nLat = values.shape[1];
      const base = timeStep * nLat * nLon;

      // Build update array with the displayed variable's value for each cell
      const updateFeatures = new Array(raster.count);
      for (let i = 0; i < raster.count; i++) {
        const idx = raster.idxs[i];
        updateFeatures[i] = new Graphic({
          attributes: {
            oid: raster.oids[i],
            anomaly: values.data[base + idx]
          }
        });
      }

      await raster.layer.applyEdits({updateFeatures});

      activeChart?.setMarker(timeDates[timeStep]);
    }).catch(console.error);
  };

  // update the animation control — stops only on dates that have data
  timeStepHandler = updateMapToTimeStep;
  ensureTimeControl();

  // Render the displayed variable: load (or reuse) its window, then restyle
  // the layer, chart, legend, and slider. Used for both the initial draw and
  // the dropdown toggle; keepSlider preserves the slider position across a
  // toggle so the two variables can be compared at the same month.
  const renderVariable = async ({keepSlider}) => {
    const varName = displayConfig.variable;
    if (!varData[varName]) {
      clearTimeseriesPanel(`<div class="flex h-full w-full items-center justify-center px-8 text-center text-2xl font-bold text-[var(--text-faint)]">Loading ${VARIABLES[varName].longName}&hellip;</div>`);
    }
    let d;
    try {
      d = await loadVarData(varName);
    } catch (err) {
      console.error(`Failed to load ${varName} for this region`, err);
      if (runId !== analysisRunSeq || displayConfig.variable !== varName) return;
      if (raster) raster.layer.visible = false;
      setLegendAvailable(false);
      showVariableUnavailable(varName);
      return;
    }
    // d is null when a newer analysis took over while the grid was building.
    if (!d || runId !== analysisRunSeq || displayConfig.variable !== varName) return;
    // Read fine, but the variable is empty in this store (see hasData). Drawing
    // uncolored cells under a pointless chart would look like a broken render.
    if (!d.hasData) {
      console.warn(`${varName} read successfully for this region but contains no data — every value is a fill value`);
      if (raster) raster.layer.visible = false;
      setLegendAvailable(false);
      clearTimeseriesPanel(`<div class="flex h-full w-full items-center justify-center px-8 text-center text-2xl font-bold text-[var(--text-faint)]">${VARIABLES[varName].longName} (${varName}) has no data in this dataset &mdash; choose another layer.</div>`);
      return;
    }
    displayConfig.maxValue = d.maxValue;
    // Installs a new raster when this variable sits on the other grid.
    ensureRaster(d.grid);
    raster.layer.renderer = createRenderer("anomaly");
    raster.layer.visible = true;
    updateMapLegend();
    setLegendAvailable(true);
    plotTimeseries();
    configureTimeControl(d.sliderDates, {keepCurrent: keepSlider});
    const start = timeControl.currentDate;
    const idx = start ? timeDates.findIndex((dd) => dd.getTime() === start.getTime()) : -1;
    updateMapToTimeStep(idx >= 0 ? idx : d.firstValidStep);
  };

  regionalVariableHandler = () => renderVariable({keepSlider: true});
  regionalSeriesHandler = () => plotTimeseries();

  // initial draw. The camera is awaited here rather than around the raster's
  // creation, which is now deferred into renderVariable.
  await zoomPromise;
  if (runId !== analysisRunSeq) return; // a newer analysis or reset took over
  await renderVariable({keepSlider: false});
}

const resetLayers = () => {
  exitGlobalView();
  setActiveRegion(null);
  setBreadcrumb(null);
  analysisRunSeq++; // abandon any in-flight regional analysis
  regionalVariableHandler = null;
  regionalSeriesHandler = null;
  lastAnalyzedPolygon = null;
  drawLayer.removeAll(); // the sketch is scratch; uploadedLayer is not touched
  applyOutlineVisibility();
  boundaryLayer.definitionExpression = "1=1"; // reset to none selected
  // The same fit the set picker uses: boundaryLayer.fullExtent is the whole
  // world for a fileless set, which sent Home past the globe.
  fitRegionSet();
  timeControl?.hide();
  clearTimeseriesPanel(appInstructions);
  const possiblyExistingLayer = arcgisMap.map.layers.find(l => l.title === "GRACE Anomalies");
  if (possiblyExistingLayer) arcgisMap.map.layers.remove(possiblyExistingLayer);
}

// Build a custom set of zoom levels (LODs) at half-step increments. The default
// Web Mercator scheme halves the scale every level, so the jump from the most
// zoomed-out level to one step in is a jarring 2x. These LODs change scale by a
// factor of √2 per level (half a traditional zoom level) for gentler steps.
// Note: because each level is now a half-step, a given scale sits at twice the
// LOD number it used to (e.g. old zoom 2 → new zoom 4).
const BASE_SCALE = 591657527.591555;        // Web Mercator level-0 scale
const BASE_RESOLUTION = 156543.03392800014; // ...and its resolution (m/px)
const HALF_STEP = Math.SQRT2;               // per-level scale/resolution factor
const halfZoomLODs = Array.from({length: 47}, (_, i) => ({
  level: i,
  scale: BASE_SCALE / Math.pow(HALF_STEP, i),
  resolution: BASE_RESOLUTION / Math.pow(HALF_STEP, i),
}));

// Start both prefetched variables downloading right now, in their own workers.
// This deliberately does NOT wait for the map: the zarr download and the ArcGIS
// view initialization are independent, so overlapping them saves several
// seconds, and a map that never becomes ready no longer means data that never
// starts loading.
prefetchGlobalVariables();

// Everything that wires up the UI lives here, and it must run exactly once —
// but it is a race whether the map's view is ready before or after this module
// finishes executing. `arcgisViewReadyChange` is a one-shot event in practice,
// so a listener registered after it already fired would never run and the app
// would sit forever with a rendered map, no progress bar, and no working
// buttons. Guarding with `arcgisMap.ready` and de-duplicating with `booted`
// covers both orderings.
let booted = false;
const bootMapUi = async () => {
  if (booted) return;
  booted = true;
  await arcgisMap.map.when();
  await arcgisMap.view.when()
  arcgisMap.view.constraints = {lods: halfZoomLODs, snapToZoom: true};
  // Now that the half-step LODs are in place, VITE_MAP_ZOOM means a level in
  // this scheme — the same one analyzeGlobalView's goTo uses. Applying it
  // before the swap would silently double it (each old level is two new ones).
  arcgisMap.view.goTo({center: MAP_CENTER, zoom: MAP_ZOOM}, {animate: false}).catch(() => {
  });
  // Honors VITE_SETTINGS_SHOW_MASCONS; a no-op unless the deployment starts with
  // the footprints on.
  applyMasconVisibility();

  // dock the overlays inside the map UI, adding them to each corner in stack
  // order: top-right holds the drawing tools, then the load-progress bar, the
  // shared color bar, and the layer dropdown beneath it; the compact time
  // slider sits bottom-left.
  arcgisMap.view.ui.add(trendLegendDiv, "top-right");
  arcgisMap.view.ui.add(zoomControl, "top-left");
  arcgisMap.view.ui.add(basemapControl, "top-left");
  arcgisMap.view.ui.add(drawControl, "top-right");

  // ---- Zoom ----
  // One LOD per press, which is half a conventional zoom level under the
  // halfZoomLODs constraint set above — the same step <arcgis-zoom> took.
  const stepZoom = (delta) => {
    arcgisMap.view.goTo({zoom: arcgisMap.view.zoom + delta}).catch(() => {});
  };
  zoomInButton.addEventListener("click", () => stepZoom(1));
  zoomOutButton.addEventListener("click", () => stepZoom(-1));

  // Grey the button out at the ends of the LOD range rather than leaving a
  // press that does nothing.
  const syncZoomButtons = () => {
    const {zoom} = arcgisMap.view;
    zoomInButton.disabled = zoom >= halfZoomLODs.length - 1;
    zoomOutButton.disabled = zoom <= 0;
  };
  reactiveUtils.watch(() => arcgisMap.view.zoom, syncZoomButtons);
  syncZoomButtons();

  // ---- Basemap ----
  const basemapButtons = BASEMAPS.map(({id, label}) => {
    const button = document.createElement("button");
    button.type = "button";
    button.role = "menuitem";
    button.textContent = label;
    button.dataset.basemap = id;
    button.addEventListener("click", () => {
      arcgisMap.basemap = id;
      applyBasemapContrast(id);
      markCurrentBasemap(id);
      closeBasemapMenu();
    });
    return button;
  });
  basemapMenu.replaceChildren(...basemapButtons);

  function markCurrentBasemap(id) {
    for (const button of basemapButtons) {
      button.setAttribute("aria-current", String(button.dataset.basemap === id));
    }
  }

  function closeBasemapMenu() {
    basemapMenu.hidden = true;
    basemapButton.setAttribute("aria-expanded", "false");
  }

  markCurrentBasemap(MAP_BASEMAP);

  basemapButton.addEventListener("click", () => {
    const opening = basemapMenu.hidden;
    basemapMenu.hidden = !opening;
    basemapButton.setAttribute("aria-expanded", String(opening));
  });

  // Dismiss on a click anywhere else. composedPath rather than contains():
  // view.ui.add moved this control into the map's shadow DOM, so a document
  // listener sees the <arcgis-map> host as the target, never the menu itself.
  document.addEventListener("click", (e) => {
    if (!basemapMenu.hidden && !e.composedPath().includes(basemapControl)) closeBasemapMenu();
  });
  arcgisMap.view.on("click", () => closeBasemapMenu());
  arcgisMap.view.ui.add(globalProgressDiv, "top-right");
  arcgisMap.view.ui.add(mapLegendDiv, "top-right");

  // Clicking a region analyzes it, replacing the popup's single button. The
  // sketch tool owns the pointer while a polygon is being drawn, and the global
  // view hides the outlines entirely, so both are excluded — otherwise a click
  // meant for a vertex would kick off an analysis of whatever is underneath.
  arcgisMap.view.on("click", async (event) => {
    if (sketch?.state === "active") return;

    // The whole-world raster has no features to hit test, so a click there picks
    // the cell under the pointer instead of a region.
    if (globalView.active) {
      const point = event.mapPoint;
      if (!point) return;
      const lon = point.longitude ?? point.x;
      const lat = point.latitude ?? point.y;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      plotPickedCell(lon, lat).catch((err) => console.error("Could not plot that cell", err));
      return;
    }

    // Both layers: the published sets draw on boundaryLayer, the uploads on
    // uploadedLayer, and only one of the two is ever visible. Without this an
    // uploaded outline was unclickable — the row in the panel worked, the
    // polygon on the map did not.
    const layers = [boundaryLayer, uploadedLayer].filter((l) => l.visible);
    if (!layers.length) return;
    const {results} = await arcgisMap.view.hitTest(event, {include: layers});

    const uploaded = results.find((r) => r.graphic?.layer === uploadedLayer);
    if (uploaded) {
      const row = userRows.find((r) => r.id === uploaded.graphic.attributes?.regionId);
      if (row) analyzeUserRegion(row);
      return;
    }
    const hit = results.find((r) => r.graphic?.attributes?.id != null);
    if (hit) analyzeGlobalRegion({regionId: hit.graphic.attributes.id, name: hit.graphic.attributes.n});
  });

  // "Home" is the same thing the Regions button does: drop the analysis and go
  // back to the full set of outlines.
  crumbHome.addEventListener("click", () => resetLayers());

  // Trends replace the region outlines' fill, so the two cannot be shown at
  // once. Pressing again restores the plain symbology.
  // Options are built once the time axis is known, so "All" can name the real
  // first and last year rather than a guess.
  const fillTrendWindows = () => {
    if (!timeDates?.length) return;
    const span = timeDates[timeDates.length - 1].getFullYear() - timeDates[0].getFullYear();
    const options = [
      {value: "", label: `All (${timeDates[0].getFullYear()}\u2013${timeDates[timeDates.length - 1].getFullYear()})`},
      // Only the windows that fit inside the record; a 20 year option on 12
      // years of data would silently mean the same as All.
      ...TREND_WINDOWS.filter((y) => y < span).reverse().map((y) => ({value: String(y), label: `Last ${y} years`})),
    ];
    trendWindowSelect.replaceChildren(
      ...options.map(({value, label}) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        return option;
      }),
    );
    trendWindowSelect.value = trendState.years ? String(trendState.years) : "";
  };

  trendWindowSelect.addEventListener("change", (e) => {
    trendState.years = e.target.value ? Number(e.target.value) : null;
    if (!trendState.on || trendState.running) return;
    if (trendState.mode === "global") runGlobalTrends();
    else runTrends();
  });

  // Both fits call this once the time axis has resolved.
  onTrendWindowsReady = fillTrendWindows;

  trendsButton.addEventListener("click", () => {
    if (trendState.running) return;
    if (trendState.on) {
      // In the global view the trend map replaced the animation, so turning it
      // off means putting the animation back rather than restoring a symbol.
      if (globalView.active) {
        trendState.on = false;
        trendState.varName = null;
        trendsButton.setAttribute("aria-pressed", "false");
        trendsLabel.textContent = "Analyze trends";
        analyzeGlobalView({keepView: true});
      } else {
        setTrendsOff();
      }
      return;
    }
    if (globalView.active) runGlobalTrends();
    else runTrends();
  });

  regionFilter.addEventListener("input", applyRegionFilter);

  // Comparison curves. Only the chart changes, so this asks for a redraw of the
  // chart rather than of the whole analysis. With no analysis showing there is
  // nothing to redraw and the choice is simply remembered for the next one.
  syncSeriesToggles();
  // Gaps are a chart concern only: the raster and the color bar say nothing
  // about the months GRACE is missing.
  fillGapsToggle.addEventListener("change", (e) => {
    displayConfig.fillGaps = e.target.checked;
    regionalSeriesHandler?.();
  });

  seriesToggles.addEventListener("change", (e) => {
    const key = e.target.dataset?.series;
    if (!key) return;
    if (e.target.checked) extraSeries.add(key);
    else extraSeries.delete(key);
    regionalSeriesHandler?.();
  });

  document
    .querySelector("#global-view-button")
    .addEventListener("click", () => analyzeGlobalView());

  // Layer dropdown: whichever view is active re-renders itself from the newly
  // selected variable.
  variableSelect.addEventListener("change", () => {
    displayConfig.variable = variableSelect.value;
    syncSeriesToggles(); // the lock moves with the displayed layer
    // A classification belongs to one variable; keeping it under another
    // variable's name would be a lie, so it is recomputed.
    if (trendState.on && trendState.varName !== displayConfig.variable) {
      if (trendState.mode === "global") runGlobalTrends();
      else runTrends();
    }
    if (globalView.active) {
      const point = pickedCell && {lon: pickedCell.lon, lat: pickedCell.lat};
      analyzeGlobalView({keepView: true}).then(() => {
        if (point) plotPickedCell(point.lon, point.lat).catch(() => {});
      });
    } else regionalVariableHandler?.();
    // neither view active (instructions showing): the next analysis picks it up
  });

  // Enter the view the deployment opens with (VITE_DEFAULT_VIEW) now that the
  // map is ready. For the global view that means the loading bar shows and the
  // world fills in on first paint; for the regional view it means the outlines
  // and the instructions panel, at the camera .env configured — the region
  // button is what re-fits the map to the outlines' extent.
  if (DEFAULT_VIEW === "global") {
    analyzeGlobalView();
  } else {
    exitGlobalView();
    clearTimeseriesPanel(appInstructions);
  }

  arcgisMap.map.add(uploadedLayer);
  arcgisMap.map.add(cellPickLayer);
  arcgisMap.map.add(drawLayer);

  loadRegionSets()
    .then((first) => setRegionSet(first))
    .catch(async (err) => {
      // Without the manifest there is no set to show but the uploads, which are
      // local and always available. Better than an empty panel.
      console.error("Could not load the region sets", err);
      regionSets = [MY_REGIONS];
      regionSetSelect.replaceChildren(new Option(MY_REGIONS.label, MY_REGIONS.id));
      await setRegionSet(MY_REGIONS);
    });

  regionSetSelect.addEventListener("change", (e) => {
    const set = regionSets.find((s) => s.id === e.target.value);
    if (set) setRegionSet(set).catch((err) => console.error(`Could not load the ${set.label} regions`, err));
  });
  sketch = new SketchViewModel({
    view: arcgisMap.view,
    layer: drawLayer,
    // "click" places a vertex per click and closes on double-click — the one
    // mode worth keeping out of the five the widget offered.
    defaultCreateOptions: {mode: "click"},
    polygonSymbol: drawnSymbol,
  });

  const setDrawing = (drawing) => {
    drawButton.setAttribute("aria-pressed", String(drawing));
    drawLabel.textContent = drawing ? "Click to place points" : "Draw a polygon";
  };

  sketch.on("create", (e) => {
    if (e.state === "start") drawLayer.removeAll();
    if (e.state === "complete") {
      setDrawing(false);
      analyzeDrawnPolygon({polygon: e.graphic.geometry});
    }
    if (e.state === "cancel") setDrawing(false);
  });

  // One button, two jobs: start a polygon, or abandon the one being drawn.
  drawButton.addEventListener("click", () => {
    if (sketch.state === "active") {
      sketch.cancel();
      setDrawing(false);
      return;
    }
    setDrawing(true);
    sketch.create("polygon");
  });

  document
    .querySelector("#refresh-layers")
    .addEventListener("click", async () => resetLayers());

  document.querySelector("#settings-button").addEventListener("click", () => {
    settingsModal.classList.toggle("hidden");
  });

  document.getElementById("settings-close").addEventListener("click", () => {
    settingsModal.classList.add("hidden");
  });

  // Clear the IndexedDB cache so the next refresh reloads everything from the
  // network (the true first-visit condition). We only delete the DB; the
  // already-loaded in-memory data keeps this session running until refresh.
  const clearCacheButton = document.getElementById("clear-cache-button");
  const clearCacheStatus = document.getElementById("clear-cache-status");
  clearCacheButton.addEventListener("click", async () => {
    clearCacheButton.disabled = true;
    clearCacheStatus.textContent = "Clearing…";
    try {
      await clearCacheDB();
      clearCacheStatus.textContent = "Cleared. Refresh to reload from the network.";
    } catch (err) {
      console.error("Failed to clear the cache database", err);
      clearCacheStatus.textContent = "Failed to clear cache. See console.";
      clearCacheButton.disabled = false;
    }
  });

  settingsModal.addEventListener("click", (e) => {
    if (e.target.id === "settings-modal") {
      e.target.classList.add("hidden");
    }
  });

  // Restyle whichever anomaly layer is active (global raster or regional cells)
  // from the current display config, and refresh the shared legend.
  const updateAnomalyLayerAppearance = () => {
    // Global raster: restyle from the same stops, opacity, and cell boundaries
    if (globalView.active && globalView.byVar[displayConfig.variable]?.data) {
      // The trend map is the same raster on a different scale, so a palette or
      // opacity change restyles it without reverting it to anomalies.
      const showingTrends = trendState.on && trendState.mode === "global";
      globalView.renderer.layer.opacity = displayConfig.opacity;
      globalView.renderer.setStops(showingTrends ? trendCategoryStops() : generateStops());
      globalView.renderer.setBorders(globalBorderConfig());
      globalView.renderer.redraw();
      // The trend classes are fixed colors, so a palette change leaves them
      // alone and the category legend already describes them.
      if (!showingTrends) updateMapLegend();
      return; // no regional feature layer while the global view is active
    }
    const anomalyLayer = arcgisMap.map.layers.find(l => l.title === "GRACE Anomalies");
    const field = anomalyLayer?.renderer?.visualVariables?.[0]?.field;
    if (!field) return;

    anomalyLayer.opacity = displayConfig.opacity;
    anomalyLayer.renderer = {
      type: "simple",
      symbol: {
        type: "simple-fill",
        // Black over a pale basemap, white over imagery, for the same reason
        // the region outlines switch. The mascon outlines take a hue of their
        // own so the two grids stay apart where their edges coincide.
        outline: displayConfig.showBorders
          ? {color: darkBasemap ? [255, 255, 255, 0.85] : [0, 0, 0, 1], width: displayConfig.borderWidth}
          : {color: [0, 0, 0, 0], width: 0}
      },
      visualVariables: [{
        type: "color",
        field,
        stops: generateStops()
      }]
    };
    updateMapLegend();
  };

  // Layer opacity slider (its starting value came from .env, above)
  opacitySlider.addEventListener("input", (e) => {
    displayConfig.opacity = parseFloat(e.target.value);
    opacityValue.textContent = `${Math.round(displayConfig.opacity * 100)}%`;
    updateAnomalyLayerAppearance();
  });

  // Cell boundary toggle
  borderToggle.addEventListener("change", (e) => {
    displayConfig.showBorders = e.target.checked;
    updateAnomalyLayerAppearance();
  });

  // Cell boundary width slider
  borderWidthSlider.addEventListener("input", (e) => {
    displayConfig.borderWidth = parseFloat(e.target.value);
    borderWidthValue.textContent = `${displayConfig.borderWidth}px`;
    updateAnomalyLayerAppearance();
  });

  // Color palette radio buttons (generated in syncSettingsControls, so one
  // delegated listener rather than one per palette)
  paletteSelect.addEventListener("change", (e) => {
    palettePreview.style.background = paletteCssGradient(e.target.value);
    displayConfig.colorPalette = e.target.value;
    updateAnomalyLayerAppearance();
  });

  // Dynamic color scale toggle
  dynamicScaleToggle.addEventListener("change", (e) => {
    displayConfig.dynamicColorScale = e.target.checked;
    updateAnomalyLayerAppearance();
  });

  // Show/hide the color bar. Only the user's half of the decision — the views
  // still hide it whenever there is no anomaly layer to describe.
  legendToggle.addEventListener("change", (e) => {
    displayConfig.showLegend = e.target.checked;
    applyLegendVisibility();
  });

  // Region names. labelsVisible is live, so this is a repaint and nothing more.
  regionNamesToggle.addEventListener("change", (e) => {
    displayConfig.showRegionNames = e.target.checked;
    boundaryLayer.labelsVisible = displayConfig.showRegionNames;
  });

  // GRACE mascon footprints. The first switch-on fetches the GeoJSON; every
  // later toggle is just layer visibility.
  masconToggle.addEventListener("change", (e) => {
    displayConfig.showMascons = e.target.checked;
    applyMasconVisibility();
  });

  // Mascon boundary width. The renderer is immutable once assigned, so restyling
  // means handing the layer a new one.
  masconWidthSlider.addEventListener("input", (e) => {
    displayConfig.masconWidth = parseFloat(e.target.value);
    masconWidthValue.textContent = `${displayConfig.masconWidth}px`;
    masconLayer.renderer = masconRenderer();
  });

  // ---- Upload modal ----
  const uploadModal = document.getElementById("upload-modal");
  const uploadDropZone = document.getElementById("upload-drop-zone");
  const uploadFileInput = document.getElementById("upload-file-input");
  const uploadBrowseButton = document.getElementById("upload-browse-button");
  const uploadFileInfo = document.getElementById("upload-file-info");
  const uploadFileName = document.getElementById("upload-file-name");
  const uploadRegionName = document.getElementById("upload-region-name");
  const fileStem = (filename) => filename.replace(/\.(geo)?json$/i, "");
  const uploadClearFile = document.getElementById("upload-clear-file");
  const uploadError = document.getElementById("upload-error");
  const uploadSubmit = document.getElementById("upload-submit");
  const uploadCancel = document.getElementById("upload-cancel");

  let selectedFile = null;

  const resetUploadModal = () => {
    selectedFile = null;
    uploadFileInput.value = "";
    uploadFileInfo.classList.add("hidden");
    uploadFileName.textContent = "";
    uploadError.classList.add("hidden");
    uploadError.textContent = "";
    uploadSubmit.disabled = true;
    uploadSubmit.textContent = "Analyze";
    uploadDropZone.classList.remove("hidden");
    uploadRegionName.value = "";
  };

  const showUploadError = (message) => {
    uploadError.textContent = message;
    uploadError.classList.remove("hidden");
  };

  const handleFileSelection = (file) => {
    uploadError.classList.add("hidden");
    uploadError.textContent = "";

    const name = file.name.toLowerCase();
    if (!name.endsWith(".geojson") && !name.endsWith(".json")) {
      showUploadError("Invalid file type. Please upload a .geojson or .json file.");
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      showUploadError("File is too large. Maximum file size is 50 MB.");
      return;
    }

    selectedFile = file;
    // The file name is the default, not an override: a name already typed stays.
    if (!uploadRegionName.value.trim()) uploadRegionName.value = fileStem(file.name);
    uploadFileName.textContent = file.name;
    uploadFileInfo.classList.remove("hidden");
    uploadDropZone.classList.add("hidden");
    uploadSubmit.disabled = false;
  };

  document.getElementById("upload-button").addEventListener("click", () => {
    resetUploadModal();
    uploadModal.classList.toggle("hidden");
  });

  uploadModal.addEventListener("click", (e) => {
    if (e.target.id === "upload-modal") {
      e.target.classList.add("hidden");
    }
  });

  uploadCancel.addEventListener("click", () => {
    uploadModal.classList.add("hidden");
  });

  uploadBrowseButton.addEventListener("click", () => {
    uploadFileInput.click();
  });

  uploadFileInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) {
      handleFileSelection(e.target.files[0]);
    }
  });

  uploadClearFile.addEventListener("click", () => {
    resetUploadModal();
  });

  // data-drag (not a class) so the highlight lives in the markup's Tailwind
  // classes as a data-[drag=true]: variant.
  uploadDropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadDropZone.dataset.drag = "true";
  });

  uploadDropZone.addEventListener("dragleave", () => {
    delete uploadDropZone.dataset.drag;
  });

  uploadDropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    delete uploadDropZone.dataset.drag;
    if (e.dataTransfer.files.length > 0) {
      handleFileSelection(e.dataTransfer.files[0]);
    }
  });

  uploadSubmit.addEventListener("click", async () => {
    if (!selectedFile) return;

    uploadSubmit.disabled = true;
    uploadSubmit.textContent = "Processing...";
    uploadError.classList.add("hidden");

    try {
      const {polygon} = await parseGeoJSONFile(selectedFile);
      const name = uploadRegionName.value.trim() || fileStem(selectedFile.name);
      uploadModal.classList.add("hidden");
      // Saved before it is analyzed, so it survives the trip Home and the next
      // visit. loadUserRegions draws it and lists it; analyzing it then goes
      // through the same path as clicking its row.
      const saved = await addUserRegion({name, polygon});
      // The upload belongs to My Regions, so that is where it is shown.
      if (activeRegionSet.file) {
        regionSetSelect.value = MY_REGIONS.id;
        await setRegionSet(MY_REGIONS, {select: false});
      }
      const row = regionRows.find((r) => r.id === saved.id);
      await analyzeUserRegion(row ?? {id: saved.id, name, rings: saved.rings, user: true});
    } catch (err) {
      showUploadError(err.message);
      uploadSubmit.disabled = false;
      uploadSubmit.textContent = "Analyze";
    }
  });
};

arcgisMap.addEventListener("arcgisViewReadyChange", () => {
  if (arcgisMap.ready === false) return; // also fires when a view is torn down
  bootMapUi().catch((err) => console.error("Failed to initialize the map UI", err));
});
// The event may already have fired while this module was still evaluating.
if (arcgisMap.ready) {
  bootMapUi().catch((err) => console.error("Failed to initialize the map UI", err));
}
