/**
 * Classify each region by the linear trend in its area-mean anomaly, so the
 * outlines can be colored by whether storage is rising or falling.
 *
 * The categories and the least-squares fit follow aquiferx's utils/trends.ts, so
 * the two apps classify the same way and their legends read alike. What differs
 * is the thresholds, which are in cm/year of liquid water equivalent here rather
 * than feet or metres of water table.
 */

// Ordered widest-decline first; classify() returns the first match, so each test
// only has to exclude what came before it.
export const TREND_CATEGORIES = [
  {key: "extreme-decline", label: "Extreme decline", color: "#dc2626", test: (s, t) => s < -t.extreme},
  {key: "decline", label: "Decline", color: "#fb923c", test: (s, t) => s < -t.moderate},
  {key: "static", label: "Static", color: "#facc15", test: (s, t) => s <= t.moderate},
  {key: "increase", label: "Increase", color: "#38bdf8", test: (s, t) => s <= t.extreme},
  {key: "extreme-increase", label: "Extreme increase", color: "#2563eb", test: () => true},
];

// A region with no usable months. Grey rather than a sixth hue: it is the
// absence of a classification, not another one.
export const INSUFFICIENT = {key: "insufficient", label: "Insufficient data", color: "#64748b"};

const MS_PER_YEAR = 365.25 * 86400000;

/**
 * Least-squares slope of `values` against `dates`, in units per year. NaN
 * samples are skipped, so the missing GRACE months and the GRACE/GRACE-FO gap
 * drop out rather than being interpolated across.
 *
 * Returns null when fewer than `minPoints` months have data, or when every
 * remaining month falls on one date — both leave the slope undefined rather
 * than zero, and a zero would read as "static".
 */
export function computeSlope(dates, values, {minPoints = 24} = {}) {
  let n = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  for (let i = 0; i < values.length; i++) {
    const y = values[i];
    if (!Number.isFinite(y)) continue;
    const x = dates[i].getTime() / MS_PER_YEAR;
    n++;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }
  if (n < minPoints) return null;
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  return (n * sumXY - sumX * sumY) / denom;
}

/** The category a slope falls in, or INSUFFICIENT for a null slope. */
export function classify(slope, thresholds) {
  if (slope === null) return INSUFFICIENT;
  return TREND_CATEGORIES.find((c) => c.test(slope, thresholds)) ?? INSUFFICIENT;
}

/**
 * Is (x, y) inside these polygon rings?
 *
 * Ray casting in plain arithmetic rather than through the SDK's geometry
 * operators: classifying every region means testing every cell center in every
 * region's bounding box, and the operators are WASM calls that made the
 * per-region analysis slow enough to need time-slicing. Rings from a
 * MultiPolygon are passed together — a point in any of them is in the region,
 * and the crossing count handles holes on its own by parity.
 */
export function pointInRings(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * Area-mean series for one region, read off the whole-world frames.
 *
 * Cells are taken by their centers falling inside the region and weighted by
 * cos(latitude), which is an approximation: the per-region analysis in main.js
 * weights by each cell's true geodetic overlap with the boundary, and a cell
 * straddling the edge counts fully here or not at all. That is deliberate. The
 * exact version costs three WASM calls per cell, which is affordable for the one
 * region being analyzed and not for all 81 at once, and a trend classification
 * is robust to edge cells in a way a plotted value is not.
 */
export function regionMeanSeries({rings, extent, frames, nT, nLat, nLon, lat, lon}) {
  const inside = [];
  for (let iy = 0; iy < nLat; iy++) {
    const y = lat[iy];
    if (y < extent.ymin || y > extent.ymax) continue;
    const w = Math.cos((y * Math.PI) / 180);
    for (let ix = 0; ix < nLon; ix++) {
      const x = lon[ix];
      if (x < extent.xmin || x > extent.xmax) continue;
      if (pointInRings(x, y, rings)) inside.push({offset: iy * nLon + ix, w});
    }
  }
  if (!inside.length) return null;

  const frameSize = nLat * nLon;
  const series = new Float64Array(nT);
  for (let t = 0; t < nT; t++) {
    const base = t * frameSize;
    let sum = 0;
    let weight = 0;
    for (const {offset, w} of inside) {
      const v = frames[base + offset];
      if (!Number.isFinite(v)) continue;
      sum += v * w;
      weight += w;
    }
    series[t] = weight > 0 ? sum / weight : NaN;
  }
  return series;
}

/**
 * Least-squares slope for every cell of a whole-world frame series, in units
 * per year. NaN where a cell has fewer than `minPoints` months with data, which
 * is the ocean and the ice sheets as well as the genuinely sparse.
 *
 * Accumulated time-major, one whole frame at a time, rather than cell by cell.
 * The frames are time-major, so a single cell's series is strided a whole frame
 * apart — at 0.5 degree that is 864 KB between consecutive reads, so every read
 * of a cell-major loop is a cache miss, 60 million of them. Streaming frames in
 * order reads the buffer sequentially and pays instead for five accumulator
 * arrays, which are small enough to stay resident.
 */
export function perCellSlopes({frames, nT, nLat, nLon, dates, minPoints = 24}) {
  const frameSize = nLat * nLon;
  const n = new Int32Array(frameSize);
  const sumX = new Float64Array(frameSize);
  const sumY = new Float64Array(frameSize);
  const sumXY = new Float64Array(frameSize);
  const sumX2 = new Float64Array(frameSize);

  for (let t = 0; t < nT; t++) {
    const x = dates[t].getTime() / MS_PER_YEAR;
    const x2 = x * x;
    const base = t * frameSize;
    for (let c = 0; c < frameSize; c++) {
      const y = frames[base + c];
      if (!Number.isFinite(y)) continue;
      n[c]++;
      sumX[c] += x;
      sumY[c] += y;
      sumXY[c] += x * y;
      sumX2[c] += x2;
    }
  }

  const slopes = new Float32Array(frameSize).fill(NaN);
  for (let c = 0; c < frameSize; c++) {
    if (n[c] < minPoints) continue;
    const denom = n[c] * sumX2[c] - sumX[c] * sumX[c];
    if (denom === 0) continue;
    slopes[c] = (n[c] * sumXY[c] - sumX[c] * sumY[c]) / denom;
  }
  return slopes;
}
