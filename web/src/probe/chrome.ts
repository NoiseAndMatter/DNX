/**
 * The two pieces of page furniture every part of the probe writes to.
 *
 * ## Why these are singletons and not arguments
 *
 * A page has **one** status line and **one** progress bar, and eight modules now have something to
 * say through them. Threading both through every call would be ceremony around a fact that is
 * already true: `statusBar()` binds to the element the markup carries, so calling it twice hands
 * back two writers onto the same line, while `progressBar()` **builds its own element on first
 * use** — call it twice and the page grows a second bar that nothing ever finishes.
 *
 * So the bar in particular has to be shared, and once one of them is shared the honest thing is to
 * keep both in one place and name it. Same shape as `messageids.ts`, which holds the page's one id
 * allocator for the same reason.
 */

import { progressBar } from "../progress.js";
import { statusBar } from "../statusbar.js";

/** The one status line at the foot of the probe. */
export const status = statusBar();

/** The one progress bar. Built lazily, on the first `at` or `working`. */
export const bar = progressBar();

/**
 * A rolling indicator, so "still going" is visible without reading numbers.
 *
 * Shared because two long operations advance it: the listener between arriving messages, and the
 * project read between objects. A project dump is minutes of silence punctuated by a message every
 * so often, and a static byte count during that gap is indistinguishable from a stall.
 */
export const SPINNER = ["|", "/", "-", "\\"];
