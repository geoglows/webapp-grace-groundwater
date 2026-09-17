// ---- env readers -----------------------------------------------------------
const ON = new Set(["true", "1", "yes", "on"]);
const OFF = new Set(["false", "0", "no", "off"]);

const envText = (value, fallback = "") => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || fallback;
};

const envBool = (value, fallback) => {
  const v = envText(value).toLowerCase();
  if (ON.has(v)) return true;
  if (OFF.has(v)) return false;
  return fallback;
};

const envNumber = (value, fallback, {min = -Infinity, max = Infinity} = {}) => {
  const n = Number(envText(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};

// A value that must be one of a fixed set (a variable name, a palette, a view).
// Anything else — including a name that was renamed in code but not in .env —
// falls back rather than silently selecting nothing.
const envChoice = (value, allowed, fallback) => {
  const v = envText(value);
  return allowed.includes(v) ? v : fallback;
};

const envList = (value, allowed, fallback) => {
  const items = envText(value)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => allowed.includes(s));
  return items.length ? items : fallback;
};

// ---- the mapped variables --------------------------------------------------
// `color` is the time series line for that variable, so switching layers is
// visible in the chart and not only in its title. Four hues far enough apart to
// tell at a glance on the panel's dark ground, each picked to suit its quantity
// where one suggests itself: green for soil, near-white ice for snow.
//
// The map's anomaly cells are deliberately not colored from these — they carry
// the diverging red/blue scale, which is about sign and magnitude rather than
// about which variable is showing.
// The key is the label: it is what the store calls the array, what the layer
// dropdown shows in parentheses, and what a CSV column is headed, so the panel
// and the legend say the same thing as everything else.
// `resolution` is the grid each variable is read on, and it is a property of the
// science rather than a user preference.
//
// TWSa is GRACE, distributed on a 0.5 degree grid, so that is where it is read.
// Serving it at 1.0 degree averages across mascon edges — the 3 degree caps are
// aligned to half-degree lines, so a 1.0 degree cell straddles two of them — and
// produces intermediate values that are in no GRACE solution.
//
// Everything else is the GLDAS three-model mean, and JPL protocol is to bring
// the models together on the coarsest of them: NOAH (0.25 degree) is averaged up
// to VIC and CLSM's 1.0 degree, not the other way round. The half-degree store
// builds these by downscaling VIC and CLSM instead, which manufactures detail
// those models never had, so they are never read from it. GWSa is
// TWSa - SWEa - CANa - SMa and can be no finer than its components.
export const VARIABLES = {
  GWSa: {longName: "Groundwater Storage Anomaly", color: "#60a5fa", resolution: "1.0"},
  TWSa: {longName: "Total Water Storage Anomaly", color: "#fb923c", resolution: "0.5"},
  SMa: {longName: "Soil Moisture Anomaly", color: "#34d399", resolution: "1.0"},
  SWEa: {longName: "Snow Water Equivalent Anomaly", color: "#e2e8f0", resolution: "1.0"},
  CANa: {longName: "Canopy Water Storage Anomaly", color: "#c084fc", resolution: "1.0"},
};
const VARIABLE_KEYS = Object.keys(VARIABLES);

// ---- color palettes --------------------------------------------------------
export const COLOR_PALETTES = {
  default: {
    label: "Red-White-Blue",
    stops: [
      {position: -1, color: "#ff004e"},
      {position: 0, color: "#ffffff"},
      {position: 1, color: "#1c6eec"},
    ],
  },
  viridis: {
    label: "Viridis (Colorblind Safe)",
    stops: [
      {position: -1, color: "#440154"},
      {position: 0, color: "#21918c"},
      {position: 1, color: "#fde725"},
    ],
  },
  cividis: {
    label: "Cividis (Colorblind Safe)",
    stops: [
      {position: -1, color: "#00204d"},
      {position: 0, color: "#7c7b78"},
      {position: 1, color: "#ffea46"},
    ],
  },
  "brown-teal": {
    label: "Brown-Teal (Colorblind Safe)",
    stops: [
      {position: -1, color: "#8c510a"},
      {position: 0, color: "#f5f5f5"},
      {position: 1, color: "#01665e"},
    ],
  },
  "purple-green": {
    label: "Purple-Green (Colorblind Safe)",
    stops: [
      {position: -1, color: "#762a83"},
      {position: 0, color: "#f7f7f7"},
      {position: 1, color: "#1b7837"},
    ],
  },
  rainbow: {
    label: "Red-Yellow-Green-Blue",
    stops: [
      {position: -1, color: "#d73027"},
      {position: -0.33, color: "#fee08b"},
      {position: 0.33, color: "#a6d96a"},
      {position: 1, color: "#1a6698"},
    ],
  },
};
const PALETTE_KEYS = Object.keys(COLOR_PALETTES);

// A palette drawn as a CSS gradient on the -1..1 axis, for the settings-modal
// swatches. The color bar on the map builds its own gradient from the generated
// stops instead, because those carry the live data range.
export const paletteCssGradient = (key) => {
  const stops = (COLOR_PALETTES[key] ?? COLOR_PALETTES[DEFAULT_PALETTE]).stops;
  const parts = stops.map(({position, color}) => `${color} ${(((position + 1) / 2) * 100).toFixed(1)}%`);
  return `linear-gradient(to right, ${parts.join(", ")})`;
};

// Header branding (VITE_LOGO_SRC / _HREF / _ALT) is deliberately absent from
// this file: index.html carries those as %VITE_*% template strings that Vite
// substitutes at build time, so they never pass through JavaScript. The app
// title is not configurable at all — it is literal text in index.html.

// ---- map camera ------------------------------------------------------------
export const MAP_BASEMAP = envText(import.meta.env.VITE_MAP_DEFAULT_BASEMAP, "gray-vector");
export const MAP_CENTER = [
  envNumber(import.meta.env.VITE_MAP_CENTER_LON, 0, {min: -180, max: 180}),
  envNumber(import.meta.env.VITE_MAP_CENTER_LAT, 20, {min: -90, max: 90}),
];
export const MAP_ZOOM = envNumber(import.meta.env.VITE_MAP_ZOOM, 4, {min: 0, max: 46});

// ---- what the app opens with -----------------------------------------------
// "global" is the whole-world animation, "region" is the regional view with
// the region outlines showing and the instructions in the chart panel.
export const DEFAULT_VIEW = envChoice(import.meta.env.VITE_DEFAULT_VIEW, ["global", "region"], "global");
export const DEFAULT_VARIABLE = envChoice(import.meta.env.VITE_DEFAULT_VARIABLE, VARIABLE_KEYS, "GWSa");
export const DEFAULT_PALETTE = envChoice(import.meta.env.VITE_DEFAULT_COLOR_PALETTE, PALETTE_KEYS, "default");
// Which variables are downloaded eagerly at startup, each in its own worker.
// The rest load on first selection. Paying for the ones the layer dropdown is
// actually used for up front makes switching between them instant.
export const PREFETCH_VARIABLES = envList(import.meta.env.VITE_PREFETCH_VARIABLES, VARIABLE_KEYS, ["GWSa", "TWSa"]);

// ---- units / labels --------------------------------------------------------
export const UNITS = envText(import.meta.env.VITE_UNITS_LABEL, "cm");
// The quantity every variable is measured in; used for the chart's y axis.
export const VALUE_LABEL = envText(import.meta.env.VITE_VALUE_LABEL, "Liquid Water Equivalent");

// ---- layer + color bar defaults --------------------------------------------
// Seeds displayConfig in main.js and, through it, every control in the settings
// modal. The user's changes live for the session only; a refresh returns to
// whatever the deployment configured here.
export const DISPLAY_DEFAULTS = {
  variable: DEFAULT_VARIABLE,
  colorPalette: DEFAULT_PALETTE,
  opacity: envNumber(import.meta.env.VITE_SETTINGS_LAYER_OPACITY, 1, {min: 0, max: 1}),
  showBorders: envBool(import.meta.env.VITE_SETTINGS_SHOW_CELL_BORDERS, false),
  borderWidth: envNumber(import.meta.env.VITE_SETTINGS_CELL_BORDER_WIDTH, 0.5, {min: 0.5, max: 3}),
  showLegend: envBool(import.meta.env.VITE_SETTINGS_MAP_LEGEND_VISIBLE, true),
  // Whether the time series line bridges the months GRACE has no data for —
  // scattered gaps plus the ~11 month GRACE/GRACE-FO handover. On, the line is
  // continuous and easier to read as a trend; off, it breaks at every gap and
  // the record's coverage is visible instead.
  fillGaps: envBool(import.meta.env.VITE_SETTINGS_FILL_GAPS, true),
  // Region names drawn on the outlines in the regional view.
  showRegionNames: envBool(import.meta.env.VITE_SETTINGS_SHOW_REGION_NAMES, true),
  // Labels stay off until the view is zoomed in past this scale. Collision
  // dropping alone is not enough at continent zoom: the names that survive are
  // still longer than the regions they sit on, so they read as a wall of text
  // over the map. This sits above the opening view's scale (zoom 5 is ~1:18.5M)
  // so names are already up when the app loads, holding off only at continent
  // zoom and wider. Larger shows them sooner.
  regionLabelMinScale: envNumber(import.meta.env.VITE_SETTINGS_REGION_LABEL_MIN_SCALE, 25_000_000, {min: 0}),
  // The 3 degree GRACE mascon outlines. Off by default: it is an interpretation
  // aid, not data, and turning it on is what pays for the GeoJSON download.
  showMascons: envBool(import.meta.env.VITE_SETTINGS_SHOW_MASCONS, false),
  masconWidth: envNumber(import.meta.env.VITE_SETTINGS_MASCON_WIDTH, 0.75, {min: 0.5, max: 3}),
  dynamicColorScale: envBool(import.meta.env.VITE_SETTINGS_DYNAMIC_COLOR_SCALE, true),
  fixedMaxValue: envNumber(import.meta.env.VITE_SETTINGS_FIXED_COLOR_SCALE_MAX, 30, {min: 1}),
  maxValue: envNumber(import.meta.env.VITE_SETTINGS_FIXED_COLOR_SCALE_MAX, 30, {min: 1}),
};

// ---- time slider -----------------------------------------------------------
export const GLOBAL_PLAY_RATE_MS = envNumber(import.meta.env.VITE_GLOBAL_PLAY_RATE_MS, 250, {min: 50});
export const REGIONAL_PLAY_RATE_MS = envNumber(import.meta.env.VITE_REGIONAL_PLAY_RATE_MS, 1000, {min: 50});

// ---- map/chart split -------------------------------------------------------
export const CHART_PANEL_MIN_PERCENT = envNumber(import.meta.env.VITE_CHART_PANEL_MIN_PERCENT, 12, {min: 5, max: 50});
export const CHART_PANEL_MAX_PERCENT = envNumber(import.meta.env.VITE_CHART_PANEL_MAX_PERCENT, 80, {
  min: CHART_PANEL_MIN_PERCENT,
  max: 95,
});
export const CHART_PANEL_PERCENT = envNumber(import.meta.env.VITE_CHART_PANEL_PERCENT, 32, {
  min: CHART_PANEL_MIN_PERCENT,
  max: CHART_PANEL_MAX_PERCENT,
});
