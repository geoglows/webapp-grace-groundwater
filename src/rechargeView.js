// The Recharge Analysis page: a full-window view over the app, opened from the
// time series chart when gaps are filled with the seasonal model. It works on
// the GWSa series of whatever is selected (a region or a picked cell) and
// closes back to the map with everything as it was.
//
// The calculations are in recharge.js; this file only lays them out.

import {BarController, BarElement, CategoryScale, Chart, LinearScale, Tooltip} from "chart.js";

import {monthIndexOf, seasonalFillCached} from "./gapFill.js";
import {analyzeSeasonality} from "./recharge.js";

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip);

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
