// Seasonal gap filling for GRACE-derived series (GWSa, TWSa).
//
// A port of the method in the training notebook
// (training.geoglows.org: grace_gap_fill_and_recharge.ipynb, after Barbosa et
// al. 2022), which fills the same months with the same values:
// test/gapFill.test.mjs checks this one against the notebook's saved output.
// The notebook has since been retired, and the training site's Gap-Filling
// Method page (docs/grace/gap-filling/method.en.md) documents this code, so
// update that page with any change to the method here.
//
//   Y(t) = continuous piecewise-linear trend + 12 monthly levels,
//
// fitted jointly by least squares on the observed months only. The trend has
// 0-3 breakpoints, chosen by BIC. A filled month is the model plus a residual
// correction interpolated linearly across the gap from the observed months on
// either side, so a one-month gap behaves like interpolation between its
// neighbours and a long one keeps the seasonal shape while meeting the
// observations at both ends. Observed months are never changed.
//
// No DOM, no ArcGIS, no Chart.js: this module has to run under plain Node for
// the parity test, and nothing here needs more than arrays.

// The notebook's constants, by the same names.
const MIN_SEGMENT_MONTHS = 36; // shortest trend segment between two breakpoints
const END_BUFFER_MONTHS = 48; // closest a breakpoint may be to either end of the record
const MIN_BIC_DROP = 10; // BIC must fall by at least this much to accept more breakpoints
const MAX_BREAKPOINTS = 3;
const GRID_STEP = 3; // months between candidate breakpoints in the coarse search
const REFINE_TOLERANCE = 1e-9; // a one-month nudge must lower the RSS by more than this

/**
 * A month as one integer, so months subtract: year * 12 + zero-based month.
 * Reads the LOCAL fields, because the app's dates carry the dataset's calendar
 * date there (toDisplayDate in main.js).
 */
export const monthIndexOf = (date) => date.getFullYear() * 12 + date.getMonth();

// ---- the regression ----------------------------------------------------------
//
// The notebook builds the full design matrix — t, one hinge max(t - b, 0) per
// breakpoint, and twelve 0/1 month columns — and hands it to numpy's lstsq for
// every candidate. Doing that here would be ~44,000 SVDs of a 255 x 16 matrix
// for the three-breakpoint search, which is seconds in the browser.
//
// The twelve month columns are an indicator per calendar month, and
// regressing on an indicator set is the same as subtracting each month's mean
// (Frisch-Waugh-Lovell). So every column and y are demeaned within calendar
// month once, and each candidate is a regression on at most four demeaned
// trend columns: a 4 x 4 solve plus one pass for the residual. The fitted
// slopes, residuals, RSS and therefore BIC are identical to the full fit, and
// each monthly level is recovered afterwards as the mean of y minus the trend
// over that month's observations, which is what lstsq's month coefficients
// are.

// Solve the small symmetric system A x = b by Gaussian elimination with partial
// pivoting. A is at most 4 x 4 here, so nothing cleverer earns its keep.
const solve = (A, b) => {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const pivot = M[c][c];
    if (pivot === 0) return null; // singular: a candidate with an empty segment
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / pivot;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
};

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/**
 * Everything about the observed months that does not depend on where the
 * breakpoints go, plus caches for what does. `t` is months since the first
 * observation, `month` the calendar month 0-11.
 */
const makeProblem = (t, month, y) => {
  const n = y.length;
  const groups = Array.from({length: 12}, () => []);
  for (let i = 0; i < n; i++) groups[month[i]].push(i);

  const demean = (v) => {
    const out = new Float64Array(n);
    for (const g of groups) {
      if (!g.length) continue;
      let s = 0;
      for (const i of g) s += v[i];
      const mean = s / g.length;
      for (const i of g) out[i] = v[i] - mean;
    }
    return out;
  };

  const yd = demean(y);
  const td = demean(t);
  const hinges = new Map(); // breakpoint month -> demeaned max(t - b, 0)
  const hinge = (b) => {
    let h = hinges.get(b);
    if (!h) {
      h = demean(Array.from(t, (ti) => Math.max(ti - b, 0)));
      hinges.set(b, h);
    }
    return h;
  };
  // Gram entries are reused across thousands of candidate sets, so each pair's
  // dot product is computed once. Column key: -1 for t, otherwise the breakpoint
  // (months since the first observation, so well under KEY_SPAN). The pair key
  // is numeric because building a string per lookup was most of the search time.
  const KEY_SPAN = 1 << 15;
  const dots = new Map();
  const col = (key) => (key < 0 ? td : hinge(key));
  const gram = (a, b) => {
    const k = a <= b ? (a + 1) * KEY_SPAN + (b + 1) : (b + 1) * KEY_SPAN + (a + 1);
    let v = dots.get(k);
    if (v === undefined) {
      v = dot(col(a), col(b));
      dots.set(k, v);
    }
    return v;
  };
  const withY = new Map();
  const xy = (a) => {
    let v = withY.get(a);
    if (v === undefined) {
      v = dot(col(a), yd);
      withY.set(a, v);
    }
    return v;
  };

  const yy = dot(yd, yd);

  // The RSS alone, from the normal equations: y'y - beta'X'y. No pass over the
  // data, which is what makes the three-breakpoint grid (~10,000 valid sets)
  // cheap. The subtraction costs digits, roughly 1e-12 of the RSS here, which
  // cannot reorder candidates that differ by anything real, so it is used only
  // to rank the coarse grid. Everything that is compared against a tolerance or
  // reported goes through fit() below.
  const quickRss = (breakpoints) => {
    const keys = [-1, ...breakpoints];
    const rhs = keys.map(xy);
    const beta = solve(keys.map((a) => keys.map((b) => gram(a, b))), rhs);
    return beta ? yy - dot(beta, rhs) : Infinity;
  };

  // Least-squares fit for fixed breakpoints, as fit_trend_seasonal: returns the
  // trend coefficients (slope, then one slope change per breakpoint), the RSS
  // and the BIC. The RSS is summed from the residuals rather than taken as
  // y'y - beta'X'y, which loses digits to cancellation — and the refinement
  // step compares RSS values to within 1e-9.
  const fit = (breakpoints) => {
    const keys = [-1, ...breakpoints];
    const A = keys.map((a) => keys.map((b) => gram(a, b)));
    const beta = solve(A, keys.map(xy));
    if (!beta) return null;
    const cols = keys.map(col);
    let rss = 0;
    for (let i = 0; i < n; i++) {
      let r = yd[i];
      for (let j = 0; j < cols.length; j++) r -= beta[j] * cols[j][i];
      rss += r * r;
    }
    // 1 slope + 1 slope change and 1 location per breakpoint + 12 monthly levels.
    const k = 1 + 2 * breakpoints.length + 12;
    const bic = n * Math.log(rss / n) + k * Math.log(n);
    return {breakpoints: [...breakpoints], beta, rss, bic, n};
  };

  return {fit, quickRss, groups};
};

// breakpoints_valid: at least MIN_SEGMENT_MONTHS apart and END_BUFFER_MONTHS
// from either end of the record.
const breakpointsValid = (bps, tFirst, tLast) => {
  if (bps[0] - tFirst < END_BUFFER_MONTHS || tLast - bps[bps.length - 1] < END_BUFFER_MONTHS) return false;
  for (let i = 1; i < bps.length; i++) if (bps[i] - bps[i - 1] < MIN_SEGMENT_MONTHS) return false;
  return true;
};

// best_breakpoints: grid search over candidates GRID_STEP months apart, then
// each breakpoint nudged one month at a time until the fit stops improving.
// The candidate sets are visited in the order itertools.combinations yields
// them and a later set wins only on a strictly smaller RSS, so a tie resolves
// the way the notebook resolves it. null when the record is too short for this
// many segments.
const bestBreakpoints = (problem, tFirst, tLast, count) => {
  if (count === 0) return problem.fit([]);

  const candidates = [];
  for (let b = tFirst + END_BUFFER_MONTHS; b <= tLast - END_BUFFER_MONTHS; b += GRID_STEP) candidates.push(b);

  let bestCombo = null;
  let bestRss = Infinity;
  const consider = (combo) => {
    if (!breakpointsValid(combo, tFirst, tLast)) return;
    const rss = problem.quickRss(combo);
    if (rss < bestRss) {
      bestRss = rss;
      bestCombo = combo;
    }
  };
  // Lexicographic, like itertools.combinations. Written out per count rather
  // than recursively because count is at most 3 and this is the hot loop.
  const m = candidates.length;
  if (count === 1) {
    for (let i = 0; i < m; i++) consider([candidates[i]]);
  } else if (count === 2) {
    for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) consider([candidates[i], candidates[j]]);
  } else {
    for (let i = 0; i < m; i++) {
      for (let j = i + 1; j < m; j++) {
        // Every later j is further away still, but an early j can be too close;
        // skipping it here only saves the validity check consider() would fail.
        if (candidates[j] - candidates[i] < MIN_SEGMENT_MONTHS) continue;
        for (let k = j + 1; k < m; k++) consider([candidates[i], candidates[j], candidates[k]]);
      }
    }
  }
  if (bestCombo === null) return null;

  let best = problem.fit(bestCombo);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < count; i++) {
      for (const shift of [-1, 1]) {
        const trial = [...best.breakpoints];
        trial[i] += shift;
        if (!breakpointsValid(trial, tFirst, tLast)) continue;
        const model = problem.fit(trial);
        if (model && model.rss < best.rss - REFINE_TOLERANCE) {
          best = model;
          improved = true;
        }
      }
    }
  }
  return best;
};

/**
 * Fill the gaps in one monthly series with the notebook's trend + seasonal
 * model.
 *
 * `values` is the series (NaN where GRACE has no month) and `months` the
 * matching monthIndexOf() values. Months before the first observation and after
 * the last are left alone, as the notebook trims to that span: there is nothing
 * on the far side of them to pin a correction to.
 *
 * Returns null when the seasonal cycle cannot be estimated (a calendar month
 * observed fewer than twice — the notebook raises in that case) or there is no
 * gap to fill. Otherwise:
 *   filled     observed where present, model + correction in the gaps, NaN
 *              outside the observed span
 *   isFilled   1 for each month that was filled
 *   trend, seasonal   the model's two parts, as evaluate_model returns them
 *              (seasonal averages zero over the year)
 *   breakpoints       the chosen breakpoints as month indices
 *   bic        one {breakpoints, bic, rmse} row per breakpoint count tried
 */
export function seasonalFill(values, months) {
  const len = values.length;
  let first = -1;
  let last = -1;
  for (let i = 0; i < len; i++) {
    if (Number.isFinite(values[i])) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;

  const obsIdx = [];
  for (let i = first; i <= last; i++) if (Number.isFinite(values[i])) obsIdx.push(i);
  if (obsIdx.length === last - first + 1) return null; // no interior gap

  const start = months[first];
  const t = obsIdx.map((i) => months[i] - start);
  const month = obsIdx.map((i) => ((months[i] % 12) + 12) % 12);
  const y = obsIdx.map((i) => values[i]);

  const perMonth = new Array(12).fill(0);
  for (const m of month) perMonth[m]++;
  if (perMonth.some((c) => c < 2)) return null;

  // select_model with n_breakpoints="auto". Starting from a straight trend, a
  // fit with more breakpoints replaces the chosen one only if its BIC is at
  // least MIN_BIC_DROP lower than the chosen one's — each comparison is
  // against the current choice, not against the straight line.
  const problem = makeProblem(t, month, y);
  const tFirst = t[0];
  const tLast = t[t.length - 1];
  const fits = [];
  for (let c = 0; c <= MAX_BREAKPOINTS; c++) {
    const model = bestBreakpoints(problem, tFirst, tLast, c);
    if (model) fits[c] = model;
  }
  let chosen = fits.findIndex(Boolean);
  if (chosen < 0) return null;
  for (let c = chosen + 1; c < fits.length; c++) {
    if (fits[c] && fits[c].bic <= fits[chosen].bic - MIN_BIC_DROP) chosen = c;
  }
  const model = fits[chosen];

  // evaluate_model. The trend part is built in raw t (not demeaned), and each
  // monthly level is the mean of y minus that trend over the month's
  // observations, which is the lstsq month coefficient. Shifting the levels to
  // average zero and the trend up by the same amount leaves the sum unchanged.
  const trendAt = (ti) => {
    let s = model.beta[0] * ti;
    model.breakpoints.forEach((b, j) => {
      s += model.beta[j + 1] * Math.max(ti - b, 0);
    });
    return s;
  };
  const level = new Array(12).fill(0);
  problem.groups.forEach((g, m) => {
    let s = 0;
    for (const i of g) s += y[i] - trendAt(t[i]);
    level[m] = s / g.length;
  });
  const offset = level.reduce((a, b) => a + b, 0) / 12;

  const trend = new Float64Array(len).fill(NaN);
  const seasonal = new Float64Array(len).fill(NaN);
  const filled = new Float64Array(len).fill(NaN);
  const isFilled = new Uint8Array(len);
  for (let i = first; i <= last; i++) {
    const ti = months[i] - start;
    trend[i] = trendAt(ti) + offset;
    seasonal[i] = level[((months[i] % 12) + 12) % 12] - offset;
  }

  // The residual correction, linear across each gap between the observed
  // months that bound it. Interpolated in months rather than array positions;
  // on the app's regular monthly axis the two are the same, and pandas'
  // interpolate() in the notebook works on positions.
  let prev = first;
  for (const i of obsIdx) {
    filled[i] = values[i];
    if (i - prev > 1) {
      const r0 = values[prev] - (trend[prev] + seasonal[prev]);
      const r1 = values[i] - (trend[i] + seasonal[i]);
      const t0 = months[prev];
      const span = months[i] - t0;
      for (let g = prev + 1; g < i; g++) {
        const w = (months[g] - t0) / span;
        filled[g] = trend[g] + seasonal[g] + r0 + w * (r1 - r0);
        isFilled[g] = 1;
      }
    }
    prev = i;
  }

  return {
    filled,
    isFilled,
    trend,
    seasonal,
    breakpoints: model.breakpoints.map((b) => start + b),
    bic: fits.flatMap((f, c) => (f ? [{breakpoints: c, bic: f.bic, rmse: Math.sqrt(f.rss / f.n)}] : [])),
  };
}

// ---- memoized entry point ----------------------------------------------------
//
// The chart redraws on every toggle, theme change and variable switch, and the
// CSV asks for the same series again; a picked cell's series is a fresh array
// each time it is read. So the cache is keyed on the numbers rather than on the
// array, and kept small: a handful of series is all one session looks at
// between region changes.
const MEMO_LIMIT = 24;
const memo = new Map();

/** seasonalFill(), remembered per series. */
export function seasonalFillCached(values, months) {
  const key = `${months[0]}:${months.length}:${Array.prototype.join.call(values, ",")}`;
  if (memo.has(key)) {
    const hit = memo.get(key);
    memo.delete(key); // re-insert, so the Map's order stays least recently used first
    memo.set(key, hit);
    return hit;
  }
  const result = seasonalFill(values, months);
  memo.set(key, result);
  if (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value);
  return result;
}
