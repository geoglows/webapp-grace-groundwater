import "@arcgis/core/assets/esri/themes/light/main.css";
import "./style.css";

import "@arcgis/map-components/components/arcgis-map";
import "@arcgis/map-components/components/arcgis-zoom";
import "@arcgis/map-components/components/arcgis-layer-list";
import "@arcgis/map-components/components/arcgis-locate";
import "@arcgis/map-components/components/arcgis-scale-bar";
import "@arcgis/map-components/components/arcgis-expand";
import "@arcgis/map-components/components/arcgis-basemap-gallery";
import GeoJSONLayer from "@arcgis/core/layers/GeoJSONLayer.js";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer.js";
import SketchViewModel from "@arcgis/core/widgets/Sketch/SketchViewModel.js";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import Graphic from "@arcgis/core/Graphic.js";
import SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
import * as intersectionOperator from "@arcgis/core/geometry/operators/intersectionOperator.js";
import * as shapePreservingProjectOperator from "@arcgis/core/geometry/operators/shapePreservingProjectOperator.js";
import * as geodeticAreaOperator from "@arcgis/core/geometry/operators/geodeticAreaOperator.js";

import {get} from "zarrita";

import {cellPolygonFromCenter} from "./cells.js";
import {REGIONS_URL, MASCONS_URL, ZARR_URL, ZARR_URL_HALF_DEGREE} from "./config.js";
import {clearCacheDB, getOrFetchCoords} from "./db.js";
import {loadGlobalVariable} from "./globalFramesClient.js";
import {createGlobalRenderer} from "./globalLayer.js";
import {hydrateIcons} from "./icons.js";
import {parseGeoJSONFile} from "./polygonUploads.js";
import {createTimeControl} from "./timeControl.js";
import {
  COLOR_PALETTES,
  DEFAULT_VIEW,
  DISPLAY_DEFAULTS,
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
import {renderTimeseriesChart} from "./timeseriesChart.js";
import {openZarrArray} from "./zarrStore.js";

hydrateIcons();  // heroicons

// Branding (logo, its link, its alt text) is not set here: index.html carries it
// as %VITE_*% template strings that Vite substitutes at build time.

const displayConfig = {...DISPLAY_DEFAULTS};

// Generate color stops scaled to max value (dynamic or fixed based on toggle)
const generateStops = () => {
  const {stops} = COLOR_PALETTES[displayConfig.colorPalette];
  const maxVal = displayConfig.dynamicColorScale ? displayConfig.maxValue : displayConfig.fixedMaxValue;
  return stops.map(({position, color}) => {
    const value = Math.round(position * maxVal);
    const label = value === 0 ? "0" : `${value} ${UNITS}`;
    return {value, color, label};
  });
};

// Map elements
const arcgisMap = document.querySelector("arcgis-map");
// Drawing is a SketchViewModel behind our own button rather than <arcgis-sketch>:
// the widget's toolbar carried a selection arrow, five polygon drawing modes, an
// undo/redo pair and a snapping menu, and only the mode picker can't be switched
// off through a hide* property. Owning the button is the only way to one button.
const drawLayer = new GraphicsLayer({title: "User drawn polygons", listMode: "hide"});
// Shared by the sketch and by an uploaded boundary — both are "the polygon this
// analysis is for", so both are drawn the same way.
const drawnSymbol = {
  type: "simple-fill",
  color: [56, 189, 248, 0.15],
  outline: {color: [56, 189, 248, 0.9], width: 2},
};
const drawControl = document.getElementById("draw-control");
const drawButton = document.getElementById("draw-button");
const drawLabel = drawButton.querySelector("[data-draw-label]");
let sketch = null; // created once the view exists (bootMapUi)
const timeControlRoot = document.getElementById("time-control");
// Built on first use rather than at module load: its index space is the full
// date list, which only exists after the store's time axis has been read.
let timeControl = null;
const timeseriesPlotDiv = document.getElementById("timeseries-plot");
const appInstructions = timeseriesPlotDiv.innerHTML

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
const regionList = document.getElementById("region-list");
const regionFilter = document.getElementById("region-filter");
const breadcrumb = document.getElementById("breadcrumb");
const crumbHome = document.getElementById("crumb-home");
const regionNamesToggle = document.getElementById("region-names-toggle");
const masconToggle = document.getElementById("mascon-toggle");
const masconWidthSlider = document.getElementById("mascon-width");
const masconWidthValue = document.getElementById("mascon-width-value");
const halfDegreeToggle = document.getElementById("half-degree-toggle");
const opacitySlider = document.getElementById("opacity-slider");
const opacityValue = document.getElementById("opacity-value");
const paletteOptions = document.getElementById("palette-options");

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

  paletteOptions.replaceChildren(
    ...Object.entries(COLOR_PALETTES).map(([key, {label}]) => {
      const option = document.createElement("label");
      option.className = "flex cursor-pointer items-center gap-3 rounded-md border-2 border-neutral-300 px-3 py-2 transition hover:bg-neutral-100 has-[input:checked]:border-sky-700 has-[input:checked]:bg-sky-50";

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "color-palette";
      radio.value = key;
      radio.className = "hidden";
      radio.checked = key === displayConfig.colorPalette;

      const swatch = document.createElement("span");
      swatch.className = "block h-5 w-20 rounded-sm border border-neutral-300";
      swatch.style.background = paletteCssGradient(key);

      const name = document.createElement("span");
      name.className = "text-sm text-neutral-800";
      name.textContent = label;

      option.append(radio, swatch, name);
      return option;
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
  masconWidthSlider.value = String(displayConfig.masconWidth);
  masconWidthValue.textContent = `${displayConfig.masconWidth}px`;
  halfDegreeToggle.checked = displayConfig.halfDegreeCells;
  dynamicScaleToggle.checked = displayConfig.dynamicColorScale;
  // The fixed range is configurable, so the sentence explaining it has to be too.
  dynamicScaleNote.textContent = `When enabled, the color scale fits the actual min/max values in the selected region, with 0 always shown as the center color. When disabled, uses a fixed range of -${displayConfig.fixedMaxValue} to +${displayConfig.fixedMaxValue} ${UNITS}.`;
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

const activeZarrUrl = () => (displayConfig.halfDegreeCells ? ZARR_URL_HALF_DEGREE : ZARR_URL);

const openArray = (name) => openZarrArray(activeZarrUrl(), name);

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

let coordsPromise = null;
const ensureCoords = () => {
  coordsPromise ??= getOrFetchCoords({zarrUrl: activeZarrUrl()}).catch((err) => {
    coordsPromise = null;
    geoPromise = null;
    throw err;
  });
  return coordsPromise;
};

// Grid origin derived from the coordinate arrays; needed by the renderer to
// georeference the raster and by the workers to pick preview time steps.
let geoPromise = null;
const ensureGeo = () => {
  geoPromise ??= ensureCoords().then(({lat, lon}) => {
    const cellSize = lat.data[1] - lat.data[0];
    return {cellSize, lat0: lat.data[0], lon0: lon.data[0], latEdgeMin: lat.data[0] - cellSize / 2};
  });
  return geoPromise;
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
    const timeNode = await openArray("time");
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
  varNodePromises[varName] ??= Promise.all([
    openArray(varName),
    openArray(`${varName}_unc`).catch(() => null),
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
const regionSymbol = {
  type: "simple-fill",
  color: [37, 99, 235, 0.12],
  outline: {color: [30, 64, 175, 0.75], width: 1},
};

// Names are drawn by the layer rather than as separate graphics so the SDK's
// label engine handles collisions. minScale is what keeps the map readable:
// collision dropping alone still leaves continent zoom covered in names longer
// than the regions under them, so nothing is labeled until the view is closer
// in than regionLabelMinScale.
const regionLabel = {
  labelExpressionInfo: {expression: "$feature.n"},
  labelPlacement: "always-horizontal",
  minScale: displayConfig.regionLabelMinScale,
  symbol: {
    type: "text",
    color: [23, 37, 84, 1],
    haloColor: [255, 255, 255, 0.95],
    haloSize: 1.5,
    font: {size: 9, weight: "bold"},
  },
};

const boundaryLayer = new GeoJSONLayer({
  title: "Region Boundaries",
  url: REGIONS_URL,
  outFields: ["*"],
  definitionExpression: "1=1", // start with none selected
  renderer: {type: "simple", symbol: regionSymbol},
  // Clicking a region analyzes it directly (see the view click handler in
  // init) — the popup this used to open only ever held one button.
  popupEnabled: false,
  labelingInfo: [regionLabel],
  labelsVisible: displayConfig.showRegionNames,
});

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

const buildRegionList = async () => {
  const q = boundaryLayer.createQuery();
  q.where = "1=1";
  q.outFields = ["id", "n"];
  q.returnGeometry = false;
  const {features} = await boundaryLayer.queryFeatures(q);

  regionRows = features
    .map((f) => ({id: f.attributes.id, name: f.attributes.n}))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((row) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "rfs-list-item";
      button.textContent = row.name;
      button.title = row.name;
      button.setAttribute("role", "listitem");
      button.setAttribute("aria-current", "false");
      button.addEventListener("click", () => analyzeGlobalRegion({regionId: row.id, name: row.name}));
      return {...row, button};
    });

  regionList.replaceChildren(...regionRows.map((r) => r.button));
};

// Substring match on the name, case-insensitive. Hiding rather than rebuilding
// keeps each row's listener and its aria-current state.
const applyRegionFilter = () => {
  const needle = regionFilter.value.trim().toLowerCase();
  let shown = 0;
  for (const row of regionRows) {
    const match = !needle || row.name.toLowerCase().includes(needle);
    row.button.hidden = !match;
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
    outline: {color: [38, 38, 38, 0.75], width: displayConfig.masconWidth}
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

const analyzeDrawnPolygon = async ({polygon}) => {
  if (polygon.spatialReference.wkid !== 4326) {
    await shapePreservingProjectOperator.load()
    polygon = shapePreservingProjectOperator.execute(polygon, SpatialReference.WGS84);
  }
  boundaryLayer.visible = false;
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
  geo: null,       // {cellSize, lat0, lon0, latEdgeMin}, set once coords resolve
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
const updateMapLegend = () => {
  const stops = generateStops();
  const min = stops[0].value;
  const max = stops[stops.length - 1].value;
  const gradient = stops.map((s) => `${s.color} ${(((s.value - min) / (max - min)) * 100).toFixed(1)}%`).join(", ");
  mapLegendTitle.textContent = `${VARIABLES[displayConfig.variable].longName} (${UNITS})`;
  mapLegendBar.style.background = `linear-gradient(to right, ${gradient})`;
  mapLegendMin.textContent = `${min} ${UNITS}`;
  mapLegendMax.textContent = `${max} ${UNITS}`;
};

const setGlobalGrid = (varName) => {
  const entry = globalView.byVar[varName];
  const {latEdgeMin, cellSize} = globalView.geo;
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
  if (zarrUrl !== activeZarrUrl()) return;
  if (!globalView.active || displayConfig.variable !== varName || !globalView.renderer) return;
  const {latEdgeMin, cellSize} = globalView.geo;
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
    // Pinned for the life of this load: switching resolution clears byVar, so a
    // worker that finishes afterwards writes into an entry nothing reads, and
    // its progress and previews are filtered out by this URL.
    const zarrUrl = activeZarrUrl();
    entry.dataPromise = (async () => {
      globalView.geo = await ensureGeo();
      const {frames, nT, nLat, nLon, fromCache, stats} = await loadGlobalVariable({
        varName,
        zarrUrl,
        geo: globalView.geo,
        onProgress: (fraction) => {
          if (zarrUrl !== activeZarrUrl()) return;
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
  const runId = ++globalView.runSeq;
  analysisRunSeq++; // abandon any in-flight regional analysis
  globalView.active = true;
  const varName = displayConfig.variable;
  setActiveViewButton("global");

  // ---- clear any regional analysis state
  regionalVariableHandler = null;
  drawLayer.removeAll();
  // The whole-world raster covers the map; the region outlines would only
  // clutter it, so hide them here (exitGlobalView restores them).
  boundaryLayer.visible = false;
  boundaryLayer.definitionExpression = "1=1";
  const possiblyExistingLayer = arcgisMap.map.layers.find((l) => l.title === "GRACE Anomalies");
  if (possiblyExistingLayer) arcgisMap.map.layers.remove(possiblyExistingLayer);
  timeControl?.stop();
  clearTimeseriesPanel();
  panels.setChartVisible(false);

  const zoomPromise = keepView ? Promise.resolve() : arcgisMap.view.goTo({
    center: MAP_CENTER,
    zoom: MAP_ZOOM,
  }).catch(() => {
  });

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
      // A deployment that has not published a half degree store fails here and
      // nowhere else, so the message names the setting that caused it.
      globalProgressLabel.textContent = displayConfig.halfDegreeCells
        ? `Failed to load ${VARIABLES[varName].longName} at half degree resolution. That dataset may not be published — turn off "half degree water balance cells" in settings, or choose another layer.`
        : `Failed to load ${VARIABLES[varName].longName}. It may not be available yet — choose another layer or press the globe to retry.`;
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
  globalView.renderer.setBorders({show: displayConfig.showBorders, width: displayConfig.borderWidth});
  globalView.renderer.layer.opacity = displayConfig.opacity;
  updateMapLegend();
  setLegendAvailable(true);

  const validDates = stats.validTimeIndices.map((t) => timeDates[t]);
  timeStepHandler = (idx) => globalView.renderer.drawFrame(idx);
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
  // shared legend when a regional layer takes over.
  boundaryLayer.visible = true;
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
  await ensureTimeDates();
  const {lat, lon} = await ensureCoords();
  await arcgisMap.map.when();
  await arcgisMap.view.when();
  const cellSize = lat.data[1] - lat.data[0]; // ~0.25
  const HALF = cellSize / 2;

  // ---- Identify cells in the bounding box of the polygon to read zarr values for and start the async reads which we can wait for later
  const filteredLats = lat.data.filter((y) => y >= polygon.extent.ymin - 2 * cellSize && y <= polygon.extent.ymax + 2 * cellSize);
  const filteredLons = lon.data.filter((x) => x >= polygon.extent.xmin - 2 * cellSize && x <= polygon.extent.xmax + 2 * cellSize);
  const yStart = lat.data.indexOf(filteredLats[0]);
  const yStop = lat.data.indexOf(filteredLats[filteredLats.length - 1]) + 1;
  const xStart = lon.data.indexOf(filteredLons[0]);
  const xStop = lon.data.indexOf(filteredLons[filteredLons.length - 1]) + 1;
  // Reads are lazy per variable: the displayed one starts downloading now
  // (overlapping the geometry work below); the others are fetched only when
  // first selected, then memoized so toggling back is instant.
  const readWindow = [null, {start: yStart, stop: yStop}, {start: xStart, stop: xStop}];
  const varReads = {};
  const startVarRead = (varName) => {
    varReads[varName] ??= getVarNodes(varName)
      .then((nodes) => Promise.all([
        get(nodes.value, readWindow).then((raw) => maskFill(nodes.value, raw)), // int16 sentinel -> NaN
        nodes.unc ? get(nodes.unc, readWindow) : null,                          // float, already NaN-filled
      ]))
      .catch((err) => {
        delete varReads[varName]; // allow retry (e.g. once the array is added)
        throw err;
      });
    return varReads[varName];
  };
  startVarRead(displayConfig.variable);

  // ---- Find the overlapping areas of the cells with the polygon ----
  if (!geodeticAreaOperator.isLoaded()) await geodeticAreaOperator.load();
  intersectionOperator.accelerateGeometry(polygon);
  // Three or four WASM geometry calls per cell, over every cell in the region's
  // bounding box — a second or more of uninterrupted synchronous work on a large
  // region. That is what froze the map mid-zoom: the camera was animating, but
  // no frame could be painted until the loop finished, so the view sat still and
  // then snapped to its destination.
  //
  // Slicing by elapsed time rather than by a cell count keeps the pause bounded
  // whatever the cell size and however fast the machine is. The check sits in
  // the outer loop so it stays off the hot path.
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
      // Yielding is what makes a newer analysis able to start mid-loop, so this
      // run has to check whether it is still the current one.
      if (runId !== analysisRunSeq) return;
      sliceStart = performance.now();
    }
  }

  // Get indices of cells that pass the display threshold (frac >= 0.35)
  const displayThreshold = 0.35;
  const validCellIndices = intersectingCells
    .map((cell, idx) => (cell.intersects && cell.frac >= displayThreshold) ? idx : -1)
    .filter(idx => idx !== -1);

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
  const loadVarData = async (varName) => {
    if (varData[varName]) return varData[varName];
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
      uncMeanSeries: unc ? weightedMeanTimeSeries(unc.data, unc.shape, unc.stride, intersectingCells, validCellIndices) : null,
      // Color scale bound for this variable's displayed cells
      maxValue: Math.ceil(findMaxAbsForValidCells(values.data, values.shape, values.stride, validCellIndices)) || 30,
      firstValidStep: validTimeIndices.length ? validTimeIndices[0] : 0,
      sliderDates: validTimeDates.length ? validTimeDates : timeDates,
      // False when the read succeeded but every cell is a fill value — an empty
      // variable in the store, not a failed fetch. renderVariable says so rather
      // than drawing an empty chart over uncolored cells.
      hasData: validTimeIndices.length > 0,
    };
    return varData[varName];
  };

  // Generate the timeseries plot for the displayed variable (re-run on toggle)
  const plotTimeseries = () => {
    const varName = displayConfig.variable;
    const {short, longName} = VARIABLES[varName];
    const d = varData[varName];
    activeChart?.destroy();
    activeChart = renderTimeseriesChart({
      container: timeseriesPlotDiv,
      dates: timeDates,
      values: d.meanSeries,
      uncertainty: d.uncMeanSeries, // null when the store has no <var>_unc array
      name: short,
      longName,
      units: UNITS,
      valueLabel: VALUE_LABEL,
      fileStem: `grace_${varName.toLowerCase()}`,
    });
  };

  // ---- Create the cell source; `anomaly` carries whichever variable is displayed ----
  const cellSource = intersectingCells
    .map(({lon, lat, frac, cell, intersects}, idx) => {
      if (!intersects || frac < displayThreshold) return null;
      return new Graphic({
        geometry: cell,
        attributes: {
          oid: idx,
          idx,
          lon,
          lat,
          frac,
          anomaly: 0
        }
      });
    })
    .filter(Boolean);

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
        outline: displayConfig.showBorders
          ? {color: [0, 0, 0, 1], width: displayConfig.borderWidth}
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

  const anomalyLayer = new FeatureLayer({
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

  // Remove existing anomaly layer if present and add new one
  const possiblyExistingLayer = arcgisMap.map.layers.find(l => l.title === "GRACE Anomalies");
  if (possiblyExistingLayer) arcgisMap.map.layers.remove(possiblyExistingLayer);
  await zoomPromise;
  if (runId !== analysisRunSeq) return; // a newer analysis or reset took over
  arcgisMap.map.layers.add(anomalyLayer, 0);

  // ---- precompute lookup from feature idx -> oid ----
  const oids = cellSource.map(g => g.attributes.oid);
  const idxs = cellSource.map(g => g.attributes.idx);

  // ---- make updates serial so slider scrubbing doesn't overlap edits ----
  let editsInFlight = Promise.resolve();

  const updateMapToTimeStep = (timeStep) => {
    editsInFlight = editsInFlight.then(async () => {
      const {values} = varData[displayConfig.variable] ?? {};
      if (!values) return; // displayed variable failed to load
      const nLon = values.shape[2];
      const nLat = values.shape[1];
      const base = timeStep * nLat * nLon;

      // Build update array with the displayed variable's value for each cell
      const updateFeatures = new Array(cellSource.length);
      for (let i = 0; i < cellSource.length; i++) {
        const idx = idxs[i];
        updateFeatures[i] = new Graphic({
          attributes: {
            oid: oids[i],
            anomaly: values.data[base + idx]
          }
        });
      }

      await anomalyLayer.applyEdits({updateFeatures});

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
      anomalyLayer.visible = false;
      setLegendAvailable(false);
      showVariableUnavailable(varName);
      return;
    }
    if (runId !== analysisRunSeq || displayConfig.variable !== varName) return; // stale toggle or analysis
    // Read fine, but the variable is empty in this store (see hasData). Drawing
    // uncolored cells under a pointless chart would look like a broken render.
    if (!d.hasData) {
      console.warn(`${varName} read successfully for this region but contains no data — every value is a fill value`);
      anomalyLayer.visible = false;
      setLegendAvailable(false);
      clearTimeseriesPanel(`<div class="flex h-full w-full items-center justify-center px-8 text-center text-2xl font-bold text-[var(--text-faint)]">${VARIABLES[varName].longName} (${varName}) has no data in this dataset &mdash; choose another layer.</div>`);
      return;
    }
    displayConfig.maxValue = d.maxValue;
    anomalyLayer.renderer = createRenderer("anomaly");
    anomalyLayer.visible = true;
    updateMapLegend();
    setLegendAvailable(true);
    plotTimeseries();
    configureTimeControl(d.sliderDates, {keepCurrent: keepSlider});
    const start = timeControl.currentDate;
    const idx = start ? timeDates.findIndex((dd) => dd.getTime() === start.getTime()) : -1;
    updateMapToTimeStep(idx >= 0 ? idx : d.firstValidStep);
  };

  regionalVariableHandler = () => renderVariable({keepSlider: true});

  // initial draw
  await renderVariable({keepSlider: false});
}

const resetLayers = () => {
  exitGlobalView();
  setActiveRegion(null);
  setBreadcrumb(null);
  analysisRunSeq++; // abandon any in-flight regional analysis
  regionalVariableHandler = null;
  lastAnalyzedPolygon = null;
  drawLayer.removeAll();
  boundaryLayer.visible = true;
  boundaryLayer.definitionExpression = "1=1"; // reset to none selected
  arcgisMap.view.goTo(boundaryLayer.fullExtent);
  timeControl?.hide();
  clearTimeseriesPanel(appInstructions);
  const possiblyExistingLayer = arcgisMap.map.layers.find(l => l.title === "GRACE Anomalies");
  if (possiblyExistingLayer) arcgisMap.map.layers.remove(possiblyExistingLayer);
}

// Switch between the 1.0 and 0.5 degree stores. Every memoized read in this
// module belongs to the store it came from — the coordinate arrays, the time
// axis, the opened variable nodes, and each variable's whole-world frames — so
// all of them are dropped together and whichever view is showing reloads itself.
// Nothing is deleted from IndexedDB: its keys already carry the store URL, so a
// switch back to a resolution that was loaded once is served from the cache.
const setHalfDegreeCells = (enabled) => {
  if (displayConfig.halfDegreeCells === enabled) return;
  displayConfig.halfDegreeCells = enabled;

  coordsPromise = null;
  geoPromise = null;
  timeDates = null;
  timeDatesPromise = null;
  for (const varName of Object.keys(varNodePromises)) delete varNodePromises[varName];
  globalView.byVar = {};
  globalView.gridVar = null;
  globalView.geo = null;
  globalView.renderer?.clear();

  prefetchGlobalVariables();

  if (globalView.active) {
    analyzeGlobalView({keepView: true});
  } else if (lastAnalyzedPolygon) {
    // Same region, other store. The camera is already there, hence no zoom.
    main({polygon: lastAnalyzedPolygon, zoomTarget: null})
      .catch((err) => console.error("Failed to re-run the analysis at the new resolution", err));
  }
  // Neither view showing (the instructions panel): the next analysis picks it up.
};

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
  arcgisMap.map.add(boundaryLayer);
  // Preload the boundaries for later regional use; the camera is set by whichever
  // view we start in (global by default), so don't fit to the boundary extent here.
  boundaryLayer.load().then(buildRegionList).catch((err) => {
    // A panel with no rows is survivable — the outlines are still clickable —
    // so this reports rather than throwing out of boot.
    console.error("Could not build the region list", err);
  });
  // Honors VITE_SETTINGS_SHOW_MASCONS; a no-op unless the deployment starts with
  // the footprints on.
  applyMasconVisibility();

  // dock the overlays inside the map UI, adding them to each corner in stack
  // order: top-right holds the drawing tools, then the load-progress bar, the
  // shared color bar, and the layer dropdown beneath it; the compact time
  // slider sits bottom-left.
  arcgisMap.view.ui.add(drawControl, "top-right");
  arcgisMap.view.ui.add(globalProgressDiv, "top-right");
  arcgisMap.view.ui.add(mapLegendDiv, "top-right");

  // Clicking a region analyzes it, replacing the popup's single button. The
  // sketch tool owns the pointer while a polygon is being drawn, and the global
  // view hides the outlines entirely, so both are excluded — otherwise a click
  // meant for a vertex would kick off an analysis of whatever is underneath.
  arcgisMap.view.on("click", async (event) => {
    if (!boundaryLayer.visible || sketch?.state === "active") return;
    const {results} = await arcgisMap.view.hitTest(event, {include: boundaryLayer});
    const hit = results.find((r) => r.graphic?.attributes?.id != null);
    if (hit) analyzeGlobalRegion({regionId: hit.graphic.attributes.id, name: hit.graphic.attributes.n});
  });

  // "Home" is the same thing the Regions button does: drop the analysis and go
  // back to the full set of outlines.
  crumbHome.addEventListener("click", () => resetLayers());

  regionFilter.addEventListener("input", applyRegionFilter);

  document
    .querySelector("#global-view-button")
    .addEventListener("click", () => analyzeGlobalView());

  // Layer dropdown: whichever view is active re-renders itself from the newly
  // selected variable.
  variableSelect.addEventListener("change", () => {
    displayConfig.variable = variableSelect.value;
    if (globalView.active) analyzeGlobalView({keepView: true});
    else regionalVariableHandler?.();
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

  arcgisMap.map.add(drawLayer);
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
      globalView.renderer.layer.opacity = displayConfig.opacity;
      globalView.renderer.setStops(generateStops());
      globalView.renderer.setBorders({show: displayConfig.showBorders, width: displayConfig.borderWidth});
      globalView.renderer.redraw();
      updateMapLegend();
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
        outline: displayConfig.showBorders
          ? {color: [0, 0, 0, 1], width: displayConfig.borderWidth}
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
  paletteOptions.addEventListener("change", (e) => {
    if (e.target.name !== "color-palette") return;
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

  // Half degree cells. Reloads from the other store, so it is the one setting
  // here that costs a download rather than a restyle.
  halfDegreeToggle.addEventListener("change", (e) => {
    setHalfDegreeCells(e.target.checked);
  });

  // ---- Upload modal ----
  const uploadModal = document.getElementById("upload-modal");
  const uploadDropZone = document.getElementById("upload-drop-zone");
  const uploadFileInput = document.getElementById("upload-file-input");
  const uploadBrowseButton = document.getElementById("upload-browse-button");
  const uploadFileInfo = document.getElementById("upload-file-info");
  const uploadFileName = document.getElementById("upload-file-name");
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
      const uploadedName = selectedFile.name.replace(/\.(geo)?json$/i, "");
      uploadModal.classList.add("hidden");
      setBreadcrumb(uploadedName);
      drawLayer.removeAll();
      drawLayer.add(new Graphic({geometry: polygon, symbol: drawnSymbol}));
      await analyzeDrawnPolygon({polygon});
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
