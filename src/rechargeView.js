// The Recharge Analysis page: a full-window view over the app, opened from the
// time series chart when gaps are filled with the seasonal model. It works on
// the GWSa series of whatever is selected (a region or a picked cell) and
// closes back to the map with everything as it was.
//
// The calculations are in recharge.js; this file only lays them out.

import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  TimeScale,
  Tooltip,
} from "chart.js";
import "chartjs-adapter-date-fns";

import {monthIndexOf, seasonalFillCached} from "./gapFill.js";
import {analyzeSeasonality, autoWaterYearStart, monthLabel, waterTableFluctuation} from "./recharge.js";

Chart.register(BarController, BarElement, CategoryScale, LinearScale, LineController, LineElement, PointElement,
  TimeScale, Tooltip, Legend);

// Colors for the picks and the two estimates, readable on both themes.
const COLOR = {
  series: "#3b82f6",
  filled: "#ef4444",
  peak: "#16a34a",
  trough: "#d97706",
  recession: "#a855f7",
  r1: "#0ea5e9",
  r2: "#6366f1",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];

const token = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const VERDICTS = {
  good: {
    title: "Good candidate for the WTF method",
    text: "Groundwater storage rises and falls once a year, at about the same time each year, so each year's rise can be read as that year's recharge.",
  },
  marginal: {
    title: "Use the results with care",
    text: "There is an annual cycle, but it is weak or irregular next to other changes in storage. Some years' rises will reflect wet or dry spells rather than a seasonal recharge event. Check the picks for each year, and rely on multi-year means rather than single years.",
  },
  poor: {
    title: "Poor candidate for the WTF method",
    text: "Groundwater storage here has little regular annual cycle, so the yearly rise the method looks for is mostly noise or multi-year change. Recharge estimates for this series are unlikely to be meaningful.",
  },
};

const pct = (x) => `${Math.round(100 * x)}%`;

// The seasonality section: a verdict, the numbers behind it, and the average
// annual cycle with the month the water year starts on.
const seasonalitySection = (s) => {
  const section = el("section", "rc-section");
  section.append(el("h2", "rc-heading", "1. Is this series suited to the WTF method?"));

  const verdict = VERDICTS[s.verdict];
  const card = el("div", `rc-verdict rc-verdict-${s.verdict}`);
  card.append(el("p", "rc-verdict-title", verdict.title), el("p", "rc-verdict-text", verdict.text));
  section.append(card);

  const grid = el("div", "rc-season-grid");
  const stats = el("dl", "rc-stats");
  const stat = (label, value, note) => {
    const row = el("div", "rc-stat");
    row.append(el("dt", null, label), el("dd", null, value));
    if (note) row.append(el("p", "rc-stat-note", note));
    stats.append(row);
  };
  stat("Seasonal swing", `${s.amplitude.toFixed(1)} cm`,
    Number.isFinite(s.sigma)
      ? `Highest month minus lowest month of the average cycle. The typical uncertainty of a monthly value is ±${s.sigma.toFixed(1)} cm.`
      : "Highest month minus lowest month of the average cycle.");
  stat("Share of variation that is seasonal", pct(s.explained),
    "How much of the month-to-month variation around the long-term trend the average annual cycle accounts for. Above 40% is a clear cycle.");
  stat("Years peaking at the usual time", `${Math.round(s.regularity * s.years)} of ${s.years}`,
    `Years whose high falls within a month of ${MONTH_NAMES[s.peakMonth - 1]}. Above 70% is a regular cycle.`);
  stat("Usual low and high", `${MONTH_NAMES[s.troughMonth - 1]} and ${MONTH_NAMES[s.peakMonth - 1]}`,
    `Each water year starts in ${MONTH_NAMES[s.troughMonth - 1]}, the usual low, so it holds one full rise.`);

  const chartBox = el("div", "rc-season-chart");
  chartBox.append(el("p", "rc-chart-title", "Average annual cycle of GWSa (cm)"));
  const canvasBox = el("div", "rc-canvas");
  const canvas = el("canvas");
  canvasBox.append(canvas);
  chartBox.append(canvasBox, el("p", "rc-stat-note",
    `The highlighted bar is ${MONTH_NAMES[s.troughMonth - 1]}, the lowest month, where each water year starts.`));

  grid.append(stats, chartBox);
  section.append(grid);

  const accent = token("--accent", "#38bdf8");
  const faint = token("--text-faint", "#b6c2d3");
  const chart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: MONTHS,
      datasets: [{
        data: s.cycle,
        backgroundColor: s.cycle.map((_, m) => (m === s.troughMonth - 1 ? accent : `${faint}80`)),
        borderRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {display: false},
        tooltip: {callbacks: {label: (item) => `${item.parsed.y.toFixed(2)} cm`}},
      },
      scales: {
        x: {ticks: {color: token("--chart-text", "#b6c2d3")}, grid: {display: false}},
        y: {
          ticks: {color: token("--chart-text", "#b6c2d3")},
          grid: {
            color: (ctx) => (ctx.tick?.value === 0 ? token("--chart-axis", "#64748b") : token("--chart-grid", "rgba(148,163,184,0.14)")),
          },
        },
      },
    },
  });
  return {section, charts: [chart]};
};


const axisColors = () => ({
  text: token("--chart-text", "#b6c2d3"),
  grid: token("--chart-grid", "rgba(148,163,184,0.14)"),
  axis: token("--chart-axis", "#64748b"),
});

const fmt = (x, digits = 2) => (Number.isFinite(x) ? x.toFixed(digits) : "");
const mean = (xs) => {
  const ok = xs.filter(Number.isFinite);
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : NaN;
};
const toKm3 = (cm, areaKm2) => (Number.isFinite(cm) && areaKm2 ? (cm / 1e5) * areaKm2 : NaN);

const notesFor = (row) => {
  if (row.error) return row.error;
  const notes = [];
  if (row.overridden.length) notes.push(`${row.overridden.join(" and ")} set by hand`);
  if (row.filledParts.length) notes.push(`uses filled months (${row.filledParts.join(", ")})`);
  if (row.longExtrapolation) notes.push("long recession extrapolation: R2 least reliable");
  return notes.join("; ");
};

// The series with each year's trough, peak and recession line. Observed months
// solid, filled months red, so a pick on an estimated month is visible.
const picksChart = (canvas, state, rows) => {
  const {dates, values, fill} = state;
  const x = (i) => dates[i].getTime();
  const observed = [];
  const filled = [];
  for (let i = 0; i < dates.length; i++) {
    if (!Number.isFinite(fill.filled[i])) continue;
    observed.push({x: x(i), y: Number.isFinite(values[i]) ? values[i] : null});
    const edge = fill.isFilled[i] || fill.isFilled[i - 1] || fill.isFilled[i + 1];
    filled.push({x: x(i), y: edge ? fill.filled[i] : null});
  }
  const ok = rows.filter((r) => !r.error);
  const peaks = ok.map((r) => ({x: x(r.peak), y: r.sP, year: r.waterYear}));
  const troughs = ok.map((r) => ({x: x(r.trough), y: r.sB, year: r.waterYear}));
  const lines = [];
  for (const r of ok) {
    lines.push({x: x(r.recession.from), y: r.recession.y0}, {x: x(r.recession.to), y: r.recession.y1}, {x: x(r.recession.to), y: null});
  }
  const c = axisColors();
  return new Chart(canvas, {
    type: "line",
    data: {
      datasets: [
        {label: "GWSa", data: observed, borderColor: COLOR.series, borderWidth: 1.6, pointRadius: 0, pointStyle: "line", spanGaps: false, order: 3},
        {label: "Filled months", data: filled, borderColor: COLOR.filled, borderWidth: 1.6, pointRadius: 0, pointStyle: "line", spanGaps: false, order: 2},
        {label: "Recession line", data: lines, borderColor: COLOR.recession, borderWidth: 1.4, borderDash: [5, 3], pointRadius: 0, pointStyle: "line", spanGaps: false, order: 1},
        {label: "Trough (S_B)", data: troughs, showLine: false, pointStyle: "triangle", rotation: 180, pointRadius: 6, pointBackgroundColor: COLOR.trough, pointBorderColor: COLOR.trough, order: 0},
        {label: "Peak (S_P)", data: peaks, showLine: false, pointStyle: "triangle", pointRadius: 6, pointBackgroundColor: COLOR.peak, pointBorderColor: COLOR.peak, order: 0},
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: {mode: "nearest", intersect: true},
      scales: {
        x: {type: "time", time: {unit: "year", tooltipFormat: "MMM yyyy"}, ticks: {color: c.text, maxRotation: 0}, grid: {color: c.grid}},
        y: {
          title: {display: true, text: "GWSa (cm)", color: c.text},
          ticks: {color: c.text},
          grid: {color: (ctx) => (ctx.tick?.value === 0 ? c.axis : c.grid)},
        },
      },
      plugins: {
        legend: {position: "bottom", labels: {color: c.text, usePointStyle: true, pointStyleWidth: 18, sort: (a, b) => a.datasetIndex - b.datasetIndex}},
        tooltip: {
          filter: (item) => item.datasetIndex >= 3,
          callbacks: {
            label: (item) => `${item.dataset.label}, water year ${item.raw.year}: ${item.parsed.y.toFixed(2)} cm`,
          },
        },
      },
    },
  });
};

// R1 and R2 by water year, side by side, with each one's mean as a line.
const rechargeChart = (canvas, rows) => {
  const c = axisColors();
  const labels = rows.map((r) => String(r.waterYear));
  const r1 = rows.map((r) => (r.error ? null : r.r1));
  const r2 = rows.map((r) => (r.error ? null : r.r2));
  const m1 = mean(r1);
  const m2 = mean(r2);
  return new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {label: "R1, lower estimate (cm/yr)", data: r1, backgroundColor: COLOR.r1, borderRadius: 2, order: 2},
        {label: "R2, upper estimate (cm/yr)", data: r2, backgroundColor: `${COLOR.r2}b0`, borderRadius: 2, order: 2},
        {type: "line", label: `Mean R1, ${fmt(m1)} cm/yr`, data: labels.map(() => m1), borderColor: COLOR.r1, borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, order: 1},
        {type: "line", label: `Mean R2, ${fmt(m2)} cm/yr`, data: labels.map(() => m2), borderColor: COLOR.r2, borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, order: 1},
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: {ticks: {color: c.text, autoSkip: true, maxRotation: 0}, grid: {display: false}, title: {display: true, text: "Water year (named by the year it starts)", color: c.text}},
        y: {beginAtZero: true, title: {display: true, text: "Recharge (cm/yr)", color: c.text}, ticks: {color: c.text}, grid: {color: c.grid}},
      },
      plugins: {
        legend: {position: "bottom", labels: {color: c.text, boxWidth: 14, sort: (a, b) => a.datasetIndex - b.datasetIndex}},
        tooltip: {callbacks: {label: (item) => `${item.dataset.label.replace(/ \(cm\/yr\)$/, "")}: ${fmt(item.parsed.y)} cm/yr`}},
      },
    },
  });
};

const csvFor = (state, rows) => {
  const {months, areaKm2} = state;
  const vol = !!areaKm2;
  const header = ["water_year", "trough", "peak", "S_P_cm", "S_B_cm", "S_L_cm", "R_S_cm", "R_D_cm", "R1_cm", "R2_cm"];
  if (vol) header.push("R1_km3", "R2_km3");
  header.push("long_extrapolation", "uses_filled_months", "set_by_hand", "note");
  const lines = [header.join(",")];
  const cell = (v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  for (const r of rows) {
    const ok = !r.error;
    const out = [r.waterYear, ok ? monthLabel(months[r.trough]) : "", ok ? monthLabel(months[r.peak]) : "",
      fmt(r.sP, 3), fmt(r.sB, 3), fmt(r.sL, 3), fmt(r.rS, 3), fmt(r.rD, 3), fmt(r.r1, 3), fmt(r.r2, 3)];
    if (vol) out.push(fmt(toKm3(r.r1, areaKm2), 4), fmt(toKm3(r.r2, areaKm2), 4));
    out.push(ok ? String(r.longExtrapolation) : "", ok ? r.filledParts.join(" ") : "", r.overridden.join(" "), cell(r.error ?? ""));
    lines.push(out.join(","));
  }
  const mr = (k) => fmt(mean(rows.map((r) => (r.error ? NaN : r[k]))), 3);
  const meanRow = ["mean", "", "", mr("sP"), mr("sB"), mr("sL"), mr("rS"), mr("rD"), mr("r1"), mr("r2")];
  if (vol) meanRow.push(fmt(toKm3(mean(rows.map((r) => r.r1)), areaKm2), 4), fmt(toKm3(mean(rows.map((r) => r.r2)), areaKm2), 4));
  meanRow.push("", "", "", "");
  lines.push(meanRow.join(","));
  return lines.join("\n");
};

const download = (text, filename) => {
  const url = URL.createObjectURL(new Blob([text], {type: "text/csv;charset=utf-8"}));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "region";

// A month picker for one pick of one year: every month the method allows for
// it, plus "auto" to drop the override.
const pickSelect = (state, row, kind, rows, k, onChange) => {
  const {months} = state;
  const select = el("select", "rc-pick");
  select.setAttribute("aria-label", `${kind} for water year ${row.waterYear}`);
  const auto = el("option", null, "auto");
  auto.value = "";
  select.append(auto);
  // The peak may be any month of its water year; the trough any month from the
  // previous peak up to the peak. Offering a wider range would only invite the
  // errors waterTableFluctuation() reports.
  const prevPeak = rows.slice(0, k).reverse().find((r) => !r.error)?.peak ?? state.first;
  const peak = row.error ? null : row.peak;
  const from = kind === "peak" ? row.yearFirst : prevPeak;
  const to = kind === "peak" ? row.yearFirst + 11 : (peak ?? row.yearFirst + 11) - 1;
  for (let i = from; i <= to; i++) {
    const o = el("option", null, monthLabel(months[i]) + (state.fill.isFilled[i] ? " (filled)" : ""));
    o.value = String(months[i]);
    select.append(o);
  }
  const current = state.overrides[row.waterYear]?.[kind];
  select.value = current != null ? String(current) : "";
  if (current == null && !row.error) {
    // Show the automatic pick in the closed control without making it an override.
    auto.textContent = `${monthLabel(months[row[kind]])} (auto)`;
  }
  select.addEventListener("change", () => onChange(row.waterYear, kind, select.value === "" ? null : Number(select.value)));
  return select;
};

const analysisSection = (state, rerender) => {
  const {months, areaKm2} = state;
  const rows = waterTableFluctuation(state.fill, months, state.startMonth, state.overrides);
  // The first month of each water year, for the pickers.
  for (const r of rows) r.yearFirst = months.indexOf(r.waterYear * 12 + state.startMonth - 1);

  const wrap = el("div");
  const charts = [];

  // ---- 2. Water years and picks
  const s2 = el("section", "rc-section");
  s2.append(el("h2", "rc-heading", "2. Water years, peaks and troughs"));
  const intro = el("p", "rc-text");
  intro.innerHTML =
    "For each water year the method takes the <b>peak</b> (S<sub>P</sub>, the highest month after removing the long-term trend), " +
    "the <b>trough</b> before it (S<sub>B</sub>), and a <b>recession line</b> fitted to the decline from the previous peak to the " +
    "trough and extended to the peak month (S<sub>L</sub>). Check the picks below; if one lands on a noisy spike, change it in the table.";
  s2.append(intro);

  const controls = el("div", "rc-controls");
  const startLabel = el("label", "rc-control-label", "Water year starts in");
  const startSelect = el("select", "rc-pick");
  const autoStart = autoWaterYearStart(state.fill, months);
  const autoOpt = el("option", null, `${MONTH_NAMES[autoStart - 1]} (auto, the usual low)`);
  autoOpt.value = "";
  startSelect.append(autoOpt);
  MONTH_NAMES.forEach((n, m) => {
    const o = el("option", null, n);
    o.value = String(m + 1);
    startSelect.append(o);
  });
  startSelect.value = state.startMonthChoice ?? "";
  startSelect.addEventListener("change", () => {
    state.startMonthChoice = startSelect.value || null;
    state.startMonth = startSelect.value ? Number(startSelect.value) : autoStart;
    state.overrides = {}; // the years themselves have moved
    rerender();
  });
  startLabel.append(startSelect);
  controls.append(startLabel);
  const resetAll = el("button", "rc-button", "Reset all picks");
  resetAll.type = "button";
  resetAll.disabled = !Object.keys(state.overrides).length;
  resetAll.addEventListener("click", () => {
    state.overrides = {};
    rerender();
  });
  controls.append(resetAll);
  s2.append(controls);

  const box = el("div", "rc-chart-box");
  const canvasBox = el("div", "rc-canvas rc-canvas-tall");
  const canvas = el("canvas");
  canvasBox.append(canvas);
  box.append(canvasBox);
  s2.append(box);
  wrap.append(s2);
  charts.push(picksChart(canvas, state, rows));

  // ---- 3. Recharge
  const s3 = el("section", "rc-section");
  s3.append(el("h2", "rc-heading", "3. Recharge by water year"));
  const r1Mean = mean(rows.map((r) => (r.error ? NaN : r.r1)));
  const r2Mean = mean(rows.map((r) => (r.error ? NaN : r.r2)));
  const summary = el("div", "rc-summary");
  const card = (label, cm, note) => {
    const d = el("div", "rc-stat");
    d.append(el("dt", null, label), el("dd", null, `${fmt(cm)} cm/yr`));
    if (areaKm2) d.append(el("p", "rc-stat-note", `${fmt(toKm3(cm, areaKm2), 2)} km³/yr over ${Math.round(areaKm2).toLocaleString()} km²`));
    d.append(el("p", "rc-stat-note", note));
    return d;
  };
  summary.append(
    card("Mean R1 (lower estimate)", r1Mean, "R1 = S_P − S_B, the rise from trough to peak."),
    card("Mean R2 (upper estimate)", r2Mean, "R2 = S_P − S_L, the rise plus the decline the recession line says was offset."),
  );
  s3.append(summary);

  const box3 = el("div", "rc-chart-box");
  const canvasBox3 = el("div", "rc-canvas");
  const canvas3 = el("canvas");
  canvasBox3.append(canvas3);
  box3.append(canvasBox3);
  s3.append(box3);
  charts.push(rechargeChart(canvas3, rows));

  const tableTools = el("div", "rc-controls");
  const dl = el("button", "rc-button rc-button-primary", "Download CSV");
  dl.type = "button";
  dl.addEventListener("click", () => download(csvFor(state, rows), `recharge_${slug(state.name)}.csv`));
  tableTools.append(dl);
  s3.append(tableTools);

  const tableWrap = el("div", "rc-table-wrap");
  const table = el("table", "rc-table");
  const head = el("tr");
  const cols = ["Water year", "Trough", "Peak", "S_B (cm)", "S_P (cm)", "S_L (cm)", "R1 (cm)", "R2 (cm)"];
  if (areaKm2) cols.push("R1 (km³)", "R2 (km³)");
  cols.push("Notes");
  cols.forEach((t) => head.append(el("th", null, t)));
  const thead = el("thead");
  thead.append(head);
  const tbody = el("tbody");
  const onPick = (year, kind, month) => {
    const picks = {...(state.overrides[year] ?? {})};
    if (month == null) delete picks[kind];
    else picks[kind] = month;
    if (Object.keys(picks).length) state.overrides[year] = picks;
    else delete state.overrides[year];
    rerender();
  };
  rows.forEach((r, k) => {
    const tr = el("tr", r.error ? "rc-row-error" : r.overridden.length ? "rc-row-edited" : "");
    tr.append(el("td", null, String(r.waterYear)));
    const tdT = el("td");
    tdT.append(pickSelect(state, r, "trough", rows, k, onPick));
    const tdP = el("td");
    tdP.append(pickSelect(state, r, "peak", rows, k, onPick));
    tr.append(tdT, tdP);
    for (const v of [r.sB, r.sP, r.sL, r.r1, r.r2]) tr.append(el("td", "rc-num", fmt(v)));
    if (areaKm2) for (const v of [r.r1, r.r2]) tr.append(el("td", "rc-num", fmt(toKm3(v, areaKm2), 3)));
    tr.append(el("td", "rc-notes", notesFor(r)));
    tbody.append(tr);
  });
  const foot = el("tr", "rc-row-mean");
  foot.append(el("td", null, "Mean"), el("td"), el("td"));
  for (const k of ["sB", "sP", "sL", "r1", "r2"]) foot.append(el("td", "rc-num", fmt(mean(rows.map((r) => (r.error ? NaN : r[k]))))));
  if (areaKm2) for (const m of [r1Mean, r2Mean]) foot.append(el("td", "rc-num", fmt(toKm3(m, areaKm2), 3)));
  foot.append(el("td"));
  const tfoot = el("tfoot");
  tfoot.append(foot);
  table.append(thead, tbody, tfoot);
  tableWrap.append(table);
  s3.append(tableWrap);

  const cautions = el("p", "rc-text rc-caution");
  cautions.innerHTML =
    "<b>Reading the results.</b> R1 and R2 bracket the recharge: R1 ignores drainage during the rise, and R2 extends the recession line " +
    "well past the months it was fitted on, so treat it as an upper bound. The uncertainty of a monthly GRACE value is often as large as " +
    "a single year's rise, so multi-year means are more reliable than any one year. Where storage has a strong long-term decline from " +
    "pumping, the recession line includes that decline, and R2 counts it as recharge.";
  s3.append(cautions);
  wrap.append(s3);
  return {node: wrap, charts};
};

let open = null;

/**
 * Open the page for one GWSa series.
 *
 *   name         what the series is for, shown in the header (region or cell)
 *   dates        the app's monthly Date axis
 *   values       GWSa per month, NaN where GRACE has no data
 *   uncertainty  GWSa 1-sigma per month, or null
 *   areaKm2      area of the region or cell, for volumes
 */
export function openRechargeView({name, dates, values, uncertainty = null, areaKm2 = null}) {
  closeRechargeView();
  const months = dates.map(monthIndexOf);
  const fill = seasonalFillCached(values, months);

  const root = el("div", "rc-view");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Recharge analysis");

  const header = el("header", "rc-header");
  const back = el("button", "rc-back", "← Back to map");
  back.type = "button";
  back.addEventListener("click", closeRechargeView);
  const titles = el("div", "rc-titles");
  titles.append(el("h1", "rc-title", "Recharge Analysis"), el("p", "rc-subtitle", `${name} · groundwater storage anomaly (GWSa)`));
  header.append(back, titles);

  const body = el("main", "rc-body");
  const charts = [];
  if (!fill) {
    body.append(el("p", "rc-empty",
      "This series is too short or has too few observations in some calendar months to fit the seasonal model, so recharge can't be estimated."));
  } else {
    const s = analyzeSeasonality(values, months, fill, uncertainty);
    const part = seasonalitySection(s);
    body.append(part.section);
    charts.push(...part.charts);

    // Everything below the seasonality check redraws when a pick or the water
    // year start changes; the check itself does not depend on either.
    let first = 0;
    while (!Number.isFinite(fill.trend[first])) first++;
    const state = {name, dates, months, values, fill, areaKm2, first, startMonth: s.troughMonth, startMonthChoice: null, overrides: {}};
    const holder = el("div");
    body.append(holder);
    let current = null;
    const rerender = () => {
      const scroll = body.scrollTop;
      current?.charts.forEach((c) => c.destroy());
      current = analysisSection(state, rerender);
      holder.replaceChildren(current.node);
      body.scrollTop = scroll;
    };
    rerender();
    charts.push({destroy: () => current?.charts.forEach((c) => c.destroy())});
  }

  root.append(header, body);
  document.body.append(root);
  back.focus();

  const onKey = (e) => {
    if (e.key === "Escape") closeRechargeView();
  };
  document.addEventListener("keydown", onKey);
  open = {root, charts, onKey, areaKm2};
}

export function closeRechargeView() {
  if (!open) return;
  open.charts.forEach((c) => c.destroy());
  document.removeEventListener("keydown", open.onKey);
  open.root.remove();
  open = null;
}
