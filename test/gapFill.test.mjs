// Parity test: src/gapFill.js against the training notebook it was ported from.
//
//   node test/gapFill.test.mjs
//
// For each sample export in test/gapfill-reference/, fills the GWSa column with
// seasonalFill() and compares it with <sample>_python.csv/.json, which
// make_reference.py wrote by running the notebook's own functions cell on the
// same file. The port has to choose the same breakpoints and land within
// TOLERANCE_CM of every filled value; anything else means the two have drifted
// and the app no longer does what the training material says it does.
//
// To regenerate the references after a change to the notebook:
//   python -I test/gapfill-reference/make_reference.py <notebook.ipynb> \
//     test/gapfill-reference/<sample>.csv \
//     test/gapfill-reference/<sample>_python.csv test/gapfill-reference/<sample>_python.json

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {performance} from "node:perf_hooks";

import {seasonalFill, seasonalFillCached} from "../src/gapFill.js";

const TOLERANCE_CM = 0.01;
const SAMPLES = ["iullemeden", "central_valley"];
const DIR = join(dirname(fileURLToPath(import.meta.url)), "gapfill-reference");

const readCsv = (path) => {
  const [header, ...lines] = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const cols = header.split(",");
  return lines.map((line) => Object.fromEntries(line.split(",").map((v, i) => [cols[i], v])));
};

// "2002-04-01" or "2002-04" -> year * 12 + zero-based month, as monthIndexOf.
const monthOf = (s) => Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7)) - 1;
const label = (m) => `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`;

// The export as the app holds it: one slot per month, NaN where GWSa is blank,
// and a slot for any month missing from the file outright (load_grace_csv
// reindexes the same way).
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
for (const sample of SAMPLES) {
  const {months, values} = loadSeries(join(DIR, `${sample}.csv`));
  const ref = JSON.parse(readFileSync(join(DIR, `${sample}_python.json`), "utf8"));
  const refRows = new Map(readCsv(join(DIR, `${sample}_python.csv`)).map((r) => [monthOf(r.month), r]));

  const t0 = performance.now();
  const result = seasonalFill(values, months);
  const elapsed = performance.now() - t0;
  const t1 = performance.now();
  seasonalFillCached(values, months);
  seasonalFillCached(values, months);
  const cachedElapsed = performance.now() - t1;

  try {
    assert.ok(result, "seasonalFill returned null");
    const breakpoints = result.breakpoints.map(label);
    assert.deepEqual(breakpoints, ref.breakpoints, "breakpoints differ");

    let maxDiff = 0;
    let filledCount = 0;
    let compared = 0;
    for (let i = 0; i < months.length; i++) {
      const row = refRows.get(months[i]);
      if (!row) {
        // Outside the notebook's trimmed span: the port must leave it alone.
        assert.ok(Number.isNaN(result.filled[i]), `${label(months[i])} filled outside the observed span`);
        continue;
      }
      compared++;
      assert.equal(result.isFilled[i], Number(row.is_filled), `${label(months[i])} is_filled differs`);
      if (Number.isFinite(values[i])) {
        assert.equal(result.filled[i], values[i], `${label(months[i])} observed value changed`);
      }
      filledCount += result.isFilled[i];
      maxDiff = Math.max(maxDiff, Math.abs(result.filled[i] - Number(row.filled)));
      // The model's parts too, so a matching fill cannot hide a different model.
      maxDiff = Math.max(maxDiff, Math.abs(result.trend[i] - Number(row.trend)));
      maxDiff = Math.max(maxDiff, Math.abs(result.seasonal[i] - Number(row.seasonal)));
    }
    assert.equal(compared, refRows.size, "month count differs");
    assert.equal(filledCount, ref.n_filled, "number of filled months differs");
    assert.ok(maxDiff <= TOLERANCE_CM, `max |difference| ${maxDiff} cm exceeds ${TOLERANCE_CM}`);
    for (const {breakpoints: c, bic} of result.bic) {
      // The notebook's table rounds BIC to one decimal.
      assert.ok(Math.abs(bic - ref.bic[String(c)]) <= 0.051, `BIC for ${c} breakpoints: ${bic} vs ${ref.bic[c]}`);
    }

    console.log(`ok  ${sample}: ${months.length} months, ${filledCount} filled, breakpoints ${breakpoints.join(", ") || "none"}, ` +
      `max |diff| ${maxDiff.toExponential(2)} cm, ${elapsed.toFixed(1)} ms (cached x2: ${cachedElapsed.toFixed(2)} ms)`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${sample}: ${err.message}`);
  }
}

// The cases that must not be filled: no gaps, and a record too short to see
// every calendar month twice.
{
  const months = Array.from({length: 60}, (_, i) => 2010 * 12 + i);
  const smooth = months.map((m) => Math.sin((2 * Math.PI * m) / 12) + 0.01 * m);
  assert.equal(seasonalFill(smooth, months), null, "a series with no gaps should pass through");
  const short = smooth.slice(0, 18).map((v, i) => (i === 9 ? NaN : v));
  assert.equal(seasonalFill(short, months.slice(0, 18)), null, "too short to estimate the seasonal cycle");
  const leadingGap = [NaN, NaN, ...smooth];
  const r = seasonalFill(leadingGap.map((v, i) => (i === 30 ? NaN : v)), [2009 * 12 + 10, 2009 * 12 + 11, ...months]);
  assert.ok(Number.isNaN(r.filled[0]) && r.isFilled[0] === 0, "months before the first observation stay empty");
  assert.equal(r.isFilled[30], 1, "an interior gap is filled");
  console.log("ok  edge cases");
}

if (failures) {
  console.error(`${failures} sample(s) failed`);
  process.exit(1);
}
