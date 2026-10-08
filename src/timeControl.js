/**
 * The animation control under the map: play/pause, a scrubber over the dates
 * that have data, and the date itself.
 *
 * This replaces <arcgis-time-slider>, which could not be themed to match the
 * rest of the app: view.ui.add() moves a widget into the arcgis-map component's
 * shadow DOM, where page stylesheets — including every token in style.css — no
 * longer reach it. Owning the markup is what buys the dark card, and it costs
 * only the playback timer, since the app already drove the slider through one
 * narrow interface (a stop list, a rate, a loop flag, and an index callback).
 *
 * Steps are indices into the *full* date list, not into the stop list. A
 * variable with gaps gets a shorter stop list, but the handlers downstream all
 * address time by its position in timeDates, so that is what onStep reports.
 */

const pad = (n) => String(n).padStart(2, "0");
const formatDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;

/**
 * @param {object} opts
 * @param {HTMLElement} opts.root      the control's container, already in the DOM
 * @param {Date[]} opts.allDates       every date in the store, the index space onStep reports in
 * @param {(index: number) => void} opts.onStep  called with an index into allDates
 */
export function createTimeControl({root, allDates, onStep}) {
  const playButton = root.querySelector("[data-time-play]");
  const playIcon = root.querySelector("[data-time-play-icon]");
  const pauseIcon = root.querySelector("[data-time-pause-icon]");
  const range = root.querySelector("[data-time-range]");
  const label = root.querySelector("[data-time-label]");

  let stops = [];        // the dates this variable actually has
  let position = 0;      // index into stops
  let timer = null;
  let playRate = 1000;
  let loop = false;

  const indexInAll = (date) => allDates.findIndex((d) => d.getTime() === date.getTime());

  const paint = () => {
    const date = stops[position];
    range.value = String(position);
    label.textContent = date ? formatDate(date) : "—";
  };

  // The one place a step reaches the rest of the app. Painting first keeps the
  // date honest even when the handler below is slow.
  const emit = () => {
    paint();
    const date = stops[position];
    if (!date) return;
    const idx = indexInAll(date);
    if (idx >= 0) onStep(idx);
  };

  const setPlaying = (playing) => {
    playIcon.hidden = playing;
    pauseIcon.hidden = !playing;
    playButton.setAttribute("aria-label", playing ? "Pause animation" : "Play animation");
    playButton.setAttribute("aria-pressed", String(playing));
  };

  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    setPlaying(false);
  };

  const advance = () => {
    if (position >= stops.length - 1) {
      // Not looping means the run is over; rewinding instead would hide that.
      if (!loop) return stop();
      position = 0;
    } else {
      position++;
    }
    emit();
  };

  const play = () => {
    if (stops.length < 2) return;
    // Starting from the end would tick once and stop, which reads as a broken
    // button, so a play from the last frame rewinds first.
    if (position >= stops.length - 1) position = 0;
    stop();
    setPlaying(true);
    timer = setInterval(advance, playRate);
    emit();
  };

  playButton.addEventListener("click", () => (timer === null ? play() : stop()));

  // Scrubbing is a deliberate move to one frame, so it takes over from playback
  // rather than fighting it.
  range.addEventListener("input", () => {
    stop();
    position = Number(range.value);
    emit();
  });

  return {
    /**
     * Point the control at a new stop list. keepCurrent preserves the showing
     * date across a variable toggle — comparing two variables at the same month
     * is the whole reason to toggle — and falls back to the first stop when the
     * new variable has no data for it.
     */
    configure(dates, {keepCurrent = false} = {}) {
      const current = stops[position];
      stops = dates;
      const kept = keepCurrent && current ? dates.findIndex((d) => d.getTime() === current.getTime()) : -1;
      position = kept >= 0 ? kept : 0;
      range.min = "0";
      range.max = String(Math.max(dates.length - 1, 0));
      range.disabled = dates.length < 2;
      root.hidden = dates.length === 0;
      paint();
    },
    stop,
    /** Put the bar away. There is nothing to animate without an analysis. */
    hide() {
      stop();
      root.hidden = true;
    },
    get currentDate() {
      return stops[position] ?? null;
    },
    set playRate(ms) {
      playRate = ms;
      if (timer !== null) play(); // restart at the new rate
    },
    set loop(value) {
      loop = value;
    },
  };
}
