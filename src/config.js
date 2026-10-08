// Single source of truth for every URL the app requests.
//
// Two rules, and nothing in src/ may break them:
//   1. External services are absolute https:// URLs. They do not move when the
//      deployment moves, so they are hard-coded (overridable via env).
//   2. Everything this app ships is resolved through asset(), which prefixes
//      Vite's base path.
//
// A bare leading-slash path ("/regions.geojson") is always a bug: it resolves
// against the *origin* root, so it works in dev and at a root deployment and
// silently 404s — or, behind CloudFront, 503s — the moment the app is served
// from a sub-path like /portal/grace/.

// Vite substitutes this at build time with the resolved `base` from
// vite.config.js, always normalized with a trailing slash.
export const BASE_URL = import.meta.env.BASE_URL || "/";

// Join a ship-with-the-app path (anything in public/) onto the base path.
export const asset = (path) => `${BASE_URL}${String(path).replace(/^\/+/, "")}`;

const fromEnv = (value, fallback) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || fallback;
};

// The zarr store holding every mapped variable, its coordinates, and time axis.
// data/main.py writes one store per target resolution, and the app can be
// pointed at either: the 1.0 degree store is what it loads by default, and the
// half degree store is opt-in (the "half degree water balance cells" setting,
// defaulting to VITE_SETTINGS_HALF_DEGREE_CELLS). Everything downstream —
// cell size, the map raster's georeferencing, the IndexedDB cache keys — is
// derived from whichever store is active, so the two never mix.
export const ZARR_URL = fromEnv(
  import.meta.env.VITE_ZARR_URL_ONE_DEGREE,
).replace(/\/+$/, "");

// The half degree store. Its default follows data/main.py's output naming; a
// deployment that has not published one can leave the setting off, and the app
// reports the store as unavailable if it is switched on anyway.
export const ZARR_URL_HALF_DEGREE = fromEnv(
  import.meta.env.VITE_ZARR_URL_HALF_DEGREE,
  "https://d3hbj0z0f67zhd.cloudfront.net/ggg/grace-gldas-water-balance-0.5.zarr",
).replace(/\/+$/, "");

// The manifest listing the region sets the picker offers; each set's file is
// resolved next to it. Served from public/ by default; point
// VITE_REGION_SETS_URL at an absolute https:// URL to serve the sets from a CDN
// instead, in which case the whole directory moves together.
export const REGION_SETS_URL = fromEnv(import.meta.env.VITE_REGION_SETS_URL, asset("regions/index.json"));

// A set's file, resolved against the manifest's own location so a set never has
// to know where the directory ended up.
export const regionSetUrl = (file) =>
  /^https?:\/\//i.test(file) ? file : new URL(file, new URL(REGION_SETS_URL, window.location.href)).href;

// The native 3 degree GRACE mascon footprints, written by
// data/mascon_boundaries.py. Only the 1706 mascons touching land are shipped
// (0.4 MB) — the other 2845 are open ocean and irrelevant to groundwater. Run
// the script with --include-ocean and point this at grace-mascons.geojson if
// the full 4551 tiling is ever wanted. Only fetched when the user turns the
// layer on, so it costs nothing at startup.
export const MASCONS_URL = fromEnv(import.meta.env.VITE_MASCONS_URL, asset("grace-mascons-land.geojson"));

// Nothing here resolves the header logo or its link: index.html carries those as
// %VITE_LOGO_SRC% / %VITE_LOGO_HREF% template strings, substituted by Vite at
// build time and used verbatim in the served HTML.
