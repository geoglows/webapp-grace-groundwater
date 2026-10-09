// Recharge from a gap-filled storage series by the water table fluctuation
// (WTF) method, plus a check of whether the series has the clear annual cycle
// the method needs.
//
// waterTableFluctuation() started as a port of water_table_fluctuation() in the
// training notebook (grace_gap_fill_and_recharge.ipynb) and picks the same
// troughs and peaks (test/recharge.test.mjs). It differs in two places, both
// to follow Barbosa et al. (2022) more closely: the projection to the peak
// starts at the trough, and the first water year's recession starts at its
// highest month rather than the first month of the record. It takes the output
// of seasonalFill() in gapFill.js.
//
// Months are integer month indices (year * 12 + zero-based month), as
// monthIndexOf() in gapFill.js returns. Calendar months in the public API are
// 1-12, as the notebook's water year start is.

const MIN_RECESSION_MONTHS = 4; // fewest months used to fit a recession line

const calendarMonth = (m) => (((m % 12) + 12) % 12) + 1;
export const monthLabel = (m) => `${Math.floor(m / 12)}-${String(calendarMonth(m)).padStart(2, "0")}`;

// The span seasonalFill() modelled: from the first to the last observed month.
// The notebook trims its series to the same span when it loads the CSV.
const modelledSpan = (fill) => {
  let first = -1;
  let last = -1;
  for (let i = 0; i < fill.trend.length; i++) {
    if (Number.isFinite(fill.trend[i])) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return {first, last};
};

/** The seasonal value of each calendar month, index 0 = January. */
export const seasonalCycle = (fill, months) => {
  const cycle = new Array(12).fill(NaN);
  const {first, last} = modelledSpan(fill);
  for (let i = first; i <= last; i++) cycle[calendarMonth(months[i]) - 1] = fill.seasonal[i];
  return cycle;
};

/** auto_water_year_start: the calendar month (1-12) with the lowest seasonal value. */
export const autoWaterYearStart = (fill, months) => {
  const cycle = seasonalCycle(fill, months);
  let best = 0;
  for (let m = 1; m < 12; m++) if (cycle[m] < cycle[best]) best = m;
  return best + 1;
};

/** Complete water years in the modelled span: {label, first, last} as array positions. */
export const listWaterYears = (fill, months, startMonth) => {
  const {first, last} = modelledSpan(fill);
  const years = [];
  for (let i = first; i <= last; i++) {
    if (calendarMonth(months[i]) !== startMonth || i + 11 > last) continue;
    years.push({label: Math.floor(months[i] / 12), first: i, last: i + 11});
  }
  return years;
};

// pandas idxmax/idxmin: the first position holding the extreme value.
const argExtreme = (arr, from, to, sign) => {
  let best = -1;
  for (let i = from; i <= to; i++) {
    if (!Number.isFinite(arr[i])) continue;
    if (best < 0 || sign * arr[i] > sign * arr[best]) best = i;
  }
  return best;
};

// np.polyfit(x, y, 1) with x = months since `from`. Null below two points.
const lineFit = (series, from, to) => {
  const n = to - from + 1;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = from; i <= to; i++) {
    sx += i - from;
    sy += series[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = from; i <= to; i++) {
    const dx = i - from - mx;
    sxx += dx * dx;
    sxy += dx * (series[i] - my);
  }
  const slope = sxy / sxx;
  return {slope, intercept: my - slope * mx};
};

/**
 * Pick S_P, S_B and S_L for every complete water year and compute recharge in
 * cm/yr, as the notebook does.
 *
 * Peak and trough months are picked on the detrended series (filled - trend)
 * so a long-term rise or decline can't push them to the edge of the water
 * year; the S values and the recession line use the filled series itself.
 *
 *   S_P  filled value at the highest detrended month in the water year
 *   S_B  filled value at the lowest detrended month between the previous peak
 *        and this peak
 *   S_L  recession projected from S_B to the peak month at the slope of a line
 *        fitted from the previous peak (S_A) to S_B, or to the
 *        MIN_RECESSION_MONTHS months ending at S_B if that is longer; S_B
 *        when the fitted line is flat or rising. In the first water year,
 *        S_A is the highest detrended month before the trough.
 *   R_S = S_P - S_B      R_D = max(S_B - S_L, 0)
 *   R1  = R_S (lower)    R2  = R_S + R_D (upper)
 *
 * `overrides` maps a water year label to {peak, trough}, each a month index.
 * Months are array positions in the returned rows (peak, trough, fitStart,
 * recessionStart); monthLabel(months[i]) names one. A year whose picks are
 * inconsistent gets an `error` string and no recharge, and the next year's
 * recession starts from the last good peak; the notebook raises instead.
 */
export function waterTableFluctuation(fill, months, startMonth, overrides = {}) {
  const series = fill.filled;
  const detrended = Float64Array.from(series, (v, i) => v - fill.trend[i]);
  const {first} = modelledSpan(fill);
  const positionOf = (m) => months.indexOf(m);

  const rows = [];
  let previousPeak = null;
  for (const year of listWaterYears(fill, months, startMonth)) {
    const picks = overrides[year.label] ?? {};
    const overridden = ["peak", "trough"].filter((k) => picks[k] != null);
    const row = {waterYear: year.label, overridden};
    rows.push(row);

    const peak = picks.peak != null ? positionOf(picks.peak) : argExtreme(detrended, year.first, year.last, 1);
    const recessionStart = previousPeak ?? first;
    if (peak <= recessionStart) {
      row.error = `The peak must come after the previous peak (${monthLabel(months[recessionStart])}).`;
      continue;
    }
    const trough = picks.trough != null ? positionOf(picks.trough) : argExtreme(detrended, recessionStart, peak - 1, -1);
    if (!(recessionStart <= trough && trough < peak)) {
      row.error = `The trough must fall between ${monthLabel(months[recessionStart])} and the peak.`;
      continue;
    }

    const sP = series[peak];
    const sB = series[trough];

    // The recession is fitted from S_A, the previous peak, down to S_B. The
    // first water year has no previous peak, so S_A is the highest detrended
    // month before its trough; starting at the first month of the record
    // instead would fit across whatever rise and fall came before it.
    const sA = previousPeak ?? argExtreme(detrended, first, trough, 1);
    let fitStart = sA;
    const shortestStart = trough - (MIN_RECESSION_MONTHS - 1);
    if (fitStart > shortestStart) fitStart = Math.max(shortestStart, first);

    // S_L: the recession carried on from the trough to the peak month at the
    // fitted slope, so the projection starts at S_B itself rather than at the
    // fitted line's value there.
    const line = lineFit(series, fitStart, trough);
    let slope;
    let sL;
    // As drawn: the fitted line over its window, and the projection from S_B.
    let recession;
    if (!line || line.slope >= 0) {
      slope = line ? line.slope : NaN;
      sL = sB;
      recession = {fit: null, from: trough, to: peak, y0: sB, y1: sB};
    } else {
      slope = line.slope;
      sL = sB + slope * (peak - trough);
      recession = {
        fit: {from: fitStart, to: trough, y0: line.intercept, y1: line.intercept + slope * (trough - fitStart)},
        from: trough, to: peak, y0: sB, y1: sL,
      };
    }

    const fittedSpan = trough - fitStart;
    const extrapolated = peak - trough;
    const rS = sP - sB;
    const rD = Math.max(sB - sL, 0);

    const filledParts = [];
    if (fill.isFilled[peak]) filledParts.push("peak");
    if (fill.isFilled[trough]) filledParts.push("trough");
    for (let i = fitStart; i <= trough; i++) {
      if (fill.isFilled[i]) {
        filledParts.push("recession");
        break;
      }
    }

    Object.assign(row, {
      recessionStart,
      sA, // position of the peak the recession starts from
      fitStart,
      trough,
      peak,
      sP,
      sB,
      sL,
      recessionSlope: 12 * slope, // cm/yr
      recession,
      rS,
      rD,
      r1: rS,
      r2: rS + rD,
      longExtrapolation: extrapolated > 2 * fittedSpan,
      filledParts,
    });
    previousPeak = peak;
  }
  return rows;
}

// ---- seasonality check -------------------------------------------------------
//
// The WTF method reads one rise per year as that year's recharge, so it only
// means something where storage has a clear annual cycle. Not in the notebook;
// these thresholds were set against regions whose behaviour is known: the
// Northern Midwest Aquifer System (strong, regular cycle) scores well above
// them, and California's Central Valley, where multi-year droughts dominate, sits
// between.
const GOOD = {explained: 0.4, regularity: 0.7};
// A year counts as regular when its peak falls within this many months of the
// usual peak. One month was too strict for broad, flat-topped wet seasons such
// as the Volta basin's, where the single highest month wanders around a
// plateau of several months while the cycle itself stays clean.
const PEAK_WINDOW = 2;
const POOR = {explained: 0.1, regularity: 0.5};

/**
 * How suitable a series is for the WTF method.
 *
 *   amplitude    seasonal cycle, highest month minus lowest, cm
 *   peakMonth    calendar month (1-12) of the seasonal high; troughMonth the low
 *   explained    share of the detrended variance of the observed months that
 *                the average seasonal cycle accounts for (0-1)
 *   regularity   share of complete water years whose detrended peak falls
 *                within PEAK_WINDOW months of peakMonth
 *   sigma        median 1-sigma uncertainty of the observed months, cm, or NaN
 *   verdict      "good", "marginal" or "poor"
 */
export function analyzeSeasonality(values, months, fill, uncertainty = null) {
  const cycle = seasonalCycle(fill, months);
  let hi = 0;
  let lo = 0;
  for (let m = 1; m < 12; m++) {
    if (cycle[m] > cycle[hi]) hi = m;
    if (cycle[m] < cycle[lo]) lo = m;
  }
  const amplitude = cycle[hi] - cycle[lo];

  // Explained variance over observed months only: filled months are the model
  // and would agree with it by construction.
  const det = [];
  const res = [];
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i]) || !Number.isFinite(fill.trend[i])) continue;
    const d = values[i] - fill.trend[i];
    det.push(d);
    res.push(d - fill.seasonal[i]);
  }
  const variance = (a) => {
    const mean = a.reduce((s, v) => s + v, 0) / a.length;
    return a.reduce((s, v) => s + (v - mean) ** 2, 0) / (a.length - 1);
  };
  const explained = Math.max(0, 1 - variance(res) / variance(det));

  const startMonth = lo + 1;
  const peakMonth = hi + 1;
  const years = listWaterYears(fill, months, startMonth);
  let regular = 0;
  for (const {first, last} of years) {
    let best = first;
    for (let i = first; i <= last; i++) {
      if (fill.filled[i] - fill.trend[i] > fill.filled[best] - fill.trend[best]) best = i;
    }
    const off = Math.abs(calendarMonth(months[best]) - peakMonth);
    if (Math.min(off, 12 - off) <= PEAK_WINDOW) regular++;
  }
  const regularity = years.length ? regular / years.length : 0;

  const sigmas = [];
  if (uncertainty) {
    for (let i = 0; i < values.length; i++) {
      if (Number.isFinite(values[i]) && Number.isFinite(uncertainty[i])) sigmas.push(uncertainty[i]);
    }
    sigmas.sort((a, b) => a - b);
  }
  const sigma = sigmas.length ? sigmas[Math.floor(sigmas.length / 2)] : NaN;

  let verdict = "marginal";
  if (explained >= GOOD.explained && regularity >= GOOD.regularity) verdict = "good";
  else if (explained < POOR.explained || regularity < POOR.regularity) verdict = "poor";

  return {cycle, amplitude, peakMonth, troughMonth: startMonth, explained, regularity, years: years.length, sigma, verdict};
}
