/**
 * A verdict, said twice, from one object.
 *
 * The card and the status line under it used to be written out separately at each call site, and
 * twice they disagreed — which is the worst possible failure for a page whose whole job is to
 * report what an instrument did. Both halves now come from one `Verdict`, so they cannot.
 */

import { messageCard as drawMessages, verdictCard as drawVerdict } from "./cards.js";
import { status } from "./chrome.js";
import { type Verdict } from "./silence.js";
import { $ } from "../dom.js";
import { hex } from "@noiseandmatter/dnx-core/device/capabilities.js";

/** The write verdict, into the element this page reserves for it. */
export function verdictCard(title: string, rows: [string, string][]): void {
  drawVerdict($("writeResult"), title, rows);
}

/**
 * Draw a verdict and say the same thing in the status bar.
 *
 * Both halves come from one object, so the card and the line under it cannot disagree — which they
 * could when each call site wrote them out separately, and twice did.
 */
export function showVerdict(
  verdict: Verdict,
  into: (title: string, rows: [string, string][]) => void = verdictCard,
): void {
  into(verdict.title, verdict.rows);
  status(verdict.message, verdict.level);
}

/** Supported messages, with this page's hex formatter. */
export function messageCard(into: HTMLElement, codes: readonly number[]): void {
  drawMessages(into, codes, hex);
}
