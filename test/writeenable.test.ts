/**
 * The switch that stands between a person and their instrument.
 *
 * Two halves are checked here and they are not the same claim. The **state machine** is the gate
 * every write passes through, and it runs under Node. The **wiring** is whether every path that
 * writes actually calls it, and whether every control that writes is marked — both of which are
 * facts about the source, so both are read out of it.
 *
 * What is not here is the DOM behaviour: the swallowed click, the refusal shake, the switch
 * rendering into the tool row. Those were verified in a browser against a real page. Adding a DOM
 * shim to assert them would test the shim.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  WriteDisabled, isWriteEnabled, requireWriteEnabled, setWriteEnabled,
} from "../web/src/writeenable.js";
import { probeFunctionNames, probeWrite } from "./probesource.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "web");
const CORE = join(HERE, "..", "src");

/* ---- the gate ---------------------------------------------------------------------------- */

test("writing is off until somebody says otherwise", () => {
  /*
   * **The default is the whole feature.** A switch that starts armed is a switch that has never
   * stopped anything, and every other assertion here would still pass with it on.
   */
  assert.equal(isWriteEnabled(), false);
  assert.throws(() => requireWriteEnabled(), WriteDisabled);
});

test("arming lets a write through, and disarming stops it again", () => {
  setWriteEnabled(true);
  assert.equal(isWriteEnabled(), true);
  assert.doesNotThrow(() => requireWriteEnabled());

  setWriteEnabled(false);
  assert.equal(isWriteEnabled(), false);
  assert.throws(() => requireWriteEnabled(), WriteDisabled);
});

test("the refusal says nothing was sent, because that is the question being asked", () => {
  // A person who pressed a write button and saw an error wants to know whether it half-happened.
  // "Nothing was sent" is the sentence that answers it, so it is asserted rather than left to
  // whoever next edits the message.
  const error = new WriteDisabled();
  assert.match(error.message, /Nothing was sent/);
  assert.match(error.message, /WRITE/, "it must name the control that fixes it");
});

/* ---- the wiring -------------------------------------------------------------------------- */

test("every path that writes to an instrument passes the gate", () => {
  /*
   * **This is the assertion that makes the feature true rather than decorative.** A disabled button
   * stops a click; it does not stop a code path. If a module reaches `safeWriteRecords` or
   * `safeWriteFile` without calling `requireWriteEnabled`, that path writes to somebody's
   * instrument with the switch off, and nothing on screen would ever say so.
   *
   * The same shape as `safewrite.test.ts`, which scans for modules importing a write primitive
   * without going through `safewrite.ts`. That test guards correctness; this one guards consent.
   */
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) files.push(path);
    }
  };
  walk(join(WEB, "src"));
  assert.ok(files.length > 30, `only ${files.length} web modules found; the scan is misdirected`);

  const writers = files.filter((f) => /\bsafeWrite(Records|File)\s*\(/.test(readFileSync(f, "utf8")));
  assert.ok(writers.length >= 3,
    `only ${writers.length} modules call a safe-write function; the pattern stopped matching`);

  const ungated = writers.filter((f) => !/\brequireWriteEnabled\s*\(/.test(readFileSync(f, "utf8")));
  assert.deepEqual(ungated.map((f) => f.replace(WEB, "web")), [],
    "these send bytes to an instrument without checking whether writing is switched on");
});

test("a core module that writes takes the switch from its host and calls it", () => {
  /*
   * **The same claim as the test above, for the half that moved.** The workflows are being lifted
   * into `src/` so an Android app can share them, and `requireWriteEnabled` cannot go with them:
   * it is this page's switch, and core has no idea whether a host even has one.
   *
   * So a core module that reaches a write primitive must take a `gate` and call it before the
   * write, and its host must pass a real switch in. Without both halves checked, moving a write
   * into core would quietly leave it ungated while the web scan above still passed, which is the
   * vacuous green this file exists to prevent.
   */
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) files.push(path);
    }
  };
  walk(CORE);

  // `safewrite.ts` is the primitive itself, not a caller of it.
  const writers = files
    .filter((f) => !f.endsWith(join("device", "safewrite.ts")))
    .filter((f) => /\bsafeWrite(Records|File)\s*\(/.test(readFileSync(f, "utf8")));
  assert.ok(writers.length >= 1,
    "no core module calls a safe-write function; either the pattern stopped matching or the " +
      "workflows have not moved yet, and this test must be revisited either way");

  for (const file of writers) {
    const source = readFileSync(file, "utf8");
    const name = file.replace(CORE, "src");
    assert.match(source, /gate:\s*\(\)\s*=>\s*void/,
      `${name} writes without taking a gate from its host`);
    const gate = source.search(/\bhost\.gate\(\)/);
    const send = source.search(/\bsafeWrite(Records|File)\s*\(/);
    assert.ok(gate > 0, `${name} takes a gate and never calls it`);
    assert.ok(gate < send, `${name} calls the gate after the write, which is not a gate`);
  }

  /*
   * And the page must hand over the real switch. A host passing `() => {}` would satisfy the type
   * and defeat the point, so the wrapper is read for the name itself.
   */
  const wrapper = readFileSync(join(WEB, "src", "driveproject.ts"), "utf8");
  assert.match(wrapper, /gate:\s*requireWriteEnabled/,
    "the page must pass its own write switch into the core workflow, not a stand-in");
});

test("every function in the probe that sends a write passes the gate itself", () => {
  /*
   * **Per function, because the file-level check above cannot see inside the probe.** The probe
   * has three writes: the +Drive write through `safeWriteFile`, and `writeBack` and
   * `writeToChosenSlot`, which build a dump and hand it straight to `output.send`. The scan above
   * found the one gate call in the file and passed, while the other two were stopped only by their
   * greyed buttons.
   *
   * A function writes if it calls a safe-write function or sends anything other than a request.
   * The requests are the reads: `dumpRequest(...)`, and the `bytes` forwarders handed to readers.
   */
  // Every send spreads one expression into an array. A send of any other shape counts as a write,
  // so a new way of sending cannot slip past by not looking like the old ones. An empty
  // `output.send()` is prose in a comment.
  const sent = (body: string): string[] =>
    [...body.matchAll(/\boutput\.send\((?!\))(\[\.\.\.([^\]]*)\]\))?/g)].map((m) => m[2] ?? "?");
  const sendsWrite = (body: string): boolean =>
    /\bsafeWrite(Records|File)\s*\(/.test(body) ||
    sent(body).some((what) => what !== "bytes" && !/Request\(/.test(what));

  const writers = probeFunctionNames().filter((name) => sendsWrite(probeWrite(name, 20_000)));
  assert.deepEqual(writers.sort(), ["readThenWrite", "writeBack", "writeToChosenSlot"],
    "the set of probe functions that write has changed; check the new one is gated and update this list");

  for (const name of writers) {
    const body = probeWrite(name, 20_000);
    // A statement on its own line, so a comment naming the gate does not count as calling it.
    const gate = /^\s*requireWriteEnabled\(\);/m.exec(body)?.index ?? -1;
    assert.ok(gate > 0, `${name} sends a write without calling requireWriteEnabled()`);
    const send = body.search(/\bsafeWrite(Records|File)\s*\(|\boutput\.send\(\[\.\.\.message\]\)/);
    assert.ok(send > 0 && gate < send, `${name} checks the switch only after it has started writing`);
  }
});

test("every control that writes is marked, and every dangerous one has been considered", () => {
  /*
   * The markup is the register: `gateWriteControls` finds `[data-writes-device]` rather than
   * carrying a list, so adding a control cannot forget to register it.
   *
   * The second half is what makes that safe. A new `btn danger` is the shape of a control that
   * writes, so each one must either carry the attribute or appear below with a reason. **Adding a
   * dangerous button therefore forces the question**, rather than relying on whoever adds it to
   * remember this file exists.
   */
  const DOES_NOT_WRITE: Record<string, string> = {
    opClear: "clears a pattern in the in-memory session; the device is untouched until a write",
    fileRead: "reads a +Drive file. Dangerous because it froze a Digitone 1 three times, not " +
      "because it changes anything",
  };

  const marked: string[] = [];
  const unconsidered: string[] = [];

  for (const page of readdirSync(WEB).filter((f) => f.endsWith(".html"))) {
    const html = readFileSync(join(WEB, page), "utf8");
    for (const match of html.matchAll(/<button[^>]*\bclass="[^"]*\bdanger\b[^"]*"[^>]*>/g)) {
      const tag = match[0];
      const id = /\bid="([^"]+)"/.exec(tag)?.[1] ?? "(no id)";
      if (tag.includes("data-writes-device")) marked.push(id);
      else if (!(id in DOES_NOT_WRITE)) unconsidered.push(`${page}: ${id}`);
    }
  }

  assert.deepEqual(unconsidered, [],
    "a dangerous button must either carry data-writes-device or be listed in DOES_NOT_WRITE with " +
      "a reason it cannot reach the instrument");
  assert.deepEqual(marked.sort(),
    ["dodrivesave", "fileWrite", "libraryRename", "writeBack", "writeDevice", "writeSlot", "writedevice"],
    "the set of controls that write has changed; check the new one is gated and update this list");
});

test("the whole page is edged in red while writing is armed", () => {
  /*
   * **Asked for directly**, and it is the half that survives inattention: the switch is one control
   * in a row of five, and the state it holds persists across all four pages for a whole browsing
   * session. A person who armed writing half an hour ago needs to be told without looking for it.
   *
   * Verified in a browser against a real page. Asserted here so it cannot be lost quietly, since
   * nothing else fails when a stylesheet rule goes missing.
   */
  const css = readFileSync(join(WEB, "toolnav.css"), "utf8");
  const source = readFileSync(join(WEB, "src", "writeenable.ts"), "utf8");

  assert.match(source, /classList\.toggle\("write-armed", on\)/,
    "the root element carries the armed state, so one rule can frame every page");
  assert.match(css, /html\.write-armed::after/, "the ring is drawn on the root, not on a page");

  const rule = /html\.write-armed::after\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /position:\s*fixed/, "it frames the viewport rather than the document");
  assert.match(rule, /pointer-events:\s*none/, "a ring that eats clicks at the window edge is a bug");
  assert.match(rule, /inset:\s*0/, "fixed with inset 0 keeps it out of the layout, so nothing shifts");
});

test("the refusal does not become a second thing deciding motion", () => {
  /*
   * `arrival.js` weighs the stored preference against the system's and decides once whether this
   * application animates, and it stamps nothing a stylesheet can read. A
   * `@media (prefers-reduced-motion)` block for the refusal would be a second decider — the fault
   * `web.test.ts` already guards for this stylesheet, which this feature tripped on its first pass.
   *
   * So the refusal is an outline rather than a shake, and needs no decision at all.
   */
  const css = readFileSync(join(WEB, "toolnav.css"), "utf8");
  const rule = /\.write-refused\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(rule, "the refusal must still be visible");
  assert.doesNotMatch(rule, /animation|transform/,
    "an animated refusal needs a motion decision, and arrival.js already made the only one");
});
