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
 *
 * ## What is left in this file
 *
 * **Connecting, and the one question the rest of the page is built on.** Getting MIDI access,
 * choosing the two ports, deciding which controls may be pressed, and running the probe itself:
 * what the device is, what firmware it runs, what it says it supports.
 *
 * Everything the probe can then *do* with that answer lives beside it, one job to a file.
 * `listen.ts` collects, `ready.ts` says whether sending is worth doing at all, `request.ts` asks,
 * `readproject.ts` reads a whole project over the dump protocol, `writeback.ts` and `writeslot.ts`
 * are the two dump writes, and `drive.ts` and `drivefile.ts` are the storage API. `link.ts` holds
 * what they all need in order to address the instrument, and `chrome.ts` the status line and
 * progress bar they all write to.
 *
 * This was one 2,333-line file. The split changed no behaviour: the same controls in the same
 * order, and the fences that guard the writes now read the folder rather than the file.
 */

import { card, listing } from "./cards.js";
import { status } from "./chrome.js";
import {
  access,
  issue,
  lastProductId,
  linkIsAlive,
  ports,
  setAccess,
  setLastProductId,
} from "./link.js";
import { capture } from "./listen.js";
import { fillProbeCodes } from "./request.js";
import { verdictAfterSilence } from "./silence.js";
import { LINK_ID } from "./storageio.js";
import { messageCard, showVerdict } from "./verdicts.js";
import {
  Code,
  describeQueryValue,
  deviceRequest,
  dirListRequest,
  queryRequest,
  readDeviceResponse,
  readDirListResponse,
  readQueryResponse,
  readVersionResponse,
  versionRequest,
} from "@noiseandmatter/dnx-core/device/api.js";
import { INFORMATION_CODES } from "../../../src/research/apiprobe.js";
import { capabilitiesOf, hex, QUERY_KEYS } from "@noiseandmatter/dnx-core/device/capabilities.js";
import { dumpProductFor } from "@noiseandmatter/dnx-core/device/dumprequest.js";
import { DeviceSession } from "@noiseandmatter/dnx-core/device/session.js";
import { $ } from "../dom.js";
import { renderToolNav } from "../toolnav.js";

/*
 * Imported for what they wire, not for what they export. Each of these attaches its own controls
 * to this page the way the block at the foot of this file attaches Rescan and Probe: the Listen
 * and Save buttons, the request row, the project read, the two dump writes, and the +Drive. The
 * page is the sum of them, and nothing here calls in.
 */
import "./drive.js";
import "./drivefile.js";
import "./readproject.js";
import "./writeback.js";
import "./writeslot.js";
// Drawn rather than written into the HTML, so the row cannot say different things on different
// pages. Immediately, because a navigation control that appears late is one you click through.
renderToolNav($("toolnav"), "probe");

// Also immediately, and for the same reason: the `?` on each card is how this page explains
// itself now that the explanation is not lying across the results. See `help.ts`.

/** The last counts `ports.render()` reported, so a select's `change` handler can re-check them. */
let lastPortCounts = { inputs: 0, outputs: 0, needsChoice: false };

/**
 * Enable or disable Probe and Listen, and say why, from the last render and the selects' current
 * values.
 *
 * Separate from `renderPorts` because it also runs on a plain `change` event, which does not
 * refill the selects: rebuilding their options on every choice would fight the click that is
 * making the choice.
 */
function updateControls(): void {
  const { inputs, outputs, needsChoice } = lastPortCounts;
  const chosenBoth =
    $<HTMLSelectElement>("input").value !== "" && $<HTMLSelectElement>("output").value !== "";
  const blocked = needsChoice && !chosenBoth;

  $<HTMLButtonElement>("probe").disabled = inputs === 0 || outputs === 0 || blocked;
  $<HTMLButtonElement>("listen").disabled = inputs === 0 || blocked;
  status(
    inputs === 0 || outputs === 0
      ? "No MIDI ports. Connect the device and press Rescan."
      : blocked
        ? "Two or more instruments are connected. Choose the input and output pair, then probe."
        : `${inputs} input(s), ${outputs} output(s). Pick the pair and probe.`,
    inputs === 0 ? "warn" : "info",
  );
}

function renderPorts(): void {
  if (!access) return;
  lastPortCounts = ports.render(access);
  updateControls();
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


/** Run the probe against one input/output pair. */
async function probe(): Promise<void> {
  if (!access) return;
  if ($<HTMLSelectElement>("input").value === "" || $<HTMLSelectElement>("output").value === "") {
    // The button is disabled in this state, but a stale click already queued, or a call from
    // somewhere other than the button, must not send to whichever port happens to be first.
    status("Two or more instruments are connected. Choose the input and output pair, then probe.", "warn");
    return;
  }
  const input = ports.input(access);
  const output = ports.output(access);
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
    const device = readDeviceResponse((await session.request(Code.Device, (id) => deviceRequest(issue(id)))).body);

    status(`${device.deviceName} answered. Asking for its firmware…`, "ok");
    const version = readVersionResponse((await session.request(Code.Version, (id) => versionRequest(issue(id)))).body);

    // Converted, not copied: the Device response is in the API's product space and a dump request
    // needs the dump protocol's. Sending the API id produces a well-formed message addressed to a
    // product that does not exist there, which a device answers by ignoring it.
    setLastProductId(dumpProductFor(device.productId));
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
      // **Named for what the list can say, which is what is advertised.** These rows read "Reads +Drive
      // files: no" and "Manages +Drive: no" on a Digitone II whose +Drive listed and read in the same
      // session: the storage API at 0x53–0x5a answers without appearing in the advertised list on
      // either Digitone. A capability row that contradicts the instrument is worse than none.
      ["Advertises the Digitakt file API", caps.driveFiles ? "yes" : "no — see DirList below"],
      ["+Drive storage API (0x53–0x5a)", "never advertised by a Digitone; press List to check it answers"],
    ]);

    // Named, not hex. A list of 22 raw codes is a transcription job; what a reader wants is
    // which of them mean something and which do not.
    messageCard(results, device.supportedMessages);

    // The unnamed part of that list is where a project object would be, so the codes to try are
    // built from what this device actually advertises rather than from a fixed list.
    fillProbeCodes(device.supportedMessages);

    // Enabled regardless of what the device advertises. `supportedMessages` lists *responses*, and
    // this API's codes are not in it on either machine — which is exactly the reasoning that made
    // us conclude for two days that the file API did not exist.
    $<HTMLInputElement>("lsPath").disabled = false;
    $<HTMLInputElement>("lsFrom").disabled = false;
    $<HTMLInputElement>("lsCount").disabled = false;
    $<HTMLButtonElement>("lsSend").disabled = false;
    // Populated from the module's own list, so the page cannot offer a code it refuses to send.
    const askCode = $<HTMLSelectElement>("askCode");
    if (askCode.options.length === 0) {
      for (const c of INFORMATION_CODES) {
        const option = document.createElement("option");
        option.value = String(c.code);
        option.textContent = `0x${c.code.toString(16).padStart(2, "0")} ${c.name}`;
        askCode.append(option);
      }
    }
    askCode.disabled = false;
    $<HTMLButtonElement>("askSend").disabled = false;
    $<HTMLInputElement>("filePath").disabled = false;
    $<HTMLInputElement>("writeTarget").disabled = false;
    $<HTMLInputElement>("corruptSum").disabled = false;
    $<HTMLInputElement>("chunkSize").disabled = false;
    $<HTMLButtonElement>("fileWrite").disabled = false;
    $<HTMLButtonElement>("fileRead").disabled = false;

    // **`DirList` is now always attempted, whatever the device advertises.**
    //
    // It was gated on `caps.driveFiles`, under "do not send a message the device says it does not
    // implement". That guard was wrong twice over, and the shape is worth more than the incident:
    //
    // 1. `supportedMessages` enumerates **responses**, so absence is not a refusal. Neither
    //    Digitone advertises `0x60`–`0x6f` and both honour them; the whole storage API lives at
    //    `0x53`–`0x5a`, which neither advertises either.
    // 2. It was **self-sealing**. The guard existed *because* `DirList` timed out — and that
    //    timeout may have been our own send blocked by another application holding the output
    //    port, which `output.send()` does not report. A possibly-false negative became code that
    //    guaranteed it could never be retested.
    //
    // What was genuinely missing when the guard was written was any way to tell "no answer" from
    // "never sent". That now exists, so a silence here finally means something and the caution can
    // be retired rather than kept out of habit.
    try {
      const root = readDirListResponse(
        (await session.request(Code.DirList, (id) => dirListRequest(issue(id), "/"))).body,
      );
      listing(results, "/", root);
      card(results, "DirList answered — elk-herd's file API is implemented here", [
        ["Advertised", caps.driveFiles ? "yes" : "no — and it worked anyway"],
        ["Means", "the Digitakt file API applies to this machine; prefer it to the reconstructed 0x53"],
      ]);
      status(`${device.deviceName}, firmware ${version.version}, ${root.length} entries at /.`, "ok");
    } catch (error) {
      showVerdict(
        verdictAfterSilence({
          what: "DirList",
          alive: await linkIsAlive(output),
          outcome: String(error),
          outcomeLabel: "Error",
          log: [
            [
              "Advertised",
              caps.driveFiles ? "yes" : `no — missing ${caps.missingForDriveFiles.map(hex).join(" ")}`,
            ],
          ],
          means:
            "a genuine negative: this device does not implement 0x10. Its storage API is at " +
            "0x53–0x5a instead — see docs/device-storage.md.",
        }),
        (title, rows) => card(results, title, rows),
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
    /*
     * **The link check is ours, and answers on another listener.** When DirList goes unanswered the
     * probe proves the link with a Device request sent through `DeviceLink` under `LINK_ID`. This
     * session hears that reply too, has no request of its own waiting for it, and used to count it —
     * so an identify with nothing else on the port still ended with an "Unmatched replies" card
     * suggesting a shared port. Only replies this page cannot account for are reported now.
     */
    const foreign = session.unmatched.filter((frame) => frame.respId !== LINK_ID);
    if (foreign.length > 0) {
      card(results, "Unmatched replies", [
        ["Count", String(foreign.length)],
        ["Replies to ids", foreign.map((f) => String(f.respId)).join(", ")],
        ["Meaning", "a timeout fired early, or something else is sharing this port"],
      ]);
    }
  }
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
        (id) => queryRequest(issue(id), key),
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

/** Three silences means the device does not answer unknown keys, not that these three were bad. */
const GIVE_UP_AFTER = 3;

/** Long enough for a real port, short enough that a held one is obvious rather than a hang. */
const OPEN_TIMEOUT_MS = 3000;


/**
 * Show when the code running this page was compiled.
 *
 * **Because "is the fix actually running?" must be answerable without guessing.** `npm run web`
 * rebuilds, but only when it is restarted, so a pulled fix and a stale `web/dist` look identical
 * from the browser — and a stalled-write session was debugged without knowing whether the fix for
 * that stall was in the served code at all.
 *
 * Taken from this module's own URL rather than a constant: a literal compiled into the file would
 * be evaluated at load time and always say "now", which is exactly the reassuring lie to avoid.
 */
async function showBuildTime(): Promise<void> {
  try {
    const response = await fetch(import.meta.url, { method: "HEAD" });
    const built = response.headers.get("last-modified");
    if (!built) return;
    const at = new Date(built).toTimeString().slice(0, 5);
    // **On the page, beside the title.** It went only into the tab title first, which is where
    // nobody looks — the first thing asked about it was where to find it. The tab keeps a copy
    // because a pinned or duplicated tab is worth telling apart too.
    $("buildStamp").textContent = `build ${at}`;
    document.title = `Device probe — build ${at}`;
  } catch {
    // A missing stamp is not worth a message; the page's job is unaffected.
  }
}

async function connect(): Promise<void> {
  void showBuildTime();
  if (!navigator.requestMIDIAccess) {
    status("This browser has no WebMIDI. Chrome or Edge; Safari and Firefox do not.", "error");
    return;
  }
  try {
    // `sysex: true` is the whole point and prompts separately from plain MIDI access. Without it
    // every request is silently dropped, which reads as a device that is not answering.
    const granted = await navigator.requestMIDIAccess({ sysex: true });
    setAccess(granted);
    granted.addEventListener("statechange", renderPorts);
    renderPorts();
  } catch (error) {
    status(`MIDI access refused: ${error}. SysEx permission is required.`, "error");
  }
}

for (const id of ["input", "output"] as const) {
  $<HTMLSelectElement>(id).addEventListener("change", (event) => {
    ports.remember(id, (event.target as HTMLSelectElement).value);
    // Re-checked here, not only from `renderPorts`: this is the moment the second half of a choice
    // arrives, and Probe and Listen must come off hold the instant both selects hold a real port.
    updateControls();
  });
}

$("rescan").addEventListener("click", () => {
  // Rescan is the way back to the guess: forgetting the choice is the point of the button, and
  // without this there would be no way to undo a mis-click short of reloading the page.
  ports.forget();
  void connect();
});
$("probe").addEventListener("click", () => {
  void probe();
});

void connect();

