/**
 * The device probe: the smallest thing that needs hardware.
 *
 * Ask a connected Elektron what it is, what firmware it runs, which messages it supports, and
 * what is on its +Drive. Nothing is written, nothing is changed, and no project is touched.
 *
 * It exists because everything else in DNX was built against a corpus of 24 real project files,
 * and **the transport is the one part that cannot be.** So this is deliberately the least code
 * that gets a real answer out of a real device, and it answers three open questions in one
 * sitting:
 *
 *  1. **The storage version.** `docs/dn2-format.md` §8a says v2 vs v3 is firmware, corroborated
 *     by elk-herd's Digitakt II build table, and has been waiting on a device build string ever
 *     since. `Version` returns exactly that.
 *  2. **What the DN2 actually implements.** `Device` returns `supportedMessages`, so we stop
 *     guessing that a Digitone II speaks what a Digitakt II speaks.
 *  3. **Whether whole projects can be read off the +Drive** — ROADMAP §3d's flagged unknown.
 *     `DirList` on `/` settles it in one round trip.
 *
 * Kept off the manager on purpose. This is a diagnostic, and the manager should not grow a MIDI
 * dependency until the protocol has been proven against hardware.
 */

import {
  type DirEntry,
  Code,
  deviceRequest,
  dirListRequest,
  readDeviceResponse,
  readDirListResponse,
  readVersionResponse,
  versionRequest,
} from "../../../src/device/api.js";
import { DeviceSession } from "../../../src/device/session.js";

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
 * Ports are listed in pairs, and the pairing is a guess the user can override.
 *
 * A device is an input and an output that happen to have similar names, and nothing in WebMIDI
 * says which belong together — an interface with four ports gives no hint at all. So the guess is
 * by name, and both selects stay editable.
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

  $<HTMLButtonElement>("probe").disabled = inputs.length === 0 || outputs.length === 0;
  status(
    inputs.length === 0 || outputs.length === 0
      ? "No MIDI ports. Connect the device and press Rescan."
      : `${inputs.length} input(s), ${outputs.length} output(s). Pick the pair and probe.`,
    inputs.length === 0 ? "warn" : "info",
  );
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
  status(`Probing ${output.name}…`);

  const session = new DeviceSession({ send: (bytes) => output.send([...bytes]) });
  const onMessage = (event: MIDIMessageEvent): void => {
    if (event.data) session.receive(new Uint8Array(event.data));
  };
  input.addEventListener("midimessage", onMessage);

  try {
    const device = readDeviceResponse((await session.request(Code.Device, deviceRequest)).body);
    const version = readVersionResponse((await session.request(Code.Version, versionRequest)).body);

    card(results, "Device", [
      ["Name", device.deviceName],
      ["Product id (API space)", String(device.productId)],
      ["Firmware", `${version.version}  (build ${version.build})`],
      ["Supported messages", device.supportedMessages.map((m) => `0x${m.toString(16).padStart(2, "0")}`).join(" ")],
    ]);

    status(`${device.deviceName}, firmware ${version.version}. Listing the +Drive…`, "ok");

    // The §3d question. A failure here is a result too, so it is reported rather than thrown.
    try {
      const root = readDirListResponse(
        (await session.request(Code.DirList, (id) => dirListRequest(id, "/"))).body,
      );
      listing(results, "/", root);
      status(
        `${device.deviceName}, firmware ${version.version}, ${root.length} entries at /.`,
        "ok",
      );
    } catch (error) {
      card(results, "+Drive listing failed", [["Error", String(error)]]);
      status(
        `${device.deviceName} answered Device and Version but not DirList — worth recording.`,
        "warn",
      );
    }
  } catch (error) {
    status(String(error), "error");
    card(results, "Probe failed", [
      ["Error", String(error)],
      ["Check", "the right port pair, and that the interface passes SysEx"],
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

$("rescan").addEventListener("click", () => {
  void connect();
});
$("probe").addEventListener("click", () => {
  void probe();
});

void connect();
