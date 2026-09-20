/**
 * The chart palette and type scale: sizes, stroke weights, and which colour token a machine, a
 * wait or a pitch class gets.
 *
 * Every chart reads these rather than writing its own numbers, so one change to the ramp or the
 * type scale moves every chart together. The tokens themselves live on `.viz`; see `charts.ts`.
 */

import { MACHINE_ORDER } from "../../../../src/analysis/model.js";

/** Chart type sizes, in real pixels. */
export const T = {
  tick: 10,     // axis and scale numbers
  label: 10,    // series and category names
  value: 9,     // numbers printed against a mark
  flag: 10,     // the one call-out per chart
} as const;

/** Stroke weights. `series` was 2 and was the single biggest cause of the heaviness. */
export const W = {
  series: 1.25,
  limit: 1,
  axis: 1,
  grid: 1,
} as const;

/** Gridlines carry at low opacity rather than at low weight. */
export const GRID_OP = 0.55;

/**
 * The two colours the charts write directly rather than through a `.viz` token.
 *
 * `GROUND` is the dark well a row of marks is drawn in, and it was a hex literal in five places
 * across three files. `INK_ON_LIGHT` is the ink the alignment grid switches to on the pale end of
 * the ramp, measured against `--q4` (`#3a86b4`) rather than guessed; see `rampIsLight`.
 *
 * They are not tokens because they are not part of the palette a host restyles: a ground that
 * followed the page background would put light marks on a light surface.
 */
export const GROUND = "#1a1f21";
export const INK_ON_LIGHT = "#0d1418";

/**
 * A machine's series colour.
 *
 * Five machines against an eight-slot categorical palette, which is why the pitch histogram stacks
 * by machine and not by track: sixteen tracks cannot be coloured, and five can. A machine this
 * project cannot name gets the muted ink rather than a sixth hue, so "unknown" never looks like a
 * category of its own.
 */
export function machineVar(machine: number | undefined): string {
  const at = machine === undefined ? -1 : MACHINE_ORDER.indexOf(machine);
  return at === -1 ? "--ink3" : `--s${at + 1}`;
}

/**
 * Which step of the six-value sequential ramp a wait falls on.
 *
 * **Exported so the grid and the prose under it can agree.** A colour that appears in a chart and
 * nowhere else is a colour the reader has to hold in their head; the same number written in a
 * sentence should carry the same swatch. Logarithmic, because alignments span 2 bars to 124 in the
 * same pattern and a linear ramp would put every one of them except the worst in the first band.
 */
export function rampBand(steps: number, worst: number): number {
  if (!(worst > 1) || !(steps > 0)) return 0;
  return Math.min(5, Math.max(0, Math.floor((Math.log(steps) / Math.log(worst)) * 5.99)));
}

/** True when `--q<band+1>` is light enough that dark ink reads better on it. */
export function rampIsLight(band: number): boolean {
  return band >= 3;
}

/** The hue wheel for pitch class — see `trackTimeline` for why twelve hues are allowed here. */
export const pcHue = (pc: number) => `hsl(${pc * 30} 52% 56%)`;
