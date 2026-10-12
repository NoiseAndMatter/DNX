/**
 * Painting one wavetable as the stacked perspective view.
 *
 * **One job: turning a `Waterfall` into SVG.** Where every frame sits is `waverider/waterfall.ts`'s
 * answer and it is arithmetic a test checks; which of them is bright, how thick its stroke is and
 * what the two end labels say is a look, and it lives here. The pane above decides *when* to draw
 * and owns the device read.
 *
 * Built with `createElementNS` rather than an `innerHTML` string. An SVG assembled as text has to
 * escape every path it interpolates, and a path is the one thing on this page that is generated
 * per frame — sixty-four chances to get the escaping wrong for no gain, when the nodes are the
 * same amount of code.
 */

import { type Waterfall } from "@noiseandmatter/dnx-core/waverider/waterfall.js";

const SVG = "http://www.w3.org/2000/svg";

/**
 * How far from the named frame a neighbour still counts as near.
 *
 * Two, because one neighbour either side reads as a thick line rather than a stack, and three
 * starts to hide which frame the slider is actually on.
 */
const NEAR = 2;

/** What to say at the two ends of the stack, and which frame is named. */
export interface WaterfallLabels {
  /** The frame the slider is on, zero-based, or `undefined` when none is. */
  current?: number;
  /** Total frames, for the far label. */
  waves: number;
}

/**
 * Draw `table` into `host`, replacing whatever was there.
 *
 * The frames arrive furthest first, so painting them in the order given puts the near ones on top
 * with no sorting here.
 */
export function paintWaterfall(
  host: HTMLElement,
  drawn: Waterfall,
  labels: WaterfallLabels,
): void {
  host.replaceChildren();

  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", drawn.viewBox);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    labels.current === undefined
      ? `All ${labels.waves} frames of the table, stacked front to back`
      : `All ${labels.waves} frames of the table, stacked front to back, ` +
        `with frame ${labels.current + 1} picked out`,
  );

  // The edges of the stack first, so every frame sits over them.
  for (const d of drawn.guides) {
    const guide = document.createElementNS(SVG, "path");
    guide.setAttribute("d", d);
    guide.setAttribute("fill", "none");
    guide.setAttribute("stroke", "var(--line-soft)");
    guide.setAttribute("stroke-width", "1");
    svg.append(guide);
  }

  for (const frame of drawn.frames) {
    const near = labels.current === undefined ? NEAR + 1 : Math.abs(frame.index - labels.current);
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", frame.d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute(
      "stroke",
      near === 0 ? "var(--focus)" : near <= NEAR ? "var(--teal-mid)" : "var(--teal-dim)",
    );
    path.setAttribute("stroke-width", near === 0 ? "2.6" : "1.2");
    // The far frames are dimmed by opacity as well as colour, so the stack reads as depth rather
    // than as two groups of lines.
    path.setAttribute("opacity", near === 0 ? "1" : near <= NEAR ? "0.9" : "0.55");
    svg.append(path);
  }

  if (drawn.marker !== undefined) {
    const marker = document.createElementNS(SVG, "path");
    marker.setAttribute("d", drawn.marker);
    marker.setAttribute("fill", "none");
    marker.setAttribute("stroke", "var(--amber)");
    marker.setAttribute("stroke-width", "1.5");
    marker.setAttribute("stroke-dasharray", "4 4");
    svg.append(marker);
  }

  // **In the padding band, not on the drawing.** Placed from the measured box so a different view
  // keeps them in frame, and inside the padding `WATERFALL_VIEW.pad` leaves so the outermost frame
  // passes under neither of them. Drawn last, so if a view ever does run a frame through a corner
  // the label still reads.
  const edge = 8;
  const { x, y, width, height } = drawn.box;
  svg.append(
    endLabel(`frame ${labels.waves}`, x + edge, y + height - edge, "start"),
    endLabel("frame 1", x + width - edge, y + 14, "end"),
  );

  host.append(svg);
}

/** One corner label. */
function endLabel(text: string, x: number, y: number, anchor: "start" | "end"): SVGTextElement {
  const label = document.createElementNS(SVG, "text");
  label.setAttribute("x", String(x));
  label.setAttribute("y", String(y));
  label.setAttribute("text-anchor", anchor);
  label.setAttribute("fill", "var(--dim)");
  label.setAttribute("font-family", "ui-monospace, Consolas, monospace");
  label.setAttribute("font-size", "13");
  label.textContent = text;
  return label;
}
