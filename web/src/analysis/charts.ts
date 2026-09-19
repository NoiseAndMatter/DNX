/**
 * The charts: data in, SVG string out.
 *
 * ## Nothing here touches a document
 *
 * Every function returns markup and reads nothing but its arguments. `mount.ts` is what puts a
 * chart on a page and keeps it at the right width; the tooltip lives there too. The split is the
 * same one `selection.ts` was cut out of `grid.ts` for — **a pure thing inside a DOM module is a
 * pure thing nobody can test** — and `test/web.test.ts` enforces it by walking the import graph.
 *
 * ## Why the type scale is trustworthy
 *
 * Every chart is drawn at its container's real pixel width and its `viewBox` is set to that width,
 * so one unit inside the SVG is one CSS pixel and `T.tick` means what it says. It was not always
 * so: the viewBox was a fixed 940 while the card rendered near 1130, which multiplied every label
 * by 1.2 — a declared 10px landed at 12px against 13px body text, and the factor moved with the
 * window. That is why the labels read as huge and why the scale drifted as the window changed.
 *
 * The ramp follows the convention shared by IBM Carbon, Adobe Spectrum and the FT's visual
 * vocabulary: chart text sits a step or two below body text and never competes with it, and
 * structural lines are hairlines while only the data itself carries weight.
 *
 * ## `windowSteps`, not `window`
 *
 * The span a chart draws is the natural word for it, and it is also the name of a global these
 * modules must never reach for. Shadowing it would make a later `window.innerWidth` read as a
 * number of steps, and the boundary test that checks these files touch no browser API could not
 * tell the two apart. Named apart, both problems go away.
 *
 * ## Colour
 *
 * The `--s*`, `--q*`, `--d*` and `--crit` tokens are declared on `.viz` by whoever hosts the
 * charts, never on `:root` — they are a chart palette, not the app's, and the overlap budget in
 * `test/web.test.ts` is zero.
 *
 * ## Why this file is only re-exports
 *
 * The charts live in `charts/`, one file per family, and this file names them all. It stays
 * because callers find the charts by this path: the purity tests in `test/analysis.test.ts` walk
 * the import graph from it, `web/mockups/metrics.html` imports its compiled copy, and the manager's
 * Insights mode imports it. There is no `charts/index.ts` in its place, because `nodenext`
 * resolution does not turn a folder import into its `index`.
 *
 * The files inside the folder import the model and the shared `theme.ts` and `svg.ts`. A chart
 * file never imports another chart file, and nothing in the folder imports this one.
 */

export { T, W, GRID_OP, machineVar, rampBand, rampIsLight, pcHue } from "./charts/theme.js";
export { TIP_SELECTOR } from "./charts/svg.js";
export { rampLegend, legend, pcLegend, table } from "./charts/legend.js";
export { phaseStrip, densityBars, microDiverging } from "./charts/rhythm.js";
export type { PhaseMode } from "./charts/rhythm.js";
export { realignBars, cycleBars } from "./charts/cycle.js";
export type { CycleBar } from "./charts/cycle.js";
export { resetRuler, alignmentGrid } from "./charts/reset.js";
export { voiceArea, voiceLanes } from "./charts/voices.js";
export { pitchBars, keyTimeline, trackTimeline } from "./charts/pitch.js";
