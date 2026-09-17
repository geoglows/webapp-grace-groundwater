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

// The line color a caller did not name. #60a5fa is GWSa's, and brighter than the
// map's #1c6eec, which is the blue end of the anomaly scale and reads as
// near-black against a --surface ground.
const DEFAULT_LINE_COLOR = "#60a5fa";

// The uncertainty band is the line at low alpha, so a new variable color needs
// nothing beyond the one hex value in VARIABLES.
const withAlpha = (hex, alpha) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${alpha})`;
};

// `dates` carry the dataset's UTC calendar date in their LOCAL fields (see
// toDisplayDate in main.js), so the day has to be read off those. toISOString()
// would re-interpret them as instants and hand back the previous day for every
// browser west of Greenwich.
const isoDay = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/**
 * One column per variable, whatever is currently plotted — a file that changes
 * shape with the chart is a worse record of the region than one that always
 * says the same thing. Uncertainty columns follow each variable that has them.
 *
 * A row survives if any variable has a reading for that month: dropping months
 * where one variable happens to be missing would silently shorten the others.
 */
export const seriesToCsv = ({dates, series}) => {
  const header = ["Date"];
  for (const s of series) {
    header.push(s.name);
    if (s.uncertainty) header.push(`${s.name}_upper`, `${s.name}_lower`);
  }
  const rows = [header.join(",")];
  for (let i = 0; i < dates.length; i++) {
    if (!series.some((s) => Number.isFinite(s.values[i]))) continue;
    const cells = [isoDay(dates[i])];
    for (const s of series) {
      const center = s.values[i];
      const has = Number.isFinite(center);
      cells.push(has ? center : "");
      if (s.uncertainty) {
        const unc = s.uncertainty[i];
        const band = has && Number.isFinite(unc);
        cells.push(band ? center + unc : "", band ? center - unc : "");
      }
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
 * Render one or more area-mean time series into `container`, replacing whatever
 * it held.
 *
 * `series` is ordered: the first entry is the displayed layer — the variable the
 * map is showing — and the rest are comparison curves. That first entry is the
 * only one that can carry an uncertainty band, and only when it is alone:
 * several translucent bands over each other read as mush rather than as spread,
 * so a second curve trades the band away for the comparison.
 *
 * `units` and `valueLabel` name the y axis and come from .env (settings.js), so
 * the chart, the color bar, and the map's legend all read the same way. All four
 * variables are liquid water equivalent in the same units, which is what lets
 * them share one axis.
 *
 * `getCsv` is called on download and returns the file contents, possibly after
 * loading variables that are not plotted — see the CSV note in main.js.
 *
 * Returns {setMarker(date), destroy()}. NaN samples (missing GRACE months and
 * the GRACE/GRACE-FO gap) are dropped rather than plotted, so a line bridges
 * gaps with a straight segment — the same behavior the Plotly version had.
 */
export function renderTimeseriesChart({
  container,
  dates,
  series,
  units = "cm",
  valueLabel = "Liquid Water Equivalent",
  fillGaps = true,
  fileStem,
  getCsv,
}) {
  const multiple = series.length > 1;

  // x MUST be a numeric timestamp, not a Date. `parsing: false` below tells
  // Chart.js the data is already in the scale's internal format and skips the
  // parse step that would otherwise convert a Date via the date adapter —
  // leaving Date objects here makes the time scale's min/max come out NaN and
  // silently renders an empty plot area.
  const points = series.map(({values, uncertainty}, idx) => {
    const line = [];
    const upper = [];
    const lower = [];
    const wantsBand = idx === 0 && !multiple && uncertainty;
    for (let i = 0; i < dates.length; i++) {
      const y = values[i];
      const x = dates[i].getTime();
      // A null y is what breaks a line in Chart.js. Carried only when the gaps
      // are meant to show: dropping the point entirely is what makes the
      // neighbours join up, so `fillGaps` is the choice between the two. The
      // band is two more lines and has to break at the same months, or it spans
      // a gap the line it belongs to does not.
      const gap = () => {
        line.push({x, y: null});
        if (wantsBand) {
          upper.push({x, y: null});
          lower.push({x, y: null});
        }
      };
      if (!Number.isFinite(y)) {
        if (!fillGaps) gap();
        continue;
      }
      line.push({x, y});
      if (!wantsBand) continue;
      const unc = uncertainty[i];
      if (Number.isFinite(unc)) {
        upper.push({x, y: y + unc});
        lower.push({x, y: y - unc});
      } else if (!fillGaps) {
        // A month with a reading but no uncertainty: the line goes on, the band
        // does not.
        upper.push({x, y: null});
        lower.push({x, y: null});
      }
    }
    return {line, upper, lower};
  });
  // Nulls count toward length, so an all-null band would pass a length check.
  const hasBand = points[0].upper.some((p) => p.y !== null);

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
  downloadButton.title = "Download every variable's time series for this region as CSV";
  downloadButton.addEventListener("click", async () => {
    // The file covers variables that may never have been plotted, so it can
    // need a read before it exists. Say so rather than appearing to do nothing.
    downloadButton.disabled = true;
    downloadButton.textContent = "Preparing…";
    try {
      downloadCsv(await getCsv(), `${fileStem}_data.csv`);
    } catch (err) {
      console.error("Could not build the CSV", err);
    } finally {
      downloadButton.disabled = false;
      downloadButton.textContent = "Download CSV";
    }
  });

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
    const {name, color} = series[0];
    datasets.push(
      {
        label: `${name} Uncertainty`,
        data: points[0].upper,
        borderWidth: 0,
        pointRadius: 0,
        backgroundColor: withAlpha(color, 0.25),
        fill: {target: 1},
        order: 1,
      },
      {
        label: `${name} Uncertainty Lower`,
        data: points[0].lower,
        borderWidth: 0,
        pointRadius: 0,
        fill: false,
        order: 1,
      },
    );
  }
  // The displayed layer is drawn last so it sits on top of the comparisons, and
  // a touch heavier — it is the one the map and the color bar agree with.
  const lineStart = datasets.length;
  series.forEach(({name, color}, idx) => {
    datasets.push({
      label: name,
      data: points[idx].line,
      borderColor: color ?? DEFAULT_LINE_COLOR,
      borderWidth: idx === 0 ? 2 : 1.5,
      pointRadius: 0,
      pointHitRadius: 8,
      fill: false,
      order: 0,
    });
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
          // One variable names itself; several are only their shared quantity.
          text: multiple
            ? `${valueLabel} Time Series`
            : `${series[0].longName} Time Series${hasBand ? " and Uncertainty" : ""}`,
          color: titleText,
          font: {size: 14, weight: "bold"},
        },
        // With one curve the title already says which variable it is; with
        // several the legend is the only thing that does.
        legend: {
          display: multiple,
          position: "bottom",
          labels: {color: axisText, boxWidth: 12, boxHeight: 2, font: {size: 11}},
          // The band's two datasets have no meaning of their own to show.
          filter: (item) => item.datasetIndex >= lineStart,
        },
        tooltip: {
          // Only the lines carry a meaningful reading; the band series would
          // otherwise add two noise rows to every tooltip.
          filter: (item) => item.datasetIndex >= lineStart,
          callbacks: {
            label: (item) => `${item.dataset.label}: ${item.parsed.y.toFixed(2)} ${units}`,
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
