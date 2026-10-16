/**
 * The page holds while a write runs, and lets go when the last one settles.
 *
 * The counter is checked under Node with a stand-in `window`, set before the module loads because
 * the module reads it once. The wiring is a fact about the source: every page module that hands
 * the write switch to a write also runs that write inside `whileWriting`.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "web", "src");

/** Modules that pass the switch on to their callers, who run the write. */
const CALLER_WRAPS = new Map([
  ["writeenable.ts", "defines the switch"],
  ["devicesource.ts", "writeBack is run by the manager and the expander"],
  ["driveproject.ts", "writeProjectToDrive is run by the manager"],
  ["library/renamepreset.ts", "renamePresetOnDrive is run by the library page"],
]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

test("a write holds the page until it settles, and two writes hold it until both do", async () => {
  const target = new EventTarget();
  const added: string[] = [];
  const removed: string[] = [];
  (globalThis as { window?: unknown }).window = {
    addEventListener: (type: string, fn: EventListener) => {
      added.push(type);
      target.addEventListener(type, fn);
    },
    removeEventListener: (type: string, fn: EventListener) => {
      removed.push(type);
      target.removeEventListener(type, fn);
    },
  };
  try {
    const { isWriting, whileWriting } = await import("../web/src/writing.js");
    let finishFirst!: () => void;
    let failSecond!: (error: Error) => void;
    const first = whileWriting(() => new Promise<void>((resolve) => (finishFirst = resolve)));
    const second = whileWriting(() => new Promise<void>((_, reject) => (failSecond = reject)));
    assert.equal(isWriting(), true);
    assert.deepEqual(added, ["beforeunload"]);

    const event = new Event("beforeunload", { cancelable: true });
    target.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);

    finishFirst();
    await first;
    assert.equal(isWriting(), true, "one write still runs");
    assert.deepEqual(removed, []);

    failSecond(new Error("port gone"));
    await assert.rejects(second, /port gone/);
    assert.equal(isWriting(), false);
    assert.deepEqual(removed, ["beforeunload"]);

    const after = new Event("beforeunload", { cancelable: true });
    target.dispatchEvent(after);
    assert.equal(after.defaultPrevented, false);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test("every module that hands over the write switch runs its write inside whileWriting", () => {
  const missing = sources(SRC)
    .map((path) => [relative(SRC, path).replaceAll("\\", "/"), readFileSync(path, "utf8")] as const)
    .filter(([name, text]) => text.includes("requireWriteEnabled") && !CALLER_WRAPS.has(name))
    .filter(([, text]) => !text.includes("whileWriting("))
    .map(([name]) => name);
  assert.deepEqual(missing, []);
});
