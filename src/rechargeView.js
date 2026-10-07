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
const picksChart = (canvas, state, rows, selectedRow, onSelectYear) => {
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
  // The selected water year, shaded behind the data.
  const band = selectedRow
    ? {from: x(selectedRow.yearFirst) - 15 * 864e5, to: x(Math.min(selectedRow.yearFirst + 11, dates.length - 1)) + 15 * 864e5}
    : null;
  const shade = token("--accent", "#38bdf8");
  return new Chart(canvas, {
    type: "line",
    plugins: [{
      id: "selectedYear",
      beforeDatasetsDraw(chart) {
        if (!band) return;
        const {ctx, chartArea: {top, bottom}, scales: {x: sx}} = chart;
        const x0 = sx.getPixelForValue(band.from);
        const x1 = sx.getPixelForValue(band.to);
        ctx.save();
        ctx.fillStyle = `${shade}22`;
        ctx.fillRect(x0, top, x1 - x0, bottom - top);
        ctx.restore();
      },
    }],
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
      // Clicking anywhere in a water year opens it in the year editor below.
      onClick: (event, _, chart) => {
        const t = chart.scales.x.getValueForPixel(event.x);
        let best = null;
        for (const r of rows) {
          const a = x(r.yearFirst);
          const b = x(Math.min(r.yearFirst + 11, dates.length - 1));
          if (t >= a - 15 * 864e5 && t <= b + 15 * 864e5) best = r;
        }
        if (best) onSelectYear(best.waterYear);
      },
      onHover: (event, _, chart) => {
        chart.canvas.style.cursor = "pointer";
      },
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

// The months a pick may move to: a peak anywhere in its water year after the
// previous peak, a trough from the previous peak up to the month before the
// peak. Wider choices would only produce the errors waterTableFluctuation()
// reports.
const allowedRange = (state, rows, k, kind) => {
  const row = rows[k];
  const prevPeak = rows.slice(0, k).reverse().find((r) => !r.error)?.peak ?? state.first;
  if (kind === "peak") return [Math.max(row.yearFirst, prevPeak + 1), Math.min(row.yearFirst + 11, state.dates.length - 1)];
  const peak = row.error ? row.yearFirst + 11 : row.peak;
  return [prevPeak, peak - 1];
};

// One water year, zoomed in, where the trough and peak are moved by clicking.
const yearEditor = (state, rows, k, {onSelect, onPick, onReset}) => {
  const {dates, months, values, fill, areaKm2} = state;
  const row = rows[k];
  const x = (i) => dates[i].getTime();
  const node = el("div", "rc-editor");

  // Header: previous / this year / next.
  const nav = el("div", "rc-editor-nav");
  const prev = el("button", "rc-button rc-nav-btn", "◀");
  prev.type = "button";
  prev.title = "Previous water year (←)";
  prev.disabled = k === 0;
  prev.addEventListener("click", () => onSelect(rows[k - 1].waterYear));
  const next = el("button", "rc-button rc-nav-btn", "▶");
  next.type = "button";
  next.title = "Next water year (→)";
  next.disabled = k === rows.length - 1;
  next.addEventListener("click", () => onSelect(rows[k + 1].waterYear));
  const last = Math.min(row.yearFirst + 11, dates.length - 1);
  const title = el("div", "rc-editor-title");
  title.append(el("span", "rc-editor-year", `Water year ${row.waterYear}`),
    el("span", "rc-editor-range", `${monthLabel(months[row.yearFirst])} to ${monthLabel(months[last])} · ${k + 1} of ${rows.length}`));
  nav.append(prev, title, next);

  const mode = el("div", "rc-segmented");
  mode.setAttribute("role", "radiogroup");
  mode.setAttribute("aria-label", "Pick to move");
  for (const kind of ["trough", "peak"]) {
    const b = el("button", `rc-seg${state.editMode === kind ? " rc-seg-on" : ""}`, kind === "trough" ? "▼ Move trough" : "▲ Move peak");
    b.type = "button";
    b.setAttribute("aria-pressed", String(state.editMode === kind));
    b.addEventListener("click", () => {
      state.editMode = kind;
      onSelect(row.waterYear);
    });
    mode.append(b);
  }
  nav.append(mode);
  node.append(nav);

  // Zoomed chart: from a little before the recession starts to a little after
  // the water year ends.
  const [lo, hi] = allowedRange(state, rows, k, state.editMode);
  const start = Math.max(state.first, Math.min(row.error ? row.yearFirst : row.recession.from, lo, row.yearFirst) - 2);
  const end = Math.min(dates.length - 1, row.yearFirst + 13);
  const obs = [];
  const est = [];
  for (let i = start; i <= end; i++) {
    if (!Number.isFinite(fill.filled[i])) continue;
    obs.push({x: x(i), y: Number.isFinite(values[i]) ? values[i] : null});
    const edge = fill.isFilled[i] || fill.isFilled[i - 1] || fill.isFilled[i + 1];
    est.push({x: x(i), y: edge ? fill.filled[i] : null, f: fill.isFilled[i] === 1});
  }
  const allowed = [];
  for (let i = lo; i <= hi; i++) allowed.push({x: x(i), y: fill.filled[i], i});

  const grid = el("div", "rc-editor-grid");
  const chartBox = el("div", "rc-canvas rc-canvas-editor");
  const canvas = el("canvas");
  chartBox.append(canvas);
  const side = el("div", "rc-editor-side");
  grid.append(chartBox, side);
  node.append(grid);
  node.append(el("p", "rc-stat-note",
    `Click a circled month to move the ${state.editMode} there. Months in red are filled by the seasonal model rather than observed.`));

  const c = axisColors();
  const datasets = [
    {label: "Allowed", data: allowed, showLine: false, pointRadius: 7, pointHoverRadius: 9, pointHitRadius: 10,
      pointBackgroundColor: "transparent", pointBorderColor: state.editMode === "peak" ? COLOR.peak : COLOR.trough,
      pointBorderWidth: 1.5, order: 4},
    {label: "GWSa", data: obs, borderColor: COLOR.series, borderWidth: 2, pointRadius: 2.5, pointBackgroundColor: COLOR.series, spanGaps: false, order: 3},
    {label: "Filled", data: est, borderColor: COLOR.filled, borderWidth: 2, pointRadius: (ctx) => (ctx.raw?.f ? 2.5 : 0),
      pointBackgroundColor: COLOR.filled, spanGaps: false, order: 2},
  ];
  if (!row.error) {
    const peakX = x(row.peak);
    const dx = 8 * 864e5;
    datasets.push(
      {label: "Recession line", data: [{x: x(row.recession.from), y: row.recession.y0}, {x: x(row.recession.to), y: row.recession.y1}],
        borderColor: COLOR.recession, borderWidth: 1.6, borderDash: [5, 3], pointRadius: 0, order: 1},
      {label: "R1", data: [{x: peakX + dx, y: row.sB}, {x: peakX + dx, y: row.sP}], borderColor: COLOR.r1, borderWidth: 4, pointRadius: 0, order: 1},
      {label: "R2", data: [{x: peakX + 3 * dx, y: row.sL}, {x: peakX + 3 * dx, y: row.sP}], borderColor: COLOR.r2, borderWidth: 4, pointRadius: 0, order: 1},
      {label: "Trough", data: [{x: x(row.trough), y: row.sB}], showLine: false, pointStyle: "triangle", rotation: 180, pointRadius: 9,
        pointBackgroundColor: COLOR.trough, pointBorderColor: COLOR.trough, order: 0},
      {label: "Peak", data: [{x: peakX, y: row.sP}], showLine: false, pointStyle: "triangle", pointRadius: 9,
        pointBackgroundColor: COLOR.peak, pointBorderColor: COLOR.peak, order: 0},
    );
  }
  const chart = new Chart(canvas, {
    type: "line",
    data: {datasets},
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: {mode: "nearest", intersect: true},
      onClick: (event, _, ch) => {
        // The allowed month nearest the click, whether or not a circle was hit.
        const t = ch.scales.x.getValueForPixel(event.x);
        let best = null;
        for (const p of allowed) if (!best || Math.abs(p.x - t) < Math.abs(best.x - t)) best = p;
        if (best && Math.abs(best.x - t) < 20 * 864e5) onPick(row.waterYear, state.editMode, months[best.i]);
      },
      onHover: (event, _, ch) => {
        ch.canvas.style.cursor = "pointer";
      },
      scales: {
        x: {type: "time", time: {unit: "month", tooltipFormat: "MMM yyyy", displayFormats: {month: "MMM yy"}},
          ticks: {color: c.text, maxRotation: 0, autoSkip: true}, grid: {color: c.grid}},
        y: {title: {display: true, text: "GWSa (cm)", color: c.text}, ticks: {color: c.text},
          grid: {color: (ctx) => (ctx.tick?.value === 0 ? c.axis : c.grid)}},
      },
      plugins: {
        legend: {display: false},
        tooltip: {
          filter: (item) => item.dataset.label !== "Allowed" && item.dataset.label !== "Recession line",
          callbacks: {
            label: (item) => {
              const l = item.dataset.label;
              if (l === "R1") return `R1 = S_P − S_B = ${fmt(row.r1)} cm`;
              if (l === "R2") return `R2 = S_P − S_L = ${fmt(row.r2)} cm`;
              return `${l}: ${item.parsed.y.toFixed(2)} cm`;
            },
          },
        },
      },
    },
  });

  // Side panel: this year's numbers.
  if (row.error) {
    side.append(el("p", "rc-editor-error", row.error));
  } else {
    const dl = el("dl", "rc-editor-values");
    const item = (label, value, color) => {
      const dt = el("dt", null, label);
      if (color) dt.style.borderLeft = `4px solid ${color}`;
      dl.append(dt, el("dd", null, value));
    };
    const when = (i) => dates[i].toLocaleDateString("en-US", {month: "short", year: "numeric"});
    item(`Trough S_B (${when(row.trough)})`, `${fmt(row.sB)} cm`, COLOR.trough);
    item(`Peak S_P (${when(row.peak)})`, `${fmt(row.sP)} cm`, COLOR.peak);
    item("Recession S_L at peak", `${fmt(row.sL)} cm`, COLOR.recession);
    item("R1 (lower)", `${fmt(row.r1)} cm${areaKm2 ? ` · ${fmt(toKm3(row.r1, areaKm2), 2)} km³` : ""}`, COLOR.r1);
    item("R2 (upper)", `${fmt(row.r2)} cm${areaKm2 ? ` · ${fmt(toKm3(row.r2, areaKm2), 2)} km³` : ""}`, COLOR.r2);
    side.append(dl);
  }
  const notes = notesFor(row);
  if (notes && !row.error) side.append(el("p", "rc-stat-note", notes));
  const reset = el("button", "rc-button", "Reset this year");
  reset.type = "button";
  reset.disabled = !row.overridden.length;
  reset.addEventListener("click", () => onReset(row.waterYear));
  side.append(reset);

  return {node, chart};
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
    "trough and extended to the peak month (S<sub>L</sub>). Check each year in the editor below the chart; if a pick lands on a noisy spike, move it.";
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

  if (!rows.some((r) => r.waterYear === state.selectedYear)) state.selectedYear = rows[0]?.waterYear ?? null;
  const k = rows.findIndex((r) => r.waterYear === state.selectedYear);
  const selectYear = (year, {scroll = false} = {}) => {
    state.selectedYear = year;
    state.scrollToEditor = scroll;
    rerender();
  };
  const onPick = (year, kind, month) => {
    const picks = {...(state.overrides[year] ?? {})};
    picks[kind] = month;
    state.overrides[year] = picks;
    rerender();
  };
  const onReset = (year) => {
    delete state.overrides[year];
    rerender();
  };
  state.step = (dir) => {
    const j = k + dir;
    if (j >= 0 && j < rows.length) selectYear(rows[j].waterYear);
  };

  const box = el("div", "rc-chart-box");
  const canvasBox = el("div", "rc-canvas rc-canvas-tall");
  const canvas = el("canvas");
  canvasBox.append(canvas);
  box.append(canvasBox, el("p", "rc-stat-note", "Click a year in the chart to open it in the editor below. The shaded band is the selected water year."));
  s2.append(box);
  charts.push(picksChart(canvas, state, rows, rows[k], (y) => selectYear(y)));
  if (k >= 0) {
    const editor = yearEditor(state, rows, k, {onSelect: (y) => selectYear(y), onPick, onReset});
    s2.append(editor.node);
    charts.push(editor.chart);
    state.editorNode = editor.node;
  }
  wrap.append(s2);

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
  rows.forEach((r) => {
    const cls = [r.error ? "rc-row-error" : r.overridden.length ? "rc-row-edited" : "", r.waterYear === state.selectedYear ? "rc-row-selected" : ""];
    const tr = el("tr", cls.join(" ").trim());
    tr.title = "Open this year in the editor";
    tr.addEventListener("click", () => selectYear(r.waterYear, {scroll: true}));
    tr.append(el("td", null, String(r.waterYear)));
    tr.append(el("td", null, r.error ? "" : monthLabel(months[r.trough]) + (r.overridden.includes("trough") ? " ✎" : "")));
    tr.append(el("td", null, r.error ? "" : monthLabel(months[r.peak]) + (r.overridden.includes("peak") ? " ✎" : "")));
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
  let stepYear = () => {};
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
    const state = {name, dates, months, values, fill, areaKm2, first, startMonth: s.troughMonth, startMonthChoice: null, overrides: {},
      selectedYear: null, editMode: "trough"};
    stepYear = (dir) => state.step?.(dir);
    const holder = el("div");
    body.append(holder);
    let current = null;
    const rerender = () => {
      const scroll = body.scrollTop;
      current?.charts.forEach((c) => c.destroy());
      current = analysisSection(state, rerender);
      holder.replaceChildren(current.node);
      body.scrollTop = scroll;
      if (state.scrollToEditor && state.editorNode) {
        state.editorNode.scrollIntoView({block: "center"});
        state.scrollToEditor = false;
      }
    };
    rerender();
    charts.push({destroy: () => current?.charts.forEach((c) => c.destroy())});
  }

  root.append(header, body);
  document.body.append(root);
  back.focus();

  const onKey = (e) => {
    if (e.key === "Escape") closeRechargeView();
    // ← and → step through the water years, unless a control has the keys.
    const typing = /^(SELECT|INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "");
    if (!typing && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      stepYear(e.key === "ArrowLeft" ? -1 : 1);
    }
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
