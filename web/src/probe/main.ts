/**
 * The device probe: the smallest thing that needs hardware.
 *
 * Ask a connected Elektron what it is, what firmware it runs, which messages it supports, and
 * what is on its +Drive. Nothing is written, nothing is changed, and no project is touched.
 *
 * It exists because everything else in DNX was built against a corpus of 24 real project files,
 * and **the transport is the one part that cannot be.** So this is deliberately the least code
 * that gets a real answer out of a real device.
 *
 * ## It has already earned itself, on its first run
 *
 * Three questions went in. Two came back as expected: the firmware **build string** the
 * storage-version question had waited on since `dn2-format.md` §8a, and a **product id of 43**,
 * matching what `src/sysex/devices.ts` had recorded.
 *
 * The third came back **the opposite of what we had assumed.** ROADMAP §3d's plan rested on
 * reading whole projects off the +Drive over SysEx, which elk-herd does on a Digitakt II — and a
 * Digitone II advertises **none** of the nine file-API codes. `DirList` timed out because the
 * device does not implement it. Had the transfer layer been built first, that is where it would
 * have surfaced.
 *
 * So the probe now **reads the capability list before sending anything**, and refuses `DirList`
 * on a device that does not claim it rather than waiting two seconds for a reply that is never
 * coming. A timeout reads like our bug; a refusal reads like the device's answer, which is what
 * it is.
 *
 * Kept off the manager on purpose. This is a diagnostic, and the manager should not grow a MIDI
 * dependency until there is something for it to do over MIDI.
 */

import {
  type DirEntry,
  Code,
  deviceRequest,
  dirListRequest,
  readDeviceResponse,
  readDirListResponse,
  readQueryResponse,
  readVersionResponse,
  describeQueryValue,
  queryRequest,
  versionRequest,
} from "../../../src/device/api.js";
import { DeviceSession } from "../../../src/device/session.js";
import { DumpCapture, captureFileName } from "../../../src/device/capture.js";
import { REQUEST_OPTIONS, dumpProductFor, dumpRequest } from "../../../src/device/dumprequest.js";
import { DumpReader, type ReadReport, stepsToRetry } from "../../../src/device/dumpreader.js";
import { planBytes, planProjectRead } from "../../../src/device/readplan.js";
import { looksBlank, nullRoundTrip, verifyWrite, writeToSlot } from "../../../src/device/dumpwrite.js";
import { parseMessage, rebuildMessage, splitMessages } from "../../../src/sysex/container.js";
import { patternIndex, patternName } from "../../../src/sheet/naming.js";
import { ProductId } from "../../../src/sysex/devices.js";
import { DN1_DEVICE, DN2_DEVICE } from "../../../src/librarian/device.js";
import { blankPatternKit } from "../../../src/librarian/blank.js";
import {
  QUERY_KEYS,
  capabilitiesOf,
  describeMessages,
  hex,
} from "../../../src/device/capabilities.js";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

type Kind = "info" | "ok" | "warn" | "error";

function status(message: string, kind: Kind = "info"): void {
  const bar = $("status");
  bar.textContent = message;
  bar.className = `status ${kind}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

let access: MIDIAccess | undefined;

/**
 * The **dump-protocol** product id for the device last probed.
 *
 * Converted from the API id the `Device` response gives, because they are different numbering
 * spaces: the API says 20 and 43, the dump framing wants 0x0D and 0x15. The first request went
 * out addressed to 43 and was rightly ignored.
 */
let lastProductId: number | undefined;

/**
 * What the user last chose, so a re-render does not undo it.
 *
 * Sending to a port opens it, and opening it fires `statechange`, which re-renders the lists.
 * Without this the auto-guess ran again on every probe and snapped the selects back to whichever
 * device it liked best — reported by the user while probing a Digitone and a Digitone II side by
 * side, which is exactly when it is most annoying and least obvious.
 */
const chosen: { input?: string; output?: string } = {};

/**
 * Ports are listed in pairs, and the pairing is a guess **only until the user disagrees**.
 *
 * A device is an input and an output that happen to have similar names, and nothing in WebMIDI
 * says which belong together — an interface with four ports gives no hint at all. So the guess is
 * by name, and a choice, once made, outranks it for as long as that port exists.
 */
function renderPorts(): void {
  if (!access) return;

  const inputs = [...access.inputs.values()];
  const outputs = [...access.outputs.values()];
  const inSelect = $<HTMLSelectElement>("input");
  const outSelect = $<HTMLSelectElement>("output");

  const options = (ports: (MIDIInput | MIDIOutput)[]): string =>
    ports
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name ?? p.id)}</option>`)
      .join("");

  inSelect.innerHTML = options(inputs);
  outSelect.innerHTML = options(outputs);

  // Pair by the longest shared prefix, which handles "Digitone II" / "Digitone II MIDI 1" and
  // costs nothing when it is wrong, because both selects remain the user's to change.
  const best = outputs
    .map((out) => ({
      out,
      match: inputs
        .map((inp) => ({ inp, score: sharedPrefix(inp.name ?? "", out.name ?? "") }))
        .sort((a, b) => b.score - a.score)[0],
    }))
    .filter((c) => c.match && c.match.score > 0)
    .sort((a, b) => b.match!.score - a.match!.score)[0];

  if (best?.match) {
    outSelect.value = best.out.id;
    inSelect.value = best.match.inp.id;
  }

  // The user's choice wins, if the port is still there. Checked against the live port maps
  // rather than against the select's own value, because a stale id would silently leave the
  // control showing something that is no longer plugged in.
  if (chosen.output !== undefined && access.outputs.has(chosen.output)) {
    outSelect.value = chosen.output;
  }
  if (chosen.input !== undefined && access.inputs.has(chosen.input)) {
    inSelect.value = chosen.input;
  }

  $<HTMLButtonElement>("probe").disabled = inputs.length === 0 || outputs.length === 0;
  $<HTMLButtonElement>("listen").disabled = inputs.length === 0;
  status(
    inputs.length === 0 || outputs.length === 0
      ? "No MIDI ports. Connect the device and press Rescan."
      : `${inputs.length} input(s), ${outputs.length} output(s). Pick the pair and probe.`,
    inputs.length === 0 ? "warn" : "info",
  );
}

/**
 * Whether this is a Chromium browser.
 *
 * Crude on purpose, and only used to add a hint to a failure that has already happened. Firefox
 * implements Web MIDI but gates SysEx behind a separate site-permission add-on and drops it
 * **silently** when that is missing — ports open, `send()` does not throw, nothing comes back.
 * Indistinguishable from a dead device, and it cost an hour before Chrome was tried with nothing
 * else changed.
 */
function isChromium(): boolean {
  const brands = (navigator as { userAgentData?: { brands?: { brand: string }[] } }).userAgentData
    ?.brands;
  if (brands) return brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand));
  return /Chrome\/|Edg\//.test(navigator.userAgent);
}

function sharedPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** Run the probe against one input/output pair. */
async function probe(): Promise<void> {
  if (!access) return;
  const input = access.inputs.get($<HTMLSelectElement>("input").value);
  const output = access.outputs.get($<HTMLSelectElement>("output").value);
  if (!input || !output) {
    status("Those ports are no longer there. Press Rescan.", "error");
    return;
  }

  const results = $("results");
  results.innerHTML = "";
  status(`Opening ${output.name}…`);

  // **Open both ports explicitly.**
  //
  // `addEventListener("midimessage", …)` does *not* open an input. Only assigning
  // `onmidimessage` opens one implicitly, and the spec is explicit about that asymmetry. Without
  // this, a closed port silently delivers nothing and every request times out — indistinguishable
  // from a device that is not listening, which is exactly how it was misread the first time.
  //
  // It worked at all only because the ports happened to already be open; anything that takes them
  // and gives them back — Elektron Transfer, Overbridge, a DAW — leaves them closed.
  //
  // Bounded, because `open()` is a promise that can simply never settle — a port another
  // application is holding does not reject, it waits. Without the race the page sits on
  // "Opening…" indefinitely with no way to tell that from a slow device.
  try {
    await Promise.race([
      Promise.all([input.open(), output.open()]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`opening the port took longer than ${OPEN_TIMEOUT_MS}ms`)), OPEN_TIMEOUT_MS),
      ),
    ]);
  } catch (error) {
    status(`Could not open the port: ${error}. Something else may be holding it.`, "error");
    card(results, "Could not open the port", [
      ["Error", String(error)],
      ["Input", `${input.name} — ${input.connection}`],
      ["Output", `${output.name} — ${output.connection}`],
      ["Usually", "another application has the port: Elektron Transfer, Overbridge, or a DAW"],
    ]);
    return;
  }

  const session = new DeviceSession({ send: (bytes) => output.send([...bytes]) });

  // Counted so a failure can say *which* silence this is: nothing arriving at all, or traffic
  // arriving that is not ours. Those have completely different causes and the same symptom.
  let received = 0;
  const onMessage = (event: MIDIMessageEvent): void => {
    if (!event.data) return;
    received++;
    session.receive(new Uint8Array(event.data));
  };
  input.addEventListener("midimessage", onMessage);

  try {
    // Narrated step by step. A single "Probing…" that sits there for half a minute tells the
    // user nothing about whether it is working, stuck, or nearly done — and it is the *first*
    // request that fails when a port is closed, which a static message actively hides.
    status(`Asking ${output.name} what it is…`);
    const device = readDeviceResponse((await session.request(Code.Device, deviceRequest)).body);

    status(`${device.deviceName} answered. Asking for its firmware…`, "ok");
    const version = readVersionResponse((await session.request(Code.Version, versionRequest)).body);

    // Converted, not copied: the Device response is in the API's product space and a dump request
    // needs the dump protocol's. Sending the API id produces a well-formed message addressed to a
    // product that does not exist there, which a device answers by ignoring it.
    lastProductId = dumpProductFor(device.productId);
    $<HTMLSelectElement>("reqWhat").disabled = false;
    $<HTMLInputElement>("reqObj").disabled = false;
    $<HTMLButtonElement>("request").disabled = false;
    $<HTMLButtonElement>("readProject").disabled = lastProductId === undefined;
    // Stays disabled until there is something to write *back*, which can only come from reading.
    $<HTMLButtonElement>("writeBack").disabled = lastProductId === undefined || capture.isEmpty;

    const caps = capabilitiesOf(device.supportedMessages);

    card(results, "Device", [
      ["Name", device.deviceName],
      ["Product id (API space)", String(device.productId)],
      ["Firmware", `${version.version}  (build ${version.build})`],
      ["Reads +Drive files", caps.driveFiles ? "yes" : "no"],
      ["Manages +Drive", caps.driveManagement ? "yes" : "no"],
    ]);

    // Named, not hex. A list of 22 raw codes is a transcription job; what a reader wants is
    // which of them mean something and which do not.
    messageCard(results, device.supportedMessages);

    // Do not send a message the device says it does not implement. The first probe did, and
    // spent two seconds timing out on a `DirList` that was never coming — which reads like a
    // fault in us rather than a correct answer from the device.
    if (caps.driveFiles) {
      const root = readDirListResponse(
        (await session.request(Code.DirList, (id) => dirListRequest(id, "/"))).body,
      );
      listing(results, "/", root);
      status(`${device.deviceName}, firmware ${version.version}, ${root.length} entries at /.`, "ok");
    } else {
      card(results, "No +Drive file API on this device", [
        ["Missing", caps.missingForDriveFiles.map(hex).join(" ")],
        ["Means", "whole projects cannot be read off the +Drive by path"],
        ["Instead", `${caps.dumps.length} dump type(s) are advertised — data moves as dumps`],
      ]);
      status(
        `${device.deviceName} ${version.version}: no +Drive file API. Not a failure — the device ` +
          `says it does not implement it, so nothing was sent.`,
        "warn",
      );
    }

    // Query last, because it is the slow part: one round trip per key, and most keys are guesses
    // that will come back empty. Everything above is already on screen by the time it starts.
    if (device.supportedMessages.includes(Code.Query)) {
      await runQueries(results, session);
    }
  } catch (error) {
    status(String(error), "error");
    // The counter is the whole diagnosis. Nothing arriving and the wrong thing arriving look
    // identical from the outside — one is a dead port, the other is a live port carrying someone
    // else's traffic — and guessing between them cost a session.
    card(results, "Probe failed", [
      ["Error", String(error)],
      ["MIDI messages received", String(received)],
      [
        "Which means",
        received === 0
          ? "nothing arrived at all — wrong input port, a port something else is holding, or an interface that drops SysEx"
          : "the port is live and carrying traffic, but none of it was an Elektron API reply — most likely the wrong pair, with this input belonging to another device",
      ],
      ["Ports", `${input.name} / ${output.name}, connection ${input.connection}`],
      ...(received === 0 && !isChromium()
        ? ([
            [
              "Browser",
              "not Chromium — Firefox implements Web MIDI but gates SysEx behind a separate " +
                "site-permission add-on, and filters it silently when that is missing. Confirmed: " +
                "a probe that failed here succeeded in Chrome with nothing else changed. Try " +
                "Chrome or Edge before looking further.",
            ],
          ] as [string, string][])
        : []),
    ]);
  } finally {
    input.removeEventListener("midimessage", onMessage);
    session.close();
    if (session.unmatched.length > 0) {
      card(results, "Unmatched replies", [
        ["Count", String(session.unmatched.length)],
        ["Meaning", "a timeout fired early, or something else is sharing this port"],
      ]);
    }
  }
}

function card(into: HTMLElement, title: string, rows: [string, string][]): void {
  const section = document.createElement("section");
  section.className = "card";
  section.innerHTML =
    `<h2>${escapeHtml(title)}</h2>` +
    rows
      .map(
        ([k, v]) =>
          `<div class="row"><span class="k">${escapeHtml(k)}</span>` +
          `<span class="v">${escapeHtml(v) || "&mdash;"}</span></div>`,
      )
      .join("");
  into.append(section);
}

/**
 * Ask the device about itself, one key at a time.
 *
 * Every key is sent individually and its own failure is caught, because the interesting outcome
 * is a *mixture*: most guesses come back empty and one or two do not. Aborting the run on the
 * first timeout would throw away the answers that came after it.
 *
 * Keys that answer `none` are still shown. "This key does not exist" is a real result when the
 * point of the exercise is mapping a namespace nobody has documented.
 */
async function runQueries(into: HTMLElement, session: DeviceSession): Promise<void> {
  const rows: [string, string][] = [];
  let consecutiveSilences = 0;

  for (const key of QUERY_KEYS) {
    // Insurance, not a fix for an observed problem — and worth saying so, because the comment
    // here first claimed otherwise. A slow sweep looked like the device ignoring unknown keys; it
    // was actually a browser silently dropping SysEx. On a working connection a Digitone II
    // answers **every** key at once, `none` included, exactly as assumed. This stays because a
    // device that does go quiet should not cost half a minute to find out about.
    if (consecutiveSilences >= GIVE_UP_AFTER) {
      rows.push([key, "not asked"]);
      continue;
    }

    status(`Query ${rows.length + 1} of ${QUERY_KEYS.length}: ${key}`);
    try {
      const frame = await session.request(
        Code.Query,
        (id) => queryRequest(id, key),
        QUERY_TIMEOUT_MS,
      );
      rows.push([key, describeQueryValue(readQueryResponse(frame.body))]);
      consecutiveSilences = 0;
    } catch {
      rows.push([key, "no reply"]);
      consecutiveSilences++;
    }
  }

  const answered = rows.filter(([, v]) => v !== "no reply" && v !== "not asked").length;
  const stopped = rows.some(([, v]) => v === "not asked");
  card(
    into,
    `Query — ${answered} of ${QUERY_KEYS.length} key(s) answered` +
      (stopped ? `, stopped after ${GIVE_UP_AFTER} silent in a row` : ""),
    rows,
  );
}

/**
 * Shorter than the default. A device that is going to answer a query answers at once; the two
 * seconds a transfer needs are wrong for twelve small round trips in a row.
 */
const QUERY_TIMEOUT_MS = 400;

/** Long enough for a real port, short enough that a held one is obvious rather than a hang. */
const OPEN_TIMEOUT_MS = 3000;

/** Three silences means the device does not answer unknown keys, not that these three were bad. */
const GIVE_UP_AFTER = 3;

/**
 * Every advertised message, named.
 *
 * The unknown ones are shown rather than filtered out. A Digitone II advertises `0x03`, `0x04`,
 * `0x06` and `0x07`, which appear in no source we have — and a list that quietly dropped them
 * would hide the most interesting thing on the page.
 */
function messageCard(into: HTMLElement, codes: readonly number[]): void {
  const rows = describeMessages(codes)
    .map(
      (m) =>
        `<tr><td class="mono">${hex(m.code)}</td>` +
        `<td class="mono">${m.kind}</td>` +
        `<td>${m.known ? escapeHtml(m.name) : `<em>unknown</em>`}</td>` +
        `<td class="mono ${m.safety}">${m.safety}</td></tr>`,
    )
    .join("\n  ");

  const section = document.createElement("section");
  section.className = "card";
  section.innerHTML =
    `<h2>Supported messages (${codes.length})</h2>` +
    `<p class="hint">The probe only ever sends <span class="mono read">read</span>. A
     <span class="mono write">write</span> changes the instrument; an
     <span class="mono unknown">unknown</span> has never been shown not to, and those are
     different things worth keeping apart.</p>` +
    `<table><thead><tr><th>Code</th><th>Kind</th><th>Message</th><th>Sending it</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`;
  into.append(section);
}

function listing(into: HTMLElement, path: string, entries: DirEntry[]): void {
  const section = document.createElement("section");
  section.className = "card";
  section.innerHTML =
    `<h2>+Drive ${escapeHtml(path)}</h2>` +
    (entries.length === 0
      ? `<p class="hint">Empty.</p>`
      : `<table><thead><tr><th>Name</th><th>Type</th><th class="num">Size</th><th>Locked</th></tr></thead><tbody>` +
        entries
          .map(
            (e) =>
              `<tr><td class="mono">${escapeHtml(e.name)}</td>` +
              `<td class="mono">${escapeHtml(e.type)}</td>` +
              `<td class="mono num">${e.size.toLocaleString()}</td>` +
              `<td>${e.locked ? "yes" : ""}</td></tr>`,
          )
          .join("") +
        `</tbody></table>`);
  into.append(section);
}

async function connect(): Promise<void> {
  if (!navigator.requestMIDIAccess) {
    status("This browser has no WebMIDI. Chrome or Edge; Safari and Firefox do not.", "error");
    return;
  }
  try {
    // `sysex: true` is the whole point and prompts separately from plain MIDI access. Without it
    // every request is silently dropped, which reads as a device that is not answering.
    access = await navigator.requestMIDIAccess({ sysex: true });
    access.addEventListener("statechange", renderPorts);
    renderPorts();
  } catch (error) {
    status(`MIDI access refused: ${error}. SysEx permission is required.`, "error");
  }
}

for (const id of ["input", "output"] as const) {
  $<HTMLSelectElement>(id).addEventListener("change", (event) => {
    chosen[id] = (event.target as HTMLSelectElement).value;
  });
}

$("rescan").addEventListener("click", () => {
  // Rescan is the way back to the guess: forgetting the choice is the point of the button, and
  // without this there would be no way to undo a mis-click short of reloading the page.
  chosen.input = undefined;
  chosen.output = undefined;
  void connect();
});
$("probe").addEventListener("click", () => {
  void probe();
});

void connect();

// --- listening ---------------------------------------------------------------------------------

/**
 * Capture whatever the device chooses to send.
 *
 * **Sends nothing.** The Digitone dumps from its own front panel, so this half of the transport
 * can be proven with the safety question entirely absent — which is why it is built before
 * anything that transmits. The bytes are saved verbatim as a `.syx`, which is the same form as
 * the corpus captures, so every existing tool works on the result the moment it lands.
 */
const capture = new DumpCapture();
let listening: { input: MIDIInput; onMessage: (event: MIDIMessageEvent) => void } | undefined;

function renderCapture(): void {
  const summary = capture.summarise();
  const results = $("results");
  results.innerHTML = "";

  const rows: [string, string][] = [
    ["Bytes", summary.bytes.toLocaleString()],
    ["Messages", String(summary.messages)],
  ];
  if (summary.foreign > 0) rows.push(["Not Elektron", `${summary.foreign} — ignored`]);
  if (summary.unparsed > 0) rows.push(["Unreadable", String(summary.unparsed)]);
  // A transfer stopped mid-message is normal, and saying so beats a summary that quietly
  // describes a truncated capture as a complete one.
  if (summary.trailingBytes > 0) {
    rows.push(["Incomplete tail", `${summary.trailingBytes} bytes — a message was cut short`]);
  }
  card(results, listening ? "Listening…" : "Capture", rows);

  for (const group of summary.groups) {
    const objects =
      group.objects.length === 0
        ? "—"
        : group.objects.length <= 12
          ? group.objects.join(", ")
          : `${group.objects.length} objects, ${group.objects[0]}…${group.objects[group.objects.length - 1]}`;
    card(results, `${group.product} — ${group.name} (${hex(group.dumpType)})`, [
      ["Messages", String(group.count)],
      ["Bytes", group.bytes.toLocaleString()],
      ["Object numbers", objects],
      // Said plainly, because "128 objects" against 182 messages reads as lost data. It is not:
      // the field is one 7-bit byte, and the device reports 0 once it runs out.
      // Observed, then both causes named — because the bytes genuinely cannot tell them apart.
      // This used to assert saturation, and said so on a capture of 129 patternKits where the
      // extra one was our own verification re-read. A confident wrong explanation is worse than
      // an honest ambiguous one.
      ...(group.numbersExhausted
        ? ([[
            "Note",
            `${group.count} messages, ${group.objects.length} distinct numbers. Either the object ` +
              `number saturated — it is a 7-bit field, so a bank of more than 128 reports 0 for ` +
              `the rest and only send order identifies those — or some objects simply arrived ` +
              `twice, which is what a re-read or a verification does. Nothing is lost either way.`,
          ]] as [string, string][])
        : []),
      ["Checksums", group.badChecksum === 0 ? "all good" : `${group.badChecksum} BAD`],
    ]);
  }
}

/** A rolling indicator, so "still going" is visible without reading numbers. */
const SPINNER = ["|", "/", "-", "\\"];

let heartbeat: ReturnType<typeof setInterval> | undefined;

function stopListening(): void {
  if (!listening) return;
  if (heartbeat !== undefined) {
    clearInterval(heartbeat);
    heartbeat = undefined;
  }
  listening.input.removeEventListener("midimessage", listening.onMessage);
  listening = undefined;
  $("listen").textContent = "Listen";
  $<HTMLButtonElement>("probe").disabled = false;
  renderCapture();
  status(
    capture.isEmpty
      ? "Nothing arrived. Trigger the dump from the device: SETTINGS > SYSEX DUMP > SYSEX SEND."
      : `Stopped. ${capture.byteLength.toLocaleString()} bytes captured — press Save capture.`,
    capture.isEmpty ? "warn" : "ok",
  );
}

async function startListening(): Promise<void> {
  if (!access) return;
  const input = access.inputs.get($<HTMLSelectElement>("input").value);
  if (!input) {
    status("That input is no longer there. Press Rescan.", "error");
    return;
  }

  // Explicitly, for the same reason the probe does: `addEventListener` does not open a port, and
  // a closed one delivers nothing while looking exactly like a device that never sent.
  try {
    await input.open();
  } catch (error) {
    status(`Could not open ${input.name}: ${error}`, "error");
    return;
  }

  capture.clear();
  let ticks = 0;
  let lastAt = 0;
  const onMessage = (event: MIDIMessageEvent): void => {
    if (!event.data) return;
    const data = new Uint8Array(event.data);
    capture.add(data);
    lastAt = Date.now();

    // A read drives its own narration and owns the results area while it runs, so re-rendering
    // the capture on every message would tear down the progress it is drawing. The bytes are
    // already in the capture either way, which is the part that must not depend on the UI.
    // The write verification takes precedence: it is waiting for one specific reply and the run
    // is meaningless without it.
    if (awaitingReply) awaitingReply(data);

    if (reading) {
      reading.receive(data);
      return;
    }
    renderCapture();

    // A project dump is minutes of silence punctuated by a message every so often, and a static
    // byte count during that gap is indistinguishable from a stall. The spinner advances on every
    // message and the message count rises, so *something moving* is visible without having to
    // compare two numbers a minute apart.
    status(
      `${SPINNER[ticks++ % SPINNER.length]}  receiving — ` +
        `${capture.byteLength.toLocaleString()} bytes, ${capture.summarise().messages} message(s)`,
    );
  };

  // And a heartbeat between messages, so the gap itself is legible: how long since the last one
  // arrived is exactly the number that tells you whether to keep waiting or to stop.
  heartbeat = setInterval(() => {
    if (!listening || lastAt === 0) return;
    const idle = Math.round((Date.now() - lastAt) / 1000);
    if (idle >= 2) {
      status(
        `${SPINNER[ticks++ % SPINNER.length]}  waiting — ${capture.byteLength.toLocaleString()} ` +
          `bytes so far, nothing for ${idle}s`,
        idle >= 20 ? "warn" : "info",
      );
    }
  }, 1000);

  input.addEventListener("midimessage", onMessage);
  listening = { input, onMessage };
  $("listen").textContent = "Stop";
  $<HTMLButtonElement>("probe").disabled = true;
  $<HTMLButtonElement>("save").disabled = false;
  renderCapture();
  status(`Listening on ${input.name}. Trigger the dump on the device.`);
}

$("listen").addEventListener("click", () => {
  if (listening) stopListening();
  else void startListening();
});

$("save").addEventListener("click", () => {
  if (capture.isEmpty) {
    status("Nothing captured yet.", "warn");
    return;
  }
  const name = captureFileName(capture.summarise());
  // Copied into a fresh buffer: a Uint8Array over a SharedArrayBuffer is not a valid BlobPart,
  // and which kind you have depends on how the runtime allocated it.
  const bytes = capture.bytes();
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
  status(`Saved ${name} — ${capture.byteLength.toLocaleString()} bytes.`, "ok");
});


// --- requesting --------------------------------------------------------------------------------

/**
 * Ask the device to send something.
 *
 * **The only thing on this page that transmits.** It goes out over the *dump* framing rather than
 * the API's, and the reply is an ordinary dump — so it lands in the capture through the same
 * listener the front-panel sends use, and needs no correlation logic of its own.
 *
 * Requires Listen to be running, deliberately: a request whose answer nobody is collecting is a
 * transmission for no reason, and this is the one control where "for no reason" is worth avoiding.
 */
function fillRequestOptions(): void {
  const select = $<HTMLSelectElement>("reqWhat");
  select.innerHTML = REQUEST_OPTIONS.map(
    (o) => `<option value="${o.code}">${escapeHtml(o.label)}</option>`,
  ).join("");
}

function requestOption(): (typeof REQUEST_OPTIONS)[number] {
  const code = Number($<HTMLSelectElement>("reqWhat").value);
  return REQUEST_OPTIONS.find((o) => o.code === code) ?? REQUEST_OPTIONS[0]!;
}

$("request").addEventListener("click", () => {
  if (!access) return;
  const output = access.outputs.get($<HTMLSelectElement>("output").value);
  if (!output) {
    status("That output is no longer there. Press Rescan.", "error");
    return;
  }
  if (!listening) {
    status("Press Listen first — otherwise nothing will be collecting the reply.", "warn");
    return;
  }

  const option = requestOption();
  const objNr = option.indexed ? Number($<HTMLInputElement>("reqObj").value) : 0;
  const product = lastProductId;
  if (product === undefined) {
    status(
      `No dump-protocol product id for this device — probe it first, and if it has been probed, ` +
        `it is a product this build does not know how to address.`,
      "warn",
    );
    return;
  }

  try {
    output.send([...dumpRequest(product, { code: option.code, objNr })]);
    status(
      `Asked for ${option.label.toLowerCase()}${option.indexed ? ` ${objNr}` : ""} — ` +
        `expecting roughly ${option.approximateBytes(product).toLocaleString()} bytes back.`,
    );
  } catch (error) {
    status(`Could not send the request: ${error}`, "error");
  }
});

fillRequestOptions();


// --- reading a whole project -------------------------------------------------------------------

/**
 * Ask the device for every object a project is made of, one at a time.
 *
 * The read half of transfer mode. `readplan.ts` says what to ask for and `dumpreader.ts` paces it;
 * everything here is the page: a confirmation before pulling 14.6 MB, a progress line, a stop
 * button, and a report at the end. The bytes go into the same capture the front-panel listener
 * fills, so **Save capture** writes a `.syx` every existing tool already reads.
 *
 * Requires Listen, like Request does — the listener is what feeds both the capture and the reader,
 * and a read with nothing collecting is a transfer for no reason.
 */
let reading: DumpReader | undefined;

$("readProject").addEventListener("click", () => {
  if (reading) {
    reading.stop();
    status("Stopping after the object in flight…", "warn");
    return;
  }
  void readProject();
});

async function readProject(): Promise<void> {
  if (!access) return;
  const output = access.outputs.get($<HTMLSelectElement>("output").value);
  if (!output) {
    status("That output is no longer there. Press Rescan.", "error");
    return;
  }
  if (!listening) {
    status("Press Listen first — otherwise nothing will be collecting the answers.", "warn");
    return;
  }
  const productId = lastProductId;
  if (productId === undefined) {
    status("Probe the device first: a read needs to know which product to address.", "warn");
    return;
  }

  let plan;
  try {
    plan = planProjectRead(productId);
  } catch (error) {
    status(String(error), "error");
    return;
  }

  const megabytes = (planBytes(plan) / 1_000_000).toFixed(1);
  if (
    !confirm(
      `Ask for all ${plan.length} objects — roughly ${megabytes} MB.\n\n` +
        `Nothing is written to the device; every request carries an empty body.\n\n` +
        `Make sure SETTINGS > SYSEX DUMP is set to USB rather than USB+MIDI: DIN MIDI ` +
        `throttles the transfer to about 3 kB/s, which would take over an hour.`,
    )
  ) {
    return;
  }

  const results = $("results");
  results.innerHTML = "";
  const progress = document.createElement("section");
  progress.className = "card";
  results.append(progress);

  const started = Date.now();
  const reader = new DumpReader({
    productId,
    send: (bytes) => output.send([...bytes]),
    onProgress: (result, done, total) => {
      const seconds = (Date.now() - started) / 1000;
      // Remaining time from the rate so far rather than from a constant: the two families differ
      // by an order of magnitude and a hard-coded estimate would be wrong on one of them.
      const left = done === 0 ? 0 : Math.round((seconds / done) * (total - done));
      progress.innerHTML =
        `<h2>Reading — ${done} of ${total}</h2>` +
        `<div class="row"><span class="k">Now</span><span class="v">` +
        `${escapeHtml(result.step.label)} — ${escapeHtml(result.status)}</span></div>` +
        `<div class="row"><span class="k">Received</span><span class="v">` +
        `${capture.byteLength.toLocaleString()} bytes</span></div>` +
        `<div class="row"><span class="k">About</span><span class="v">${left}s to go</span></div>`;
      status(
        `${SPINNER[done % SPINNER.length]}  reading ${done}/${total} — ${result.step.label}`,
        result.status === "ok" ? "info" : "warn",
      );
    },
  });

  reading = reader;
  $("readProject").textContent = "Stop read";
  $<HTMLButtonElement>("request").disabled = true;
  $<HTMLButtonElement>("listen").disabled = true;

  try {
    const report = await reader.run(plan);
    reportCard(results, report, Date.now() - started);
    status(
      `${report.ok} of ${plan.length} objects read, ${capture.byteLength.toLocaleString()} bytes.` +
        (report.silent > 0 ? ` ${report.silent} silent.` : "") +
        " Press Save capture.",
      report.silent === 0 ? "ok" : "warn",
    );
  } catch (error) {
    status(`The read stopped: ${error}`, "error");
  } finally {
    reading = undefined;
    $("readProject").textContent = "Read project";
    $<HTMLButtonElement>("request").disabled = false;
    $<HTMLButtonElement>("listen").disabled = false;
    $<HTMLButtonElement>("save").disabled = capture.isEmpty;
    $<HTMLButtonElement>("writeBack").disabled = capture.isEmpty;
    // Refreshed here rather than on every message: parsing a 14 MB capture to repopulate a select
    // is not something to do 257 times during a read.
    fillWriteSources();
  }
}

/**
 * What the run found.
 *
 * Silences, late answers and mismatches are reported as counts with what each one means, because
 * every one of them is a question about the device rather than a failure of ours — and the first
 * run of this is the experiment that answers two of them.
 */
function reportCard(into: HTMLElement, report: ReadReport, elapsedMs: number): void {
  const rows: [string, string][] = [
    ["Answered", `${report.ok} of ${report.results.length}`],
    ["Bytes", report.bytes.toLocaleString()],
    [
      "Took",
      `${(elapsedMs / 1000).toFixed(1)}s` +
        (report.bytesPerSecond > 0
          ? ` — ${(report.bytesPerSecond / 1000).toFixed(0)} kB/s`
          : ""),
    ],
  ];

  if (report.stopped) rows.push(["Stopped", "by you, before the plan finished"]);

  // Said as an answer, not as a failure. A Digitone 1 asked for 128 sounds gives four; without
  // this line that reads as 124 things going wrong rather than as a device with four sounds.
  if (report.skipped > 0) {
    rows.push([
      "Not asked for",
      `${report.skipped} — the device went quiet on ${report.gaveUpOn
        .map((g) => hex(g.code))
        .join(", ")} after ${report.gaveUpOn[0]?.after ?? 0} in a row, so the rest was skipped. ` +
        `On a Digitone 1 that is expected for sounds: it answers 0x63 for its four kit tracks ` +
        `only, and its sound pool has to be sent from SETTINGS > SYSEX DUMP instead.`,
    ]);
  }

  if (report.silent > 0) {
    const first = report.results.find((r) => r.status === "silent");
    rows.push([
      "No answer",
      `${report.silent} object(s), first at ${first?.step.label ?? "?"} — either the device sends ` +
        `nothing for that slot, or the transport is too slow for the wait`,
    ]);
  }
  if (report.late > 0) {
    rows.push([
      "Answered late",
      `${report.late} — the wait is too short for this transport. If SYSEX DUMP is set to ` +
        `USB+MIDI, switch it to USB: DIN throttles this to about 3 kB/s (manual §13.4.2).`,
    ]);
  }
  if (report.objNrMismatches > 0) {
    rows.push([
      "Object number differed",
      `${report.objNrMismatches} — the device does not echo the requested index, so a rebuild ` +
        `must go by send order rather than by the number in the message`,
    ]);
  }
  if (report.sizeMismatches > 0) {
    const odd = report.results.find(
      (r) => r.status === "ok" && r.payloadBytes !== r.step.payloadBytes,
    );
    rows.push([
      "Unexpected size",
      `${report.sizeMismatches} — e.g. ${odd?.step.label}: ${odd?.payloadBytes} bytes, expected ` +
        `${odd?.step.payloadBytes}`,
    ]);
  }
  // Given its own line and its own instruction, because this is the failure the hardware found:
  // one Digitone II pattern arrived with a bad checksum and 6,433 wrong bytes, and came back
  // perfectly on the next read. Rare, silent, and fixed by asking again.
  if (report.badChecksums > 0) {
    const retry = stepsToRetry(report);
    rows.push([
      "Bad checksums",
      `${report.badChecksums} — corrupt in transit, not a format problem. Read again and these ` +
        `will almost certainly be clean: ${retry
          .slice(0, 6)
          .map((s) => s.label)
          .join(", ")}${retry.length > 6 ? `, +${retry.length - 6} more` : ""}`,
    ]);
  }
  if (report.foreign > 0) rows.push(["Other traffic", `${report.foreign} message(s), ignored`]);

  card(into, "Read report", rows);
}


// --- writing -------------------------------------------------------------------------------------

/**
 * The only control on this page that changes the instrument.
 *
 * It performs a **null round trip**: a record from the current capture is sent back to the slot it
 * came from — identical bytes to the same place — and then requested again and compared. If the
 * write path works, nothing changed; if it is broken, nothing changed either; and if the bytes land
 * somewhere else, the read-back shows it while the original is still in the capture.
 *
 * That is deliberately the least interesting write imaginable, and it is the right first one. See
 * `docs/device-probing.md` for the regime, and `src/device/dumpwrite.ts` for the guards that
 * refuse everything this page does not explicitly ask for.
 */
let awaitingReply: ((data: Uint8Array) => void) | undefined;

$("writeBack").addEventListener("click", () => {
  // **Never `void` a promise on this page.** A rejected `writeBack` used to vanish without a
  // trace: `output.send()` can throw on a 114 KB message, and the only symptom was a UI that did
  // nothing at all. Silence is the one outcome a control that changes an instrument must not have.
  writeBack().catch((error: unknown) => {
    status(`The write failed: ${String(error)}`, "error");
    verdictCard("Write failed", [
      ["Error", String(error)],
      [
        "Meaning",
        "the message was not sent, or the port rejected it. Nothing was written — but check the " +
          "device, because 'we threw before sending' and 'the send threw partway' look the same " +
          "from here.",
      ],
    ]);
  });
});

async function writeBack(): Promise<void> {
  if (!access) return;
  const output = access.outputs.get($<HTMLSelectElement>("output").value);
  const productId = lastProductId;
  if (!output || productId === undefined) {
    status("Probe the device first — a write has to be addressed to a known product.", "warn");
    return;
  }
  if (!listening) {
    status("Press Listen first: a write that cannot be read back is not verifiable.", "warn");
    return;
  }

  // Sent back to its own slot, so the record has to come from this device in the first place.
  const messages = splitCapture();
  const candidate = messages.find((m) => m.dumpType === 0x50 && m.productId === productId);
  if (!candidate) {
    status(
      "No PatternKit in the capture from this device. Read one first — Write back only ever " +
        "returns a record to where it came from.",
      "warn",
    );
    return;
  }

  const slot = patternName(candidate.objNr);
  if (
    !confirm(
      `Write pattern ${slot} back to slot ${slot} on the device.\n\n` +
        `This OVERWRITES that slot. The bytes are identical to what the device just sent, so ` +
        `nothing should change — but this is a real write and there is no undo.\n\n` +
        `Load a scratch project first. Continue?`,
    )
  ) {
    return;
  }

  let message: Uint8Array;
  try {
    message = nullRoundTrip(productId, rebuildRaw(candidate));
  } catch (error) {
    // A guard firing is a result, not a non-event. Shown as a card because the status bar alone
    // was missed on the first hardware run.
    verdictCard("Write refused before anything was sent", [
      ["Slot", slot],
      ["Reason", String(error)],
      ["Device", "untouched — the message was never built, let alone sent"],
    ]);
    status(`Refused: ${String(error)}`, "error");
    return;
  }

  // Narrated step by step into the verdict element, which nothing else on this page redraws.
  const log: [string, string][] = [
    ["Slot", slot],
    ["Record", `${candidate.payload.length.toLocaleString()} bytes payload`],
    ["Message", `${message.length.toLocaleString()} bytes on the wire`],
  ];
  const trace = (what: string, detail: string): void => {
    log.push([what, detail]);
    verdictCard("Write in progress", log);
  };
  trace("Sending", `0x50 to slot ${slot}…`);

  try {
    status(`Writing ${slot}…`, "warn");
    output.send([...message]);
  } catch (error) {
    trace("Send failed", String(error));
    status(`The device rejected the message: ${String(error)}`, "error");
    return;
  }

  // Read it straight back. A device that stored the bytes and one that ignored the message look
  // identical from the sending end; only this tells them apart.
  trace("Sent", "asking for it back to see what actually landed");
  status(`Written. Asking for ${slot} back…`);
  const readBack = await new Promise<Uint8Array | undefined>((resolve) => {
    const timer = setTimeout(() => {
      awaitingReply = undefined;
      resolve(undefined);
    }, VERIFY_TIMEOUT_MS);

    awaitingReply = (data) => {
      let reply;
      try {
        reply = parseMessage(data);
      } catch {
        return;
      }
      if (reply.dumpType !== 0x50 || reply.objNr !== candidate.objNr) return;
      clearTimeout(timer);
      awaitingReply = undefined;
      resolve(reply.payload);
    };

    try {
      output.send([...dumpRequest(productId, { code: 0x60, objNr: candidate.objNr })]);
    } catch (error) {
      clearTimeout(timer);
      awaitingReply = undefined;
      trace("Read-back request failed", String(error));
      resolve(undefined);
    }
  });

  if (!readBack) {
    log.push(["Read back", `nothing within ${VERIFY_TIMEOUT_MS}ms`]);
    verdictCard("Write NOT verified — yet", [
      ...log,
      [
        "Means",
        "unverified is not the same as failed. The write may well have landed; the reply may " +
          "simply be slower than the wait. Still listening — if it arrives this card updates.",
      ],
    ]);
    status("Written; the read-back has not arrived yet. Still listening.", "warn");

    // **Keep waiting after giving up.** A reply that missed the timeout used to arrive, trigger a
    // capture redraw, and wipe the verdict — which is how a slow but successful write came to look
    // like a control that does nothing. A late answer is an answer, so it upgrades the card.
    awaitingReply = (data) => {
      let reply;
      try {
        reply = parseMessage(data);
      } catch {
        return;
      }
      if (reply.dumpType !== 0x50 || reply.objNr !== candidate.objNr) return;
      awaitingReply = undefined;
      const late = verifyWrite(candidate.payload, reply.payload);
      verdictCard(late.ok ? "Write VERIFIED (reply was late)" : "Write did NOT match", [
        ...log,
        ["Read back", `${reply.payload.length.toLocaleString()} bytes, after the wait expired`],
        ["Result", late.ok ? "the device returned exactly what was sent" : late.reason ?? "differs"],
        ["Note", `the ${VERIFY_TIMEOUT_MS}ms wait is too short for this device at this record size`],
      ]);
      status(late.ok ? `${slot} verified — the reply was just slow.` : `${slot} did NOT verify.`, late.ok ? "ok" : "error");
    };
    return;
  }

  const verdict = verifyWrite(candidate.payload, readBack);
  verdictCard(verdict.ok ? "Write VERIFIED" : "Write did NOT match", [
    ...log,
    ["Read back", `${readBack.length.toLocaleString()} bytes`],
    ["Result", verdict.ok ? "the device returned exactly what was sent" : verdict.reason ?? "differs"],
    [
      "Means",
      verdict.ok
        ? "writing works on this device, at this record size, to this slot"
        : "the bytes did not land as sent — write nothing else until this is understood",
    ],
  ]);
  status(
    verdict.ok ? `${slot} written and verified — writing works.` : `${slot} did NOT verify.`,
    verdict.ok ? "ok" : "error",
  );
}

// --- writing to a different slot -----------------------------------------------------------------

/**
 * The first write that actually changes something.
 *
 * The null round trip proved the path with bytes that were already there. This one moves a pattern
 * into a slot it was not in, which is the operation the manager will eventually perform over MIDI
 * — and it is the experiment that answers the two things `docs/device-probing.md` still lists as
 * unknown: whether a write reaches the +Drive or only the active copy in RAM, and what happens to
 * a slot that already holds work.
 *
 * The destination defaults to `H16` because the last slot of the last bank is the least likely to
 * hold anything, and the control refuses a non-blank destination unless the user says otherwise —
 * judged against the **captured blank**, which is itself a device artefact rather than our idea of
 * what empty looks like.
 */
function fillWriteSources(): void {
  const select = $<HTMLSelectElement>("writeFrom");
  const patterns = splitCapture().filter((m) => m.dumpType === 0x50);
  const seen = new Set<number>();
  const options: string[] = [];
  for (const m of patterns) {
    if (seen.has(m.objNr)) continue;
    seen.add(m.objNr);
    options.push(`<option value="${m.objNr}">${escapeHtml(patternName(m.objNr))}</option>`);
  }
  select.innerHTML = options.join("");
  const usable = options.length > 0 && lastProductId !== undefined;
  select.disabled = !usable;
  $<HTMLInputElement>("writeTo").disabled = !usable;
  $<HTMLButtonElement>("writeSlot").disabled = !usable;
}

$("writeSlot").addEventListener("click", () => {
  writeToChosenSlot().catch((error: unknown) => {
    status(`The write failed: ${String(error)}`, "error");
    verdictCard("Write failed", [["Error", String(error)]]);
  });
});

async function writeToChosenSlot(): Promise<void> {
  if (!access) return;
  const output = access.outputs.get($<HTMLSelectElement>("output").value);
  const productId = lastProductId;
  if (!output || productId === undefined) {
    status("Probe the device first.", "warn");
    return;
  }
  if (!listening) {
    status("Press Listen first: a write that cannot be read back is not verifiable.", "warn");
    return;
  }

  const destination = patternIndex($<HTMLInputElement>("writeTo").value);
  if (destination === undefined) {
    status(`"${$<HTMLInputElement>("writeTo").value}" is not a slot. Use A1 to H16.`, "error");
    return;
  }

  const sourceObj = Number($<HTMLSelectElement>("writeFrom").value);
  const messages = splitCapture();
  const source = messages.find((m) => m.dumpType === 0x50 && m.objNr === sourceObj);
  if (!source) {
    status("That pattern is no longer in the capture. Read the project again.", "warn");
    return;
  }
  if (destination === sourceObj) {
    status("That is the slot it came from — use Write back for the null round trip.", "warn");
    return;
  }

  // Is there something in the way? Judged against the device's own blank, not ours.
  const device = productId === ProductId.DN1 ? DN1_DEVICE : DN2_DEVICE;
  const existing = messages.find((m) => m.dumpType === 0x50 && m.objNr === destination);
  let occupancy = "not in the capture — unknown, so assume it holds something";
  if (existing) {
    const blank = blankPatternKit(device, destination);
    const verdict = looksBlank(
      existing.payload, blank, device.slotIndexOffset, device.layout.patternSize + 8, 16,
    );
    occupancy = verdict.blank
      ? "empty — matches the device's own blank exactly"
      : `HOLDS WORK — ${verdict.differingBytes.toLocaleString()} bytes differ from a blank`;
  }

  const from = patternName(sourceObj);
  const to = patternName(destination);
  if (
    !confirm(
      `Copy pattern ${from} into slot ${to}.\n\n` +
        `Destination: ${occupancy}\n\n` +
        `This overwrites ${to} in the device's ACTIVE project. ${from} is unaffected.\n\n` +
        `To undo: load another project on the device without saving. A write does not reach the ` +
        `+Drive until you press SAVE PROJECT.\n\nContinue?`,
    )
  ) {
    return;
  }

  const log: [string, string][] = [
    ["From", from],
    ["To", to],
    ["Destination was", occupancy],
  ];
  const trace = (what: string, detail: string): void => {
    log.push([what, detail]);
    verdictCard("Write in progress", log);
  };

  let message: Uint8Array;
  try {
    message = writeToSlot(productId, rebuildRaw(source), destination, device.slotIndexOffset);
  } catch (error) {
    verdictCard("Write refused before anything was sent", [
      ...log,
      ["Reason", String(error)],
      ["Device", "untouched"],
    ]);
    status(`Refused: ${String(error)}`, "error");
    return;
  }

  trace("Sending", `${message.length.toLocaleString()} bytes to ${to}…`);
  try {
    output.send([...message]);
  } catch (error) {
    trace("Send failed", String(error));
    status(`The device rejected the message: ${String(error)}`, "error");
    return;
  }

  trace("Sent", `asking for ${to} back`);
  const readBack = await awaitPatternKit(output, productId, destination);
  if (!readBack) {
    verdictCard("Write NOT verified — yet", [
      ...log,
      ["Read back", `nothing within ${VERIFY_TIMEOUT_MS}ms`],
      ["Means", "unverified is not failed. Read the project again and compare."],
    ]);
    status(`${to} written; no read-back yet.`, "warn");
    return;
  }

  // Compared against what was *sent*, not against the source: the slot index byte legitimately
  // differs between them, and comparing to the source would report that as a failure every time.
  const sent = parseMessage(message).payload;
  const verdict = verifyWrite(sent, readBack);

  // **Three outcomes, not two.** A device that overwrote and a device that refused both answer the
  // request and both stay silent about the write itself, so "did not match what we sent" is not a
  // diagnosis. Held against what the slot contained *before*, the answer is unambiguous — and on a
  // refusal it also says the original is intact, which is the thing the user needs to know.
  const wasThere = existing && verifyWrite(existing.payload, readBack).ok;
  const outcome = verdict.ok
    ? "overwritten"
    : wasThere
      ? "refused"
      : "unexpected";

  const title =
    outcome === "overwritten"
      ? `Write VERIFIED — ${from} is now in ${to}`
      : outcome === "refused"
        ? `Device REFUSED the write — ${to} is unchanged`
        : "Write did NOT match, and neither does the original";

  verdictCard(title, [
    ...log,
    ["Read back", `${readBack.length.toLocaleString()} bytes`],
    [
      "Result",
      outcome === "overwritten"
        ? "the device returned exactly what was sent"
        : outcome === "refused"
          ? `${to} still holds exactly what it held before — the device declined the write, ` +
            `silently, and nothing was lost`
          : `matches neither what was sent nor what was there: ${verdict.reason ?? "differs"}`,
    ],
    [
      "Next",
      outcome === "overwritten"
        ? "SAVE PROJECT on the device to keep this. A write lands in the active project, not the " +
          "+Drive — it survives a power cycle but is lost the moment another project is loaded. " +
          "Which also means: to undo it, load another project without saving."
        : outcome === "refused"
          ? "Nothing to undo. The device protects occupied slots, which is worth knowing before " +
            "any bulk operation is built on writes."
          : "Write nothing else until this is understood. Load another project without saving to " +
            "discard whatever happened.",
    ],
  ]);
  status(
    outcome === "overwritten"
      ? `${from} written to ${to} and verified.`
      : outcome === "refused"
        ? `${to} was not overwritten — the device refused.`
        : `${to} holds something unexpected.`,
    outcome === "overwritten" ? "ok" : outcome === "refused" ? "warn" : "error",
  );
}

/** Ask for one patternKit and wait for it, tolerating a late reply. */
function awaitPatternKit(
  output: MIDIOutput, productId: number, objNr: number,
): Promise<Uint8Array | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      awaitingReply = undefined;
      resolve(undefined);
    }, VERIFY_TIMEOUT_MS);

    awaitingReply = (data) => {
      let reply;
      try {
        reply = parseMessage(data);
      } catch {
        return;
      }
      if (reply.dumpType !== 0x50 || reply.objNr !== objNr) return;
      clearTimeout(timer);
      awaitingReply = undefined;
      resolve(reply.payload);
    };

    try {
      output.send([...dumpRequest(productId, { code: 0x60, objNr })]);
    } catch {
      clearTimeout(timer);
      awaitingReply = undefined;
      resolve(undefined);
    }
  });
}

/**
 * The verdict, put somewhere the capture renderer cannot reach.
 *
 * **Third attempt, and the first structural one.** The first version appended to `#results` and was
 * cleared by the next incoming message. The second guarded that with a `writing` flag — which
 * still lost, because the flag is only true *during* the write and any message arriving afterwards
 * redraws the area: a reply that beat the timeout, a late one that missed it, anything at all.
 *
 * Flags cannot fix this. The verdict lives in its own element, and `renderCapture` does not know
 * that element exists. Nothing that redraws the capture can destroy it, whatever the ordering.
 */
function verdictCard(title: string, rows: [string, string][]): void {
  const into = $("writeResult");
  into.innerHTML = "";
  card(into, title, rows);
  into.scrollIntoView({ block: "start" });
}

/** Long enough for a 114 KB PatternKit on a busy device. */
const VERIFY_TIMEOUT_MS = 5000;

/** The capture, as parsed messages. */
function splitCapture(): ReturnType<typeof parseMessage>[] {
  const out: ReturnType<typeof parseMessage>[] = [];
  for (const raw of splitMessages(capture.bytes())) {
    try {
      out.push(parseMessage(raw));
    } catch {
      // Not a dump. Counted elsewhere; ignored here.
    }
  }
  return out;
}

/** Re-emit a parsed message as bytes, so the writer can parse it back with its own guards. */
function rebuildRaw(message: ReturnType<typeof parseMessage>): Uint8Array {
  return rebuildMessage(message);
}
