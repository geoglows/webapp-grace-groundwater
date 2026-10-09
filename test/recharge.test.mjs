// Test of src/recharge.js against the training notebook's WTF method.
//
//   node test/recharge.test.mjs
//
// Each reference in test/recharge-reference/ was written by make_reference.py,
// which runs the notebook's own fill_gaps() and water_table_fluctuation() on a
// sample export from test/gapfill-reference/. The app must pick the same water
// year start and the same trough and peak in every year, and match S_P, S_B and
// R1 within TOLERANCE_CM.
//
// The recession differs from the notebook on purpose (see recharge.js): S_L is
// projected from S_B, and the first year's fit starts at the first peak. Those
// are checked directly: the fit window matches the notebook's after the first
// year, the projection starts at S_B with the fitted slope, and R2 = S_P - S_L.
//
// To regenerate a reference after a change to the notebook:
//   python -I test/recharge-reference/make_reference.py <notebook.ipynb> \
//     test/gapfill-reference/<sample>.csv test/recharge-reference/<sample>_python.json [overrides.json]

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {seasonalFill} from "../src/gapFill.js";
import {analyzeSeasonality, autoWaterYearStart, monthLabel, waterTableFluctuation} from "../src/recharge.js";

const TOLERANCE_CM = 0.01;
const HERE = dirname(fileURLToPath(import.meta.url));
const CASES = [
  {sample: "iullemeden", ref: "iullemeden_python.json"},
  {sample: "central_valley", ref: "central_valley_python.json"},
  {sample: "iullemeden", ref: "iullemeden_overrides_python.json"},
];

const readCsv = (path) => {
  const [header, ...lines] = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const cols = header.split(",");
  return lines.map((line) => Object.fromEntries(line.split(",").map((v, i) => [cols[i], v])));
};
const monthOf = (s) => Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7)) - 1;
const loadSeries = (path) => {
  const byMonth = new Map(readCsv(path).map((r) => [monthOf(r.Date), r.GWSa === "" ? NaN : Number(r.GWSa)]));
  const all = [...byMonth.keys()].sort((a, b) => a - b);
  const months = [];
  const values = [];
  for (let m = all[0]; m <= all[all.length - 1]; m++) {
    months.push(m);
    values.push(byMonth.has(m) ? byMonth.get(m) : NaN);
  }
  return {months, values};
};

let failures = 0;
for (const {sample, ref: refFile} of CASES) {
  const {months, values} = loadSeries(join(HERE, "gapfill-reference", `${sample}.csv`));
  const ref = JSON.parse(readFileSync(join(HERE, "recharge-reference", refFile), "utf8"));
  const overrides = Object.fromEntries(Object.entries(ref.overrides).map(([y, p]) => [
    Number(y), Object.fromEntries(Object.entries(p).map(([k, v]) => [k, monthOf(v)]))]));
  try {
    const fill = seasonalFill(values, months);
    const start = autoWaterYearStart(fill, months);
    assert.equal(start, ref.start_month, "water year start differs");
    const rows = waterTableFluctuation(fill, months, start, overrides);
    assert.equal(rows.length, ref.rows.length, "number of water years differs");
    let maxDiff = 0;
    rows.forEach((row, k) => {
      const r = ref.rows[k];
      const where = `water year ${r.water_year}`;
      assert.equal(row.waterYear, r.water_year, `${where}: label`);
      assert.ok(!row.error, `${where}: ${row.error}`);
      assert.equal(monthLabel(months[row.trough]), r.trough, `${where}: trough`);
      assert.equal(monthLabel(months[row.peak]), r.peak, `${where}: peak`);
      if (k > 0) {
        assert.equal(monthLabel(months[row.fitStart]), r.fit_start, `${where}: recession fit start`);
      } else {
        // The first peak: the highest detrended month before the trough.
        let best = 0;
        for (let i = 0; i <= row.trough; i++) {
          if (fill.filled[i] - fill.trend[i] > fill.filled[best] - fill.trend[best]) best = i;
        }
        assert.equal(row.fitStart, Math.min(best, row.trough - 3), `${where}: first-year fit should start at the first peak`);
      }
      for (const [js, py] of [["sP", "S_P"], ["sB", "S_B"], ["rS", "R_S"], ["r1", "R1"]]) {
        const d = Math.abs(row[js] - r[py]);
        maxDiff = Math.max(maxDiff, d);
        assert.ok(d <= TOLERANCE_CM, `${where}: ${py} ${row[js]} vs ${r[py]}`);
      }
      const slope = row.recessionSlope / 12;
      const expectedSL = Number.isFinite(slope) && slope < 0 ? row.sB + slope * (row.peak - row.trough) : row.sB;
      assert.ok(Math.abs(row.sL - expectedSL) < 1e-9, `${where}: S_L is not projected from S_B`);
      assert.equal(row.recession.y0, row.sB, `${where}: projection does not start at S_B`);
      assert.ok(Math.abs(row.r2 - (row.sP - row.sL)) < 1e-9, `${where}: R2 != S_P - S_L`);
      assert.ok(row.sL <= row.sB + 1e-12, `${where}: S_L above S_B`);
    });
    const s = analyzeSeasonality(values, months, fill);
    console.log(`ok  ${refFile}: start ${start}, ${rows.length} years, max |diff| ${maxDiff.toExponential(2)} cm; ` +
      `seasonality ${s.verdict} (amplitude ${s.amplitude.toFixed(1)} cm, explained ${s.explained.toFixed(2)}, regularity ${s.regularity.toFixed(2)})`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${refFile}: ${err.message}`);
  }
}
if (failures) process.exit(1);
