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
import { REQUEST_OPTIONS, dumpRequest } from "../../../src/device/dumprequest.js";
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
 * The product id from the last successful probe.
 *
 * A dump request has to be addressed to a product — 13 for a Digitone, 21 for a Digitone II — and
 * guessing it would send a well-formed message to the wrong machine. So Request stays unavailable
 * until Probe has established what is actually on the other end.
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

    lastProductId = device.productId;
    $<HTMLSelectElement>("reqWhat").disabled = false;
    $<HTMLInputElement>("reqObj").disabled = false;
    $<HTMLButtonElement>("request").disabled = false;

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
      ...(group.numbersExhausted
        ? ([[
            "Note",
            `${group.count} messages but only ${group.objects.length} distinct numbers — the ` +
              `object number is a 7-bit field and the device stops incrementing past 127. ` +
              `Nothing was lost; beyond that point only send order identifies a record.`,
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
    capture.add(new Uint8Array(event.data));
    lastAt = Date.now();
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
    status("Press Probe first, so the device's product id is known.", "warn");
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
