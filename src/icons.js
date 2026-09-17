import arrowUpTray from "heroicons/24/outline/arrow-up-tray.svg?raw";
import cloudArrowUp from "heroicons/24/outline/cloud-arrow-up.svg?raw";
import cog6Tooth from "heroicons/24/outline/cog-6-tooth.svg?raw";
import globeAmericas from "heroicons/24/outline/globe-americas.svg?raw";
import map from "heroicons/24/outline/map.svg?raw";
import minus from "heroicons/24/outline/minus.svg?raw";
import pause from "heroicons/24/solid/pause.svg?raw";
import pencil from "heroicons/24/outline/pencil.svg?raw";
import plus from "heroicons/24/outline/plus.svg?raw";
import square3Stack3d from "heroicons/24/outline/square-3-stack-3d.svg?raw";
import play from "heroicons/24/solid/play.svg?raw";
import xMark from "heroicons/24/outline/x-mark.svg?raw";

const ICONS = {
  "arrow-up-tray": arrowUpTray,
  "cloud-arrow-up": cloudArrowUp,
  "cog-6-tooth": cog6Tooth,
  "globe-americas": globeAmericas,
  map,
  minus,
  pause,
  pencil,
  play,
  plus,
  "square-3-stack-3d": square3Stack3d,
  "x-mark": xMark,
};

// Replaces every `<span data-icon="name">` under `root` with its heroicon.
export const hydrateIcons = (root = document) => {
  for (const el of root.querySelectorAll("[data-icon]")) {
    const svg = ICONS[el.dataset.icon];
    if (!svg) {
      console.warn(`Unknown heroicon "${el.dataset.icon}"`);
      continue;
    }
    el.innerHTML = svg;
  }
};
