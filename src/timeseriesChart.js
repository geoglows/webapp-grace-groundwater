import {
  Chart,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  TimeScale,
  Title,
  Tooltip,
} from "chart.js";
import "chartjs-adapter-date-fns";

// Explicit registration instead of chart.js/auto: this chart is one line plus a
// filled uncertainty band, so pulling in every controller (bar, pie, radar,
// scatter…) would be dead weight in the bundle.
Chart.register(LineController, LineElement, PointElement, LinearScale, TimeScale, Filler, Title, Tooltip, Legend);

// Vertical rule marking the month the map is currently showing. This is the
// replacement for the Plotly shape that used to be pushed with relayout(); as a
// plugin it draws straight onto the canvas with no data-structure churn, so
// scrubbing the time slider costs one repaint instead of a chart rebuild.
const timeMarkerPlugin = {
  id: "timeMarker",
  afterDatasetsDraw(chart) {
    const at = chart.$timeMarker;
    if (at == null) return;
    const x = chart.scales.x.getPixelForValue(at);
    if (!Number.isFinite(x)) return;
    const {top, bottom, left, right} = chart.chartArea;
    if (x < left || x > right) return;
    const {ctx} = chart;
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#f87171";
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};
Chart.register(timeMarkerPlugin);

// Read at call time rather than at module load: the tokens live on :root in
// style.css, which is a separate stylesheet and may not have applied yet when
// this module is first evaluated.
const token = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

// Brighter than the map's #1c6eec, which is the blue end of the anomaly scale
// and reads as near-black against a --surface ground.
const LINE_COLOR = "#60a5fa";
const BAND_COLOR = "rgba(96,165,250,0.25)";

// `dates` carry the dataset's UTC calendar date in their LOCAL fields (see
// toDisplayDate in main.js), so the day has to be read off those. toISOString()
// would re-interpret them as instants and hand back the previous day for every
// browser west of Greenwich.
const isoDay = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const toCsv = ({dates, values, uncertainty, name}) => {
  const header = uncertainty ? ["Date", name, `${name}_upper`, `${name}_lower`] : ["Date", name];
  const rows = [header.join(",")];
  for (let i = 0; i < dates.length; i++) {
    const center = values[i];
    if (!Number.isFinite(center)) continue; // missing GRACE months stay out of the file
    const cells = [isoDay(dates[i]), center];
    if (uncertainty) {
      const unc = uncertainty[i];
      const hasBand = Number.isFinite(unc);
      cells.push(hasBand ? center + unc : "", hasBand ? center - unc : "");
    }
    rows.push(cells.join(","));
  }
  return rows.join("\n");
};

const downloadCsv = (csv, filename) => {
  const blob = new Blob([csv], {type: "text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

/**
 * Render the area-mean time series into `container`, replacing whatever it held.
 *
 * `units` and `valueLabel` name the y axis and come from .env (settings.js), so
 * the chart, the color bar, and the map's legend all read the same way.
 *
 * Returns {setMarker(date), destroy()}. NaN samples (missing GRACE months and
 * the GRACE/GRACE-FO gap) are dropped rather than plotted, so the line bridges
 * gaps with a straight segment — the same behavior the Plotly version had.
 */
export function renderTimeseriesChart({
  container,
  dates,
  values,
  uncertainty,
  name,
  longName,
  units = "cm",
  valueLabel = "Liquid Water Equivalent",
  fileStem,
}) {
  const line = [];
  const upper = [];
  const lower = [];
  for (let i = 0; i < dates.length; i++) {
    const y = values[i];
    if (!Number.isFinite(y)) continue;
    // x MUST be a numeric timestamp, not a Date. `parsing: false` below tells
    // Chart.js the data is already in the scale's internal format and skips the
    // parse step that would otherwise convert a Date via the date adapter —
    // leaving Date objects here makes the time scale's min/max come out NaN and
    // silently renders an empty plot area.
    const x = dates[i].getTime();
    line.push({x, y});
    const unc = uncertainty?.[i];
    if (Number.isFinite(unc)) {
      upper.push({x, y: y + unc});
      lower.push({x, y: y - unc});
    }
  }
  const hasBand = upper.length > 0;

  container.replaceChildren();
  const wrapper = document.createElement("div");
  wrapper.className = "ts-chart";
  const canvasBox = document.createElement("div");
  canvasBox.className = "ts-chart-canvas";
  const canvas = document.createElement("canvas");
  canvasBox.append(canvas);

  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.className = "ts-download";
  downloadButton.textContent = "Download CSV";
  downloadButton.title = `Download the plotted ${longName} time series as CSV`;
  downloadButton.addEventListener("click", () =>
    downloadCsv(toCsv({dates, values, uncertainty, name}), `${fileStem}_data.csv`),
  );

  wrapper.append(canvasBox, downloadButton);
  container.append(wrapper);

  const axisText = token("--chart-text", "#b6c2d3");
  const gridColor = token("--chart-grid", "rgba(148,163,184,0.14)");
  const zeroLine = token("--chart-axis", "#64748b");
  const titleText = token("--text", "#f8fafc");

  const datasets = [];
  if (hasBand) {
    // Band drawn as an upper series filled down to the lower series. Chart.js
    // draws datasets in reverse `order`, so the band's higher order puts it
    // behind the line rather than painting over it.
    datasets.push(
      {
        label: `${name} Uncertainty`,
        data: upper,
        borderWidth: 0,
        pointRadius: 0,
        backgroundColor: BAND_COLOR,
        fill: {target: 1},
        order: 1,
      },
      {
        label: `${name} Uncertainty Lower`,
        data: lower,
        borderWidth: 0,
        pointRadius: 0,
        fill: false,
        order: 1,
      },
    );
  }
  datasets.push({
    label: name,
    data: line,
    borderColor: LINE_COLOR,
    borderWidth: 2,
    pointRadius: 0,
    pointHitRadius: 8,
    fill: false,
    order: 0,
  });

  const chart = new Chart(canvas, {
    type: "line",
    data: {datasets},
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false, // the slider redraws this constantly; tweening just smears
      parsing: false, // data is already {x, y} with Date x values
      normalized: true,
      interaction: {mode: "nearest", axis: "x", intersect: false},
      scales: {
        x: {
          type: "time",
          time: {unit: "year", tooltipFormat: "MMM yyyy"},
          title: {display: true, text: "Time", color: axisText, font: {size: 12}},
          ticks: {color: axisText, maxRotation: 0, autoSkip: true},
          grid: {color: gridColor},
        },
        y: {
          title: {display: true, text: `${valueLabel} (${units})`, color: axisText, font: {size: 12}},
          ticks: {color: axisText},
          grid: {
            // Zero is the reference every anomaly is read against, so its
            // gridline is drawn as a solid black baseline rather than one more
            // faint tick line.
            color: (ctx) => (ctx.tick?.value === 0 ? zeroLine : gridColor),
            lineWidth: (ctx) => (ctx.tick?.value === 0 ? 2 : 1),
          },
        },
      },
      plugins: {
        title: {
          display: true,
          text: `${longName} Time Series${hasBand ? " and Uncertainty" : ""}`,
          color: titleText,
          font: {size: 14, weight: "bold"},
        },
        legend: {display: false},
        tooltip: {
          // Only the line carries a meaningful reading; the two band series
          // would otherwise add two noise rows to every tooltip.
          filter: (item) => item.datasetIndex === datasets.length - 1,
          callbacks: {
            label: (item) => `${name}: ${item.parsed.y.toFixed(2)} ${units}`,
          },
        },
      },
    },
  });

  return {
    setMarker(date) {
      // Same rule as the dataset x values: the scale works in timestamps.
      chart.$timeMarker = date == null ? null : date.getTime();
      chart.update("none");
    },
    destroy() {
      chart.destroy();
    },
  };
}
