// Parity test: src/recharge.js against the training notebook's WTF method.
//
//   node test/recharge.test.mjs
//
// Each reference in test/recharge-reference/ was written by make_reference.py,
// which runs the notebook's own fill_gaps() and water_table_fluctuation() on a
// sample export from test/gapfill-reference/. The port must pick the same
// water year start, the same trough, peak and recession window in every year,
// and land within TOLERANCE_CM of every S and R value.
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
      assert.equal(monthLabel(months[row.fitStart]), r.fit_start, `${where}: recession fit start`);
      assert.equal(row.longExtrapolation, r.long_extrapolation, `${where}: long_extrapolation`);
      assert.equal(row.filledParts.join(", "), r.filled_parts, `${where}: filled parts`);
      for (const [js, py] of [["sP", "S_P"], ["sB", "S_B"], ["sL", "S_L"], ["rS", "R_S"], ["rD", "R_D"], ["r1", "R1"], ["r2", "R2"]]) {
        const d = Math.abs(row[js] - r[py]);
        maxDiff = Math.max(maxDiff, d);
        assert.ok(d <= TOLERANCE_CM, `${where}: ${py} ${row[js]} vs ${r[py]}`);
      }
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
