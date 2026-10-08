import Extent from "@arcgis/core/geometry/Extent.js";
import SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
import MediaLayer from "@arcgis/core/layers/MediaLayer.js";
import ExtentAndRotationGeoreference from "@arcgis/core/layers/support/ExtentAndRotationGeoreference.js";
import ImageElement from "@arcgis/core/layers/support/ImageElement.js";

// Draws one time step of the global grid into an ImageData and shows it on a
// MediaLayer. This is raster rendering: a FeatureLayer + applyEdits would need
// 54,000 polygon edits per animation frame, while this path costs a few
// milliseconds per frame regardless of cell count.
//
// The image is pre-warped to Web Mercator on the CPU (a per-output-row lookup
// into the source latitude rows) and georeferenced with a Mercator extent, so
// it registers exactly with the basemap instead of relying on the MediaLayer's
// four-corner warp, which is linear and would misplace mid-latitudes.
const EARTH_RADIUS = 6378137;
const MAX_MERCATOR_LAT = 85.05112878;
// The canvas is sized from the grid rather than fixed, because the MediaLayer
// stretches it and offers no way to ask for nearest-neighbour sampling: at 1440
// px a 1 degree cell was 4 px across, so any zoom past the whole world smeared
// the cells into each other and invented gradients the data does not have.
//
// Eight pixels a cell pushes that out by two zoom levels, which covers the range
// a whole-world view is actually read at. It cannot be pushed indefinitely — one
// world-sized canvas can never stay crisp at every zoom — so the width is capped
// to keep the buffer and the per-frame fill affordable. At the cap a half-degree
// grid gets four pixels a cell, the same as a degree grid used to get.
const TARGET_PX_PER_CELL = 8;
const MIN_CANVAS_WIDTH = 1440;
const MAX_CANVAS_WIDTH = 3072;
// Height follows the width at the aspect the Mercator warp was tuned for.
const CANVAS_ASPECT = 1024 / 1440;
const LUT_SIZE = 1024;

const mercatorY = (latDeg) => EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));
const mercatorX = (lonDeg) => (EARTH_RADIUS * lonDeg * Math.PI) / 180;
const inverseMercatorLat = (y) => ((2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * 180) / Math.PI;

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16)
];

// Cell-boundary line color, packed endianness-safe like the LUT entries. Opaque
// black was too heavy: the line is drawn in canvas pixels and then stretched
// with everything else, so at a few pixels a cell it read as a grid laid over
// the data rather than as edges between cells. Partly transparent, it separates
// the cells without competing with them, and the caller picks the color so it
// can follow the basemap the way every other outline in the app does.
const packColor = ([r, g, b, a = 1]) => {
  const rgba = new Uint8ClampedArray([r, g, b, Math.round(a * 255)]);
  return new Uint32Array(rgba.buffer)[0];
};
const DEFAULT_BORDER_COLOR = [0, 0, 0, 0.55];

// Continuous color lookup table interpolated between the renderer stops, so
// the raster matches the colors the FeatureLayer's visualVariables produce.
// Entries are packed pixels (endianness-safe via the Uint8/Uint32 view pair).
const buildLut = (stops) => {
  const sorted = [...stops].sort((a, b) => a.value - b.value);
  const min = sorted[0].value;
  const max = sorted[sorted.length - 1].value;
  const colors = sorted.map((s) => hexToRgb(s.color));
  const table = new Uint32Array(LUT_SIZE);
  const rgba = new Uint8ClampedArray(4);
  const packed = new Uint32Array(rgba.buffer);
  let seg = 0;
  for (let i = 0; i < LUT_SIZE; i++) {
    const v = min + (i / (LUT_SIZE - 1)) * (max - min);
    while (seg < sorted.length - 2 && v > sorted[seg + 1].value) seg++;
    const span = sorted[seg + 1].value - sorted[seg].value;
    const f = span > 0 ? Math.min(1, Math.max(0, (v - sorted[seg].value) / span)) : 0;
    rgba[0] = colors[seg][0] + f * (colors[seg + 1][0] - colors[seg][0]);
    rgba[1] = colors[seg][1] + f * (colors[seg + 1][1] - colors[seg][1]);
    rgba[2] = colors[seg][2] + f * (colors[seg + 1][2] - colors[seg][2]);
    rgba[3] = 255;
    table[i] = packed[0];
  }
  return {table, min, max};
};

export function createGlobalRenderer({title}) {
  const layer = new MediaLayer({title, source: []});

  let grid = null;         // {frames, nT, nLat, nLon}
  let rowOffsets = null;   // canvas row -> source row offset (row * nLon), or -1 outside the grid
  let pxPerCell = 0;       // horizontal pixels per grid cell
  let extent = null;       // mercator extent of the rendered image
  let lut = null;
  // Grid cell boundaries, mirroring the regional layer's outline.
  let borders = {show: false, width: 1, color: DEFAULT_BORDER_COLOR};
  let borderPacked = packColor(DEFAULT_BORDER_COLOR);
  let currentT = 0;
  let element = null;
  // Allocated on the first grid and again whenever the grid's width changes,
  // which is the resolution switch and nothing else.
  let canvasWidth = 0;
  let canvasHeight = 0;
  let imageData = null;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  const sizeCanvasFor = (nLon) => {
    const width = Math.min(MAX_CANVAS_WIDTH, Math.max(MIN_CANVAS_WIDTH, nLon * TARGET_PX_PER_CELL));
    if (width === canvasWidth) return;
    canvasWidth = width;
    canvasHeight = Math.round(width * CANVAS_ASPECT);
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    imageData = new ImageData(canvasWidth, canvasHeight);
  };

  // grid rows run south -> north; canvas rows run top (north) -> bottom
  const setGrid = ({frames, nT, nLat, nLon, latEdgeMin, cellSize}) => {
    grid = {frames, nT, nLat, nLon};
    sizeCanvasFor(nLon);
    pxPerCell = Math.floor(canvasWidth / nLon);
    const latEdgeMax = latEdgeMin + nLat * cellSize;
    const yTop = mercatorY(Math.min(latEdgeMax, MAX_MERCATOR_LAT));
    const yBottom = mercatorY(Math.max(latEdgeMin, -MAX_MERCATOR_LAT));
    rowOffsets = new Int32Array(canvasHeight);
    for (let j = 0; j < canvasHeight; j++) {
      const y = yTop - ((j + 0.5) / canvasHeight) * (yTop - yBottom);
      const row = Math.floor((inverseMercatorLat(y) - latEdgeMin) / cellSize);
      rowOffsets[j] = row >= 0 && row < nLat ? row * nLon : -1;
    }
    extent = new Extent({
      xmin: mercatorX(-180),
      xmax: mercatorX(180),
      ymin: yBottom,
      ymax: yTop,
      spatialReference: SpatialReference.WebMercator
    });
  };

  const setStops = (stops) => {
    lut = buildLut(stops);
  };

  const setBorders = (config) => {
    borders = {...borders, ...config};
    borderPacked = packColor(borders.color ?? DEFAULT_BORDER_COLOR);
  };

  const colorize = (t, imageData) => {
    const {frames, nLat, nLon} = grid;
    const px = new Uint32Array(imageData.data.buffer);
    const frameBase = t * nLat * nLon;
    const {table, min, max} = lut;
    const invScale = max > min ? (LUT_SIZE - 1) / (max - min) : 0;
    // Draw cell boundaries only when cells are wide enough for a line to read.
    // Each data cell gets its left edge (vertical line, `bw` px) and top edge
    // (horizontal line, `bw` canvas rows); boundaries are drawn only on cells
    // that actually hold data so the grid doesn't bleed over transparent ocean.
    const drawBorders = borders.show && pxPerCell >= 3;
    // The setting is a line width in the regional layer's pixels, where a cell is
    // whatever the map's zoom makes it. Here a cell is pxPerCell canvas pixels
    // regardless of zoom, so the width is taken as a share of the cell — one
    // eighth per unit — and the line stays proportional when the canvas is sized
    // up for a finer grid instead of doubling in weight.
    const bw = drawBorders
      ? Math.max(1, Math.min(pxPerCell - 1, Math.round((pxPerCell * borders.width) / 8)))
      : 0;
    let prevOffset = -1;
    let sinceTop = 0;
    for (let j = 0; j < canvasHeight; j++) {
      let o = j * canvasWidth;
      const srcOffset = rowOffsets[j];
      if (srcOffset < 0) {
        px.fill(0, o, o + canvasWidth);
        prevOffset = -1;
        continue;
      }
      // canvas rows within `bw` of a data-row change are the cell's top edge
      sinceTop = srcOffset === prevOffset ? sinceTop + 1 : 0;
      prevOffset = srcOffset;
      const topEdge = drawBorders && sinceTop < bw;
      const rowBase = frameBase + srcOffset;
      for (let c = 0; c < nLon; c++) {
        const v = frames[rowBase + c];
        if (v === v) {
          let q = ((v - min) * invScale) | 0;
          if (q < 0) q = 0;
          else if (q >= LUT_SIZE) q = LUT_SIZE - 1;
          px.fill(table[q], o, o + pxPerCell);
          if (drawBorders) {
            px.fill(borderPacked, o, o + bw);                 // left edge
            if (topEdge) px.fill(borderPacked, o, o + pxPerCell); // top edge
          }
        } else {
          px.fill(0, o, o + pxPerCell); // transparent for NaN (oceans, missing months)
        }
        o += pxPerCell;
      }
      // clear the remainder when the width isn't an exact multiple of nLon
      const rowEnd = (j + 1) * canvasWidth;
      if (o < rowEnd) px.fill(0, o, rowEnd);
    }
  };

  // The 2D engine uploads a canvas texture exactly ONCE per ImageElement
  // (views/2d/engine/webgl/Overlay.js only re-uploads HTMLVideoElement and
  // animated GIF/APNG content), and reassigning element.image after load is a
  // silent no-op. Assigning a NEW object to the public `animationOptions`
  // property fires an Overlay watch that disposes the cached texture and
  // requests a render; the next render frame then re-creates the texture from
  // the canvas's current pixels in the same frame (no flicker). Verified
  // against the shipped 4.34.8 code — re-verify on SDK upgrades. If it ever
  // breaks (symptom: animation frozen on its first frame), fall back to
  // creating a fresh ImageElement per frame, adding it with opacity 0,
  // flipping opacities once loaded, then removing the old element (the
  // pattern Esri's Wayback/imagery-explorer apps use).
  const present = () => {
    ctx.putImageData(imageData, 0, 0);
    if (!element) {
      element = new ImageElement({
        image: canvas,
        georeference: new ExtentAndRotationGeoreference({extent})
      });
      layer.source.elements.add(element);
    } else {
      element.animationOptions = {...element.animationOptions};
    }
  };

  const drawFrame = (t) => {
    if (!grid || !lut) return;
    currentT = Math.max(0, Math.min(t, grid.nT - 1));
    colorize(currentT, imageData);
    present();
  };

  const redraw = () => drawFrame(currentT);

  const clear = () => {
    layer.source.elements.removeAll();
    element = null;
  };

  return {layer, setGrid, setStops, setBorders, drawFrame, redraw, clear};
}
