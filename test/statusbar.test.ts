/**
 * The shared status bar.
 *
 * **Written because the expander's status line stopped being a bar the moment it had something to
 * say.** `statusBar` rebuilt `className` from a `base` argument, the expander passed `""`, and the
 * first message deleted the element's own `status` class — background, border, padding and position
 * with it. The page tests could not see it: every id existed, every file parsed, and the class was
 * only wrong after a message had been written.
 *
 * `applyStatus` takes a target rather than an id precisely so this can be tested without a DOM.
 * The bar now lives in `web/src/statusbar.ts`, which owns its class as well as its text — being
 * filed as a four-line helper in `dom.ts` is how a caller came to be able to erase it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyStatus, type StatusTarget } from "../web/src/statusbar.js";

/** A stand-in for the parts of an element a status message may touch. */
function target(...initial: string[]): StatusTarget & { classes: Set<string> } {
  const classes = new Set(initial);
  return {
    classes,
    textContent: null,
    classList: {
      add: (name: string) => void classes.add(name),
      remove: (...names: string[]) => names.forEach((n) => classes.delete(n)),
    },
  };
}

test("the message is written and the page's own classes survive", () => {
  const bar = target("status");
  applyStatus(bar, "Read 128 patterns.");
  assert.equal(bar.textContent, "Read 128 patterns.");
  assert.deepEqual([...bar.classes], ["status"], "the element stopped being a status bar");
});

test("a kind is added alongside, never instead of", () => {
  const bar = target("status");
  applyStatus(bar, "That is a Digitone 1.", "error");
  assert.deepEqual([...bar.classes].sort(), ["error", "status"]);
});

test("kinds replace each other, and info clears them", () => {
  const bar = target("status");
  applyStatus(bar, "careful", "warn");
  applyStatus(bar, "worse", "error");
  assert.deepEqual([...bar.classes].sort(), ["error", "status"], "warn outlived its message");

  applyStatus(bar, "fine now");
  assert.deepEqual([...bar.classes], ["status"], "info left a kind behind");
});

test("unrelated classes the page put there are left alone", () => {
  // The bug was collateral: nothing about a message implies anything about how the element is
  // laid out, so a status write must not be able to decide that.
  const bar = target("status", "pinned", "wide");
  applyStatus(bar, "hello", "ok");
  assert.deepEqual([...bar.classes].sort(), ["ok", "pinned", "status", "wide"]);
});
