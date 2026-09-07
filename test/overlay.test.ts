/**
 * An overlay has to say when it closed.
 *
 * ## The failure this exists to stop
 *
 * Both callers of `openOverlay` keep the overlay in a module-level variable and refuse to open a
 * second one:
 *
 * ```
 * let overlay: Overlay | undefined;
 * export function openHelp(...) { if (overlay) return; overlay = openOverlay({ … }); }
 * ```
 *
 * Escape and a click outside close the overlay from inside `overlay.ts`, which never touched that
 * variable. So after the first Escape it held a closed overlay, the guard saw a truthy value, and
 * **the help view never opened again for the rest of the page's life.** Nothing threw, nothing
 * logged, and the button looked ordinary. It was found by pressing Escape and then pressing help.
 *
 * The settings sheet had the identical shape and the identical bug.
 *
 * Closing is the overlay's own event, so `onClose` is the overlay's job to fire. Both halves are
 * checked below: that it fires on every route out, and that every call site asks for it.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ---- a DOM small enough to hold in your head ------------------------------------------------ */

interface Listener { (event: { key?: string }): void }

class FakeElement {
  className = "";
  readonly children: FakeElement[] = [];
  parent: FakeElement | undefined;
  focused = 0;
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();

  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  append(...nodes: FakeElement[]): void {
    for (const node of nodes) { node.parent = this; this.children.push(node); }
  }
  remove(): void {
    const at = this.parent?.children.indexOf(this) ?? -1;
    if (at >= 0) this.parent!.children.splice(at, 1);
    this.parent = undefined;
  }
  focus(): void { this.focused++; }
  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  }
  fire(type: string, event: { key?: string } = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
}

/** Installs a document for one test and hands back the teardown. */
function withDocument(): { body: FakeElement; doc: FakeElement; restore: () => void } {
  const body = new FakeElement();
  const doc = new FakeElement();
  const document = {
    body,
    createElement: () => new FakeElement(),
    addEventListener: (type: string, fn: Listener) => doc.addEventListener(type, fn),
    removeEventListener: (type: string, fn: Listener) => doc.removeEventListener(type, fn),
  };
  const global = globalThis as unknown as { document?: unknown };
  const had = "document" in global;
  const before = global.document;
  global.document = document;
  return {
    body,
    doc,
    restore: () => { if (had) global.document = before; else delete global.document; },
  };
}

async function overlayModule(): Promise<typeof import("../web/src/overlay.js")> {
  return await import("../web/src/overlay.js");
}

test("closing by Escape tells the caller, so it can open again", async () => {
  const dom = withDocument();
  try {
    const { openOverlay } = await overlayModule();
    let closed = 0;
    const overlay = openOverlay({
      className: "help-panel", label: "Help", onClose: () => { closed++; },
    });
    assert.equal(dom.body.children.length, 2, "a scrim and a panel");

    dom.doc.fire("keydown", { key: "Escape" });
    assert.equal(closed, 1, "onClose did not fire for Escape");
    assert.equal(overlay.open, false);
    assert.equal(dom.body.children.length, 0, "the overlay left its nodes behind");
  } finally {
    dom.restore();
  }
});

test("closing by a click outside tells the caller too", async () => {
  const dom = withDocument();
  try {
    const { openOverlay } = await overlayModule();
    let closed = 0;
    openOverlay({ className: "sheet", label: "Settings", onClose: () => { closed++; } });
    const scrim = dom.body.children[0]!;
    scrim.fire("click");
    assert.equal(closed, 1, "onClose did not fire for a click on the scrim");
  } finally {
    dom.restore();
  }
});

test("a blocked overlay stays open and stays silent", async () => {
  const dom = withDocument();
  try {
    const { openOverlay } = await overlayModule();
    let closed = 0;
    let blocked = true;
    const overlay = openOverlay({
      className: "help-panel", label: "Help",
      isBlocked: () => blocked,
      onClose: () => { closed++; },
    });

    dom.doc.fire("keydown", { key: "Escape" });
    assert.equal(closed, 0, "a blocked overlay reported a close that did not happen");
    assert.equal(overlay.open, true);

    blocked = false;
    dom.doc.fire("keydown", { key: "Escape" });
    assert.equal(closed, 1);
  } finally {
    dom.restore();
  }
});

test("onClose fires once, however many times close is called", async () => {
  const dom = withDocument();
  try {
    const { openOverlay } = await overlayModule();
    let closed = 0;
    const overlay = openOverlay({
      className: "sheet", label: "Settings", onClose: () => { closed++; },
    });
    overlay.close();
    overlay.close();
    dom.doc.fire("keydown", { key: "Escape" });
    assert.equal(closed, 1);
  } finally {
    dom.restore();
  }
});

/* ---- and every caller has to ask for it ----------------------------------------------------- */

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(path, out);
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

test("every openOverlay call asks to be told when it closes", () => {
  /*
   * A caller that drops the returned overlay on the floor would not need this. Neither does today,
   * and a new one that does can say so here rather than rediscovering the bug in a browser.
   */
  const sites: { where: string; hasOnClose: boolean }[] = [];

  for (const file of tsFiles(join(ROOT, "web", "src"))) {
    const source = ts.createSourceFile(
      file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "openOverlay"
      ) {
        const [argument] = node.arguments;
        const hasOnClose = argument !== undefined
          && ts.isObjectLiteralExpression(argument)
          && argument.properties.some((p) => p.name !== undefined && p.name.getText(source) === "onClose");
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        sites.push({ where: `${relative(ROOT, file)}:${line + 1}`, hasOnClose });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  assert.ok(sites.length >= 2, `expected the help view and the settings sheet, found ${sites.length}`);
  assert.deepEqual(
    sites.filter((s) => !s.hasOnClose).map((s) => s.where), [],
    "an overlay that closes itself must tell its caller",
  );
});
