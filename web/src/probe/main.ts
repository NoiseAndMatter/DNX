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

import { noteReply } from "../othertraffic.js";
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
import { IDS_FOR, reserveMessageIds } from "../messageids.js";
import {
  answerIsNews,
  describeAnswerChange,
  describeListingChange,
} from "./changes.js";
import {
  hiddenRow,
  tickWhileWaiting,
  timeGoesRow,
  watchInbound,
  watchMainThread,
  watchVisibility,
} from "./timing.js";
import { DeviceSession } from "../../../src/device/session.js";
import {
  type ApiGroup,
  type CaptureSummary,
  DumpCapture,
  captureFileName,
} from "../../../src/device/capture.js";
import { REQUEST_OPTIONS, dumpProductFor, dumpRequest } from "../../../src/device/dumprequest.js";
import { DumpReader, type ReadReport, stepsToRetry } from "../../../src/device/dumpreader.js";
import { planBytes, planProjectRead } from "../../../src/device/readplan.js";
import {
  driftSince,
  looksBlank,
  nullRoundTrip,
  settleMsAfter,
  verifyWrite,
  writeToSlot,
} from "../../../src/device/dumpwrite.js";
import { parseMessage, rebuildMessage, splitMessages } from "../../../src/sysex/container.js";
import { patternIndex, patternName } from "../../../src/project/naming.js";
import { codesUnderTest, describeReply, probeRequest } from "../../../src/device/probecodes.js";
import {
  type Entry,
  StorageCode,
  driveChecksum,
  listRequest,
  parseListing,
  wholeListing,
  STORED_FORM,
} from "../../../src/device/storage.js";
import {
  INFORMATION_CODES,
  describeApiReply,
  hexBody,
  informationRequest,
} from "../../../src/device/apiprobe.js";
import { type ApiTransport, readStoredFile } from "../../../src/device/storagesession.js";
import {
  CONTAINER_SLOT_OFFSET,
  buildRecordBackup,
  safeWriteFile,
} from "../../../src/device/safewrite.js";
import { STAGE_LABEL, confirmFileWrite } from "../safewriteui.js";
import { requireWriteEnabled } from "../writeenable.js";
import { type ApiFrame, decodeMessage, isApiMessage } from "../../../src/device/api.js";
import { $, escapeHtml } from "../dom.js";
import { saveBytesTo, savedTone, whereSaved } from "../dnxfolder.js";
import { statusBar } from "../statusbar.js";
import { describeBytes, progressBar } from "../progress.js";
import { askConfirm } from "../dialog.js";
import {
  card,
  listing,
  messageCard as drawMessages,
  renderCapture as drawCapture,
  verdictCard as drawVerdict,
} from "./cards.js";
import {
  KNOWN_RECORD_SIZES,
  describeChunkChecksums,
  hex2,
  hex8,
  looksLikeZip,
} from "./format.js";
import { DeviceLink, matchApiFrame } from "../devicelink.js";
import { PortPicker } from "./ports.js";
import { readReportRows } from "./report.js";
import { describeWrite, unverifiedMeans, writeOutcome } from "./writeverdict.js";
import {
  LIST_TIMEOUT_MS,
  requestListing,
  linkIsAlive as checkLink,
  LINK_ID,
} from "./storageio.js";
import { type Verdict, verdictAfterSilence } from "./silence.js";
import {
  UNKNOWN_TIMEOUT_MS,
  VERIFY_TIMEOUT_MS,
  requestPatternKit,
  tryCode,
} from "./dumpio.js";

const status = statusBar();
const bar = progressBar();

// Drawn rather than written into the HTML, so the row cannot say different things on different
// pages. Immediately, because a navigation control that appears late is one you click through.
renderToolNav($("toolnav"), "probe");

// Also immediately, and for the same reason: the `?` on each card is how this page explains
// itself now that the explanation is not lying across the results. See `help.ts`.
import { ProductId } from "../../../src/sysex/devices.js";
import { DN1_DEVICE, DN2_DEVICE } from "../../../src/librarian/device.js";
import { blankPatternKit } from "../../../src/librarian/blank.js";
import {
  QUERY_KEYS,
  capabilitiesOf,
  describeMessages,
  hex,
} from "../../../src/device/capabilities.js";
import { renderToolNav } from "../toolnav.js";

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
 * Which two ports are the instrument.
 *
 * The guessing and remembering live in `ports.ts`; this page keeps only what it does with the
 * answer — which buttons that enables and what the status line says about it.
 */
const ports = new PortPicker($<HTMLSelectElement>("input"), $<HTMLSelectElement>("output"));

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
    access = await navigator.requestMIDIAccess({ sysex: true });
    access.addEventListener("statechange", renderPorts);
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

/**
 * Draw the capture into this page's results area.
 *
 * The drawing itself lives in `cards.ts`; this supplies what only the page knows — where to put
 * it, whether we are still listening, and which message ids this page issued.
 */
function renderCapture(): CaptureSummary {
  const summary = capture.summarise();
  return drawCapture($("results"), summary, { listening: listening !== undefined, issuedIds });
}

/**
 * Every message id this page has put on the wire.
 *
 * Cheap to keep and the only thing that can settle "whose reply is this". Deliberately never
 * cleared — a late answer to a request from ten minutes ago is still *ours*, and forgetting that is
 * how a stale reply gets mistaken for someone else's traffic.
 */
const issuedIds = new Set<number>();

/** Record an id as ours, and hand it straight back so a call site reads as one expression. */
function issue(id: number): number {
  issuedIds.add(id);
  return id;
}

/** A rolling indicator, so "still going" is visible without reading numbers. */
/**
 * How often the capture may redraw while messages are pouring in.
 *
 * Fast enough to look live, slow enough that a flood cannot starve the page. The failure it
 * prevents was not subtle: 56.4 seconds of blocked main thread for one write.
 */
const REPAINT_MS = 250;

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
  const input = ports.input(access);
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

    /*
     * **Listen is where another application is most visible**, because it is the one mode that
     * hears a port nobody here is driving. The other pages count replies inside
     * `awaitApiFrame`, which only runs while DNX is waiting for one of its own; a probe sitting
     * idle on a shared port would see Transfer's whole conversation and say nothing.
     */
    matchApiFrame(data, (frame) => {
      noteReply(frame.respId);
      return false;
    });

    // A read drives its own narration and owns the results area while it runs, so re-rendering
    // the capture on every message would tear down the progress it is drawing. The bytes are
    // already in the capture either way, which is the part that must not depend on the UI.
    if (reading) {
      reading.receive(data);
      return;
    }
    repaint();
  };

  /**
   * Redraw at most once every `REPAINT_MS`, however many messages arrive.
   *
   * **This is the write stall.** The listener used to call `renderCapture()` per message, and the
   * status line under it called `summarise()` a second time — so every arriving message parsed the
   * entire capture twice. Measured on hardware: 7,279 messages arrived during one write, the main
   * thread was blocked for **56.4 seconds in one go**, and two interval ticks got through in that
   * time. A 321ms settle took the whole of it.
   *
   * MIDI events are dispatched back to back, so nothing else — no timer, no promise, no repaint —
   * gets a turn until the queue drains. Coalescing turns thousands of full re-parses into one, and
   * a burst that blocks the page becomes a burst the page reads through.
   *
   * The trailing redraw matters as much as the throttle: when the flood ends, the last messages
   * must still be shown, and a leading-edge-only throttle would leave the count stale.
   */
  let repaintAt = 0;
  let repaintQueued: ReturnType<typeof setTimeout> | undefined;
  const draw = (): void => {
    repaintAt = Date.now();
    repaintQueued = undefined;
    const summary = renderCapture();
    // A project dump is minutes of silence punctuated by a message every so often, and a static
    // byte count during that gap is indistinguishable from a stall. The spinner advances and the
    // message count rises, so *something moving* is visible without comparing two numbers a
    // minute apart. Uses the summary the render already computed rather than asking again.
    status(
      `${SPINNER[ticks++ % SPINNER.length]}  receiving — ` +
        `${summary.bytes.toLocaleString()} bytes, ${summary.messages} message(s)`,
    );
  };
  const repaint = (): void => {
    if (repaintQueued !== undefined) return;
    const due = REPAINT_MS - (Date.now() - repaintAt);
    if (due <= 0) {
      draw();
      return;
    }
    repaintQueued = setTimeout(draw, due);
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
  const length = capture.byteLength;
  void saveBytesTo(capture.bytes(), name, "probe").then((saved) => {
    status(`Saved ${whereSaved(saved)} — ${length.toLocaleString()} bytes.`, savedTone(saved));
  });
});



// --- is the page in a state worth sending from? --------------------------------------------------

/**
 * What the reply is for, which is the only thing the Listen check needs to know.
 *
 * A request wants its answer collected. A write wants to read back what it wrote, which is a
 * stronger reason: an unverifiable write is not a test of anything.
 */
type Await = "reply" | "readback";

/**
 * The output port, if sending is worth doing at all.
 *
 * Nine call sites opened with the same three guards and had drifted into four wordings of one
 * sentence — *nothing will be collecting the reply*, *nothing collects the reply*, *the answers*,
 * *the replies* — which is four ways of saying a thing that is true once. Unlike `silence.ts` this
 * stays here rather than becoming a module: it reads `access`, `ports`, `listening` and `status`,
 * so a separate file would need all four passed in, which is more machinery than the check.
 */
function readyOutput(waiting: Await): MIDIOutput | undefined {
  if (!access) return undefined;

  const output = ports.output(access);
  if (!output) {
    status("That output is no longer there. Press Rescan.", "error");
    return undefined;
  }
  if (!listening) {
    status(
      waiting === "readback"
        ? "Press Listen first: a write that cannot be read back is not verifiable."
        : "Press Listen first — otherwise nothing collects the reply.",
      "warn",
    );
    return undefined;
  }
  return output;
}

/**
 * The same, plus the product id the dump protocol needs to address anything at all.
 *
 * The storage API is addressed by path and does not need this; the `0x6n` requests do.
 */
function readyDump(waiting: Await): { output: MIDIOutput; productId: number } | undefined {
  const output = readyOutput(waiting);
  if (!output) return undefined;

  const productId = lastProductId;
  if (productId === undefined) {
    // Both halves matter: probing may not have happened, or it happened and returned a product
    // this build has no dump-protocol entry for. They need different things done about them.
    status(
      "No dump-protocol product id for this device — probe it first, and if it has been probed, " +
        "it is a product this build does not know how to address.",
      "warn",
    );
    return undefined;
  }
  return { output, productId };
}

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
  const ready = readyDump("reply");
  if (!ready) return;
  const { output, productId: product } = ready;

  const option = requestOption();
  const objNr = option.indexed ? Number($<HTMLInputElement>("reqObj").value) : 0;

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
  const ready = readyDump("reply");
  if (!ready) return;
  const { output, productId } = ready;

  let plan;
  try {
    plan = planProjectRead(productId);
  } catch (error) {
    status(String(error), "error");
    return;
  }

  const megabytes = (planBytes(plan) / 1_000_000).toFixed(1);
  if (
    !(await askConfirm({
      title: `Read all ${plan.length} objects — roughly ${megabytes} MB?`,
      body: [
        "Nothing is written to the device; every request carries an empty body.",
        "Make sure SETTINGS > SYSEX DUMP is set to USB rather than USB+MIDI. DIN MIDI throttles " +
          "the transfer to about 3 kB/s, which would take over an hour.",
      ],
      confirmLabel: "Read the project",
    }))
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
      bar.at(done, total, "Reading the project");
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
    bar.done();
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
  card(into, "Read report", readReportRows(report, elapsedMs));
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
/**
 * Every request path on this page waits through `DeviceLink`, which attaches its own listener per
 * request. There is deliberately no shared slot here any more: one used to serve seven paths, and
 * two overlapping reads stole each other's answers.
 */
function linkTo(output: MIDIOutput): DeviceLink {
  const input = access && ports.input(access);
  if (!input) throw new Error("that input port is no longer there — press Rescan");
  return new DeviceLink(input, output);
}

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
  const ready = readyDump("readback");
  if (!ready) return;
  const { output, productId } = ready;

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
  const device = productId === ProductId.DN1 ? DN1_DEVICE : DN2_DEVICE;

  // Nothing reaches an instrument until somebody arms the switch, and the disabled button is not
  // what enforces that. Checked before the pre-write read, so a control the page forgot to gate
  // is refused before the device is asked anything. See `writeenable.ts`.
  try {
    requireWriteEnabled();
  } catch (error) {
    verdictCard("Write refused: writing is switched off", [
      ["Slot", slot],
      ["Reason", String(error)],
      ["Device", "untouched"],
    ]);
    status(`Not written: ${String(error)}`, "warn");
    return;
  }

  /*
   * **Is it still a null round trip?** The capture is what the slot held when it was read, and the
   * confirmation used to promise the bytes were identical to what the device just sent. That stops
   * being true the moment somebody turns a knob between the read and the write, and then this is an
   * ordinary overwrite of an ordinary edit, made under a promise that nothing would change.
   *
   * So the slot is asked for again, and the answer does two jobs: it decides what the question says,
   * and it is the copy kept before anything is sent.
   */
  status(`Asking for ${slot} before touching it…`);
  const onDevice = await awaitPatternKit(output, productId, candidate.objNr);
  if (!onDevice) {
    verdictCard("Write refused — no copy of the slot", [
      ["Slot", slot],
      ["Asked for it back", `nothing within ${VERIFY_TIMEOUT_MS}ms`],
      [
        "Reason",
        "this read is both the check that the round trip is still null and the copy kept before " +
          "writing. Without it there is neither, so nothing was sent.",
      ],
      ["Device", "untouched"],
    ]);
    status(`${slot} did not answer, so nothing was sent.`, "error");
    return;
  }

  const drift = driftSince(candidate.payload, onDevice);
  if (!drift.same) {
    // A card before the question, so the finding survives whatever the person then chooses. A null
    // round trip that turns out not to be null is a result, and the probe exists to record results.
    verdictCard("The slot has moved on since the capture", [
      ["Slot", slot],
      ["Captured", `${candidate.payload.length.toLocaleString()} bytes`],
      ["On the device now", drift.reason ?? "differs"],
      [
        "Means",
        "this is no longer a null round trip. Writing puts the older capture back over whatever " +
          "changed. The copy saved on the way through is the newer one.",
      ],
    ]);
  }

  if (
    !(await askConfirm({
      title: drift.same
        ? `Write pattern ${slot} back to slot ${slot}?`
        : `Slot ${slot} has changed — still write the capture over it?`,
      body: [
        drift.same
          ? `This OVERWRITES that slot. The bytes are identical to what the slot holds right now, ` +
            `asked a moment ago, so nothing should change — but this is a real write and there is ` +
            `no undo.`
          : `This is NOT the null round trip it looks like. Since the capture was taken, ${drift.reason}. ` +
            `Writing puts the older bytes back over that change.`,
        `${slot} as it stands is saved to your machine first, as a .syx you can send straight back.`,
        "Load a scratch project first.",
      ],
      confirmLabel: `Overwrite ${slot}`,
      danger: true,
    }))
  ) {
    return;
  }

  /*
   * The copy: after the question, before anything is sent. The same order and the same reason as
   * `safeWriteFile` — a backup downloaded for a write somebody then cancels is rude, and a write
   * that began before the copy was taken is worse. A failure here is a refusal, not a warning.
   */
  const backup = buildRecordBackup(
    productId, device.name, [candidate.objNr], new Map([[candidate.objNr, onDevice]]),
  );
  try {
    const saved = await saveBytesTo(backup.bytes, backup.name, "copies");
    status(`Copy of the destination saved to ${whereSaved(saved)}.`, savedTone(saved));
  } catch (error) {
    verdictCard("Write refused — the copy could not be saved", [
      ["Slot", slot],
      ["Reason", String(error)],
      ["Device", "untouched"],
    ]);
    status(`The copy of ${slot} could not be saved, so nothing was sent: ${String(error)}`, "error");
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
    ["Slot before the write", drift.same ? "identical to the capture" : drift.reason ?? "differs"],
    ["Backup", `${backup.name} (${backup.bytes.length.toLocaleString()} bytes)`],
  ];
  // Every line carries how long the write has been running. Two stalled runs on hardware reported
  // their last line at *different* steps, which no single code path explains — without elapsed
  // times there was no way to tell a wait that is running from a page that has stopped running at
  // all. A log that cannot distinguish those two is not a log.
  const startedAt = Date.now();
  const since = (): string => `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  const trace = (what: string, detail: string): void => {
    log.push([what, `${detail}  (${since()})`]);
    verdictCard("Write in progress", log);
  };
  // Started before the send, because the send is the suspect — a measurement that begins after it
  // would miss exactly the window in question.
  const thread = watchMainThread();
  const inbound = watchInbound(linkTo(output).input);
  trace("Sending", `0x50 to slot ${slot}…`);

  try {
    status(`Writing ${slot}…`, "warn");
    output.send([...message]);
  } catch (error) {
    trace("Send failed", String(error));
    status(`The device rejected the message: ${String(error)}`, "error");
    return;
  }

  // Read it back — but not immediately. A request sent behind 114 KB of SysEx is dropped by a
  // device still ingesting it, which on hardware looked like a write that worked and a page that
  // hung. elk-herd has always paced its sends this way; see `settleMsAfter`.
  const settle = settleMsAfter(message.length, productId);
  trace("Settling", `${settle}ms before asking — the device is still taking it in`);
  await new Promise((resolve) => setTimeout(resolve, settle));

  trace("Sent", "asking for it back to see what actually landed");
  status(`Written. Asking for ${slot} back…`);
  const watched = watchVisibility();
  const waiting = tickWhileWaiting(log, "Waiting for the read-back", () => verdictCard("Write in progress", log));
  const readBack = await requestPatternKit(linkTo(output), productId, candidate.objNr, {
    onSendError: (error) => trace("Read-back request failed", String(error)),
    // **Keep listening after giving up.** A reply that missed the timeout used to arrive, trigger a
    // capture redraw and wipe the verdict — which is how a slow but successful write came to look
    // like a control that does nothing. A late answer is an answer, so it upgrades the card.
    onLate: (payload) => reportLateReadBack(payload, candidate, log, slot),
  });
  waiting();
  log.push(...timeGoesRow(thread(), inbound()));
  // Stopped once and kept, as the other write path already did: `watched()` detaches the listener
  // and re-measures, so calling it twice is both a double-detach and a second, later reading.
  const hidden = watched();
  log.push(...hiddenRow(hidden));

  if (!readBack) {
    log.push(["Read back", `nothing within ${VERIFY_TIMEOUT_MS}ms`]);
    verdictCard("Write NOT verified — yet", [
      ...log,
      // Taken from the measurement, not from the log. This used to string-match the row
      // `hiddenRow` produces, so renaming that row would have silently stopped the warning.
      ["Means", unverifiedMeans(hidden.hiddenMs, true)],
    ]);
    status("Written; the read-back has not arrived yet. Still listening.", "warn");

    // The late answer, if it comes, is handled by `onLate` on the wait above.
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

/**
 * A read-back that arrived after the wait expired.
 *
 * Separate from the verdict above because it is a different claim: the write is verified *and* the
 * timeout is too short for this device at this record size, which is worth saying on the card.
 */
function reportLateReadBack(
  payload: Uint8Array,
  candidate: { payload: Uint8Array },
  log: [string, string][],
  slot: string,
): void {
  const late = verifyWrite(candidate.payload, payload);
  verdictCard(late.ok ? "Write VERIFIED (reply was late)" : "Write did NOT match", [
    ...log,
    ["Read back", `${payload.length.toLocaleString()} bytes, after the wait expired`],
    ["Result", late.ok ? "the device returned exactly what was sent" : late.reason ?? "differs"],
    ["Note", `the ${VERIFY_TIMEOUT_MS}ms wait is too short for this device at this record size`],
  ]);
  status(late.ok ? `${slot} verified — the reply was just slow.` : `${slot} did NOT verify.`, late.ok ? "ok" : "error");
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
  const ready = readyDump("readback");
  if (!ready) return;
  const { output, productId } = ready;

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

  // Is there something in the way, and what is it? **Asked fresh, not read out of the capture.**
  // The capture holds whatever happened to have been read earlier, so a destination nobody had
  // read was overwritten with no copy of it at all, under a confirmation that admitted as much
  // ("not in the capture — unknown"). One read answers both questions: what the slot holds now,
  // and what to keep.
  const device = productId === ProductId.DN1 ? DN1_DEVICE : DN2_DEVICE;
  const from = patternName(sourceObj);
  const to = patternName(destination);

  // Nothing reaches an instrument until somebody arms the switch, and the disabled button is not
  // what enforces that. Checked before the pre-write read, so a control the page forgot to gate
  // is refused before the device is asked anything. See `writeenable.ts`.
  try {
    requireWriteEnabled();
  } catch (error) {
    verdictCard("Write refused: writing is switched off", [
      ["From", from],
      ["To", to],
      ["Reason", String(error)],
      ["Device", "untouched"],
    ]);
    status(`Not written: ${String(error)}`, "warn");
    return;
  }

  status(`Asking for ${to} before touching it…`);
  const before = await awaitPatternKit(output, productId, destination);
  if (!before) {
    // The refusal `safeWriteRecords` makes, for the reason it gives: a device that has gone quiet
    // is exactly when a copy matters, so nothing is sent.
    verdictCard("Write refused — no copy of the destination", [
      ["To", to],
      ["Asked for it back", `nothing within ${VERIFY_TIMEOUT_MS}ms`],
      [
        "Reason",
        "the copy of what is about to be destroyed comes from this read. Without it there is no " +
          "undo, so nothing was sent.",
      ],
      ["Device", "untouched"],
    ]);
    status(`${to} did not answer, so nothing was sent.`, "error");
    return;
  }

  // Judged against the device's own blank, not ours.
  const emptiness = looksBlank(
    before,
    blankPatternKit(device, destination),
    device.slotIndexOffset,
    device.layout.patternSize + 8,
    16,
  );
  const occupancy = emptiness.blank
    ? "empty — matches the device's own blank exactly"
    : `HOLDS WORK — ${emptiness.differingBytes.toLocaleString()} bytes differ from a blank`;

  if (
    !(await askConfirm({
      title: `Copy pattern ${from} into slot ${to}?`,
      body: [
        `Destination ${to} is ${occupancy}.`,
        `This overwrites ${to} in the device's ACTIVE project. ${from} is unaffected.`,
        `${to} as it stands is saved to your machine first, as a .syx you can send straight back.`,
        "To undo: load another project on the device without saving. A write does not reach the " +
          "+Drive until you press SAVE PROJECT.",
      ],
      confirmLabel: `Overwrite ${to}`,
      danger: true,
    }))
  ) {
    return;
  }

  const log: [string, string][] = [
    ["From", from],
    ["To", to],
    ["Destination was", occupancy],
  ];

  /*
   * **The copy: after the question, before anything is sent.** `safeWriteFile` settled that order
   * for both halves of the reason — a backup downloaded for a write somebody then cancels is rude,
   * and a write that began before the copy was taken is worse. A failure here is a refusal rather
   * than a warning, because this file is the only undo the page offers.
   */
  const backup = buildRecordBackup(
    productId, device.name, [destination], new Map([[destination, before]]),
  );
  try {
    const saved = await saveBytesTo(backup.bytes, backup.name, "copies");
    status(`Copy of the destination saved to ${whereSaved(saved)}.`, savedTone(saved));
  } catch (error) {
    verdictCard("Write refused — the copy could not be saved", [
      ...log,
      ["Reason", String(error)],
      ["Device", "untouched"],
    ]);
    status(`The copy of ${to} could not be saved, so nothing was sent: ${String(error)}`, "error");
    return;
  }
  log.push(["Backup", `${backup.name} (${backup.bytes.length.toLocaleString()} bytes)`]);

  // Every line carries how long the write has been running. Two stalled runs on hardware reported
  // their last line at *different* steps, which no single code path explains — without elapsed
  // times there was no way to tell a wait that is running from a page that has stopped running at
  // all. A log that cannot distinguish those two is not a log.
  const startedAt = Date.now();
  const since = (): string => `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  const trace = (what: string, detail: string): void => {
    log.push([what, `${detail}  (${since()})`]);
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

  const thread = watchMainThread();
  const inbound = watchInbound(linkTo(output).input);
  trace("Sending", `${message.length.toLocaleString()} bytes to ${to}…`);
  try {
    output.send([...message]);
  } catch (error) {
    trace("Send failed", String(error));
    status(`The device rejected the message: ${String(error)}`, "error");
    return;
  }

  // **Let the device finish taking it in before asking it anything.** A request sent immediately
  // behind 114 KB of SysEx is dropped by a device still ingesting — the write lands and the reply
  // never comes, which is exactly how this looked on hardware.
  const settle = settleMsAfter(message.length, productId);
  trace("Settling", `${settle}ms before asking — the device is still taking it in`);
  const watched = watchVisibility();
  const settling = tickWhileWaiting(log, "Settling", () => verdictCard("Write in progress", log));
  await new Promise((resolve) => setTimeout(resolve, settle));
  settling();

  trace("Sent", `asking for ${to} back`);
  const waiting = tickWhileWaiting(log, "Waiting for the read-back", () => verdictCard("Write in progress", log));
  const readBack = await awaitPatternKit(output, productId, destination);
  waiting();
  // Stopped once and kept: calling it twice would detach the listener twice and re-measure, and the
  // row belongs in the log either way so both the verdict and the timeout card carry it.
  const hidden = watched();
  log.push(...timeGoesRow(thread(), inbound()));
  log.push(...hiddenRow(hidden));

  if (!readBack) {
    verdictCard("Write NOT verified — yet", [
      ...log,
      ["Read back", `nothing within ${VERIFY_TIMEOUT_MS}ms`],
      ["Means", unverifiedMeans(hidden.hiddenMs, false)],
    ]);
    status(`${to} written; no read-back yet.`, "warn");
    return;
  }

  // Compared against what was *sent*, not against the source: the slot index byte legitimately
  // differs between them, and comparing to the source would report that as a failure every time.
  const sent = parseMessage(message).payload;
  const verdict = verifyWrite(sent, readBack);

  /*
   * **Three outcomes, not two**, and the reasoning is in `writeverdict.ts` with its tests. A device
   * that overwrote and a device that refused both answer the read and both stay silent about the
   * write, so "did not match what we sent" is two situations wearing one label. Held against what
   * the slot contained *before*, the answer is unambiguous — and there is always a *before* now,
   * because the read that took the backup is that same record.
   */
  const outcome = writeOutcome(verdict.ok, verifyWrite(before, readBack).ok);
  const said = describeWrite(outcome, { from, to, ...(verdict.reason === undefined ? {} : { reason: verdict.reason }) });

  verdictCard(said.title, [
    ...log,
    ["Read back", `${readBack.length.toLocaleString()} bytes`],
    ["Result", said.result],
    ["Next", said.next],
  ]);
  status(said.message, said.level);
}

/** Ask for one patternKit and wait for it, tolerating a late reply. */
function awaitPatternKit(
  output: MIDIOutput, productId: number, objNr: number,
): Promise<Uint8Array | undefined> {
  return requestPatternKit(linkTo(output), productId, objNr);
}

// --- proving the link before believing a silence ---------------------------------------------------

/** Is anything we send reaching the device? See `storageio.ts` for why this exists. */
async function linkIsAlive(output: MIDIOutput): Promise<boolean> {
  return checkLink(linkTo(output), issue);
}

// --- listing the +Drive --------------------------------------------------------------------------

/**
 * Ask the device what is on its +Drive.
 *
 * The first use of the storage API — see `docs/device-storage.md`. **The responses were decoded
 * from Elektron Transfer's own traffic; the request is a reconstruction**, because Web MIDI let us
 * watch the device's half of that conversation and never Transfer's.
 *
 * Being wrong is cheap: it is a read, and the device answers a bad path with **`Invalid path`** in
 * as many words. So this is the rare case where guessing is the right move rather than a shortcut.
 *
 * Unlike the dump protocol, a listing states each entry's **position** in a 32-bit field — which is
 * the thing the 7-bit object number cannot do, and the reason a project browser is possible at all.
 */
$("lsSend").addEventListener("click", () => {
  listPath().catch((error: unknown) => {
    status(`Listing failed: ${String(error)}`, "error");
    verdictCard("Listing failed", [["Error", String(error)]]);
  });
});

async function listPath(): Promise<void> {
  const output = readyOutput("reply");
  if (!output) return;

  const path = $<HTMLInputElement>("lsPath").value;
  // The cursor half of the request has never been exercised. Transfer uses it — a 43-byte reply in
  // its capture reads `first 28, next 29, count 1`, which is a **page of one**, not the file stat
  // this page first took it for. If a non-zero start comes back echoed as `first`, the argument
  // encoding is confirmed past the bare path, which is what makes guessing `0x54` reasonable.
  const from = Number($<HTMLInputElement>("lsFrom").value) || 0;
  // **A start without a count asks for nothing**, which the device demonstrated twice: `first`
  // came back echoing 28 and `count` came back 0. So the two travel together or not at all.
  const count = Number($<HTMLInputElement>("lsCount").value) || 0;
  const log: [string, string][] = [
    ["Path", path || "(empty — the root)"],
    [
      "Sending",
      `API 0x${StorageCode.List.toString(16)}, path as a NUL-terminated string` +
        (count > 0 ? `, then u32 start ${from} and u32 count ${count}` : " (whole listing)"),
    ],
    ["Note", "a wrong path is answered 'Invalid path'"],
  ];
  verdictCard("Listing…", log);

  const listId = issue(nextListId++);
  const reply = await requestListing(
    linkTo(output),
    listId,
    path,
    count > 0 ? { start: from, count } : undefined,
    (error) => log.push(["Send failed", String(error)]),
  );

  // Silence, which must not be read as an empty directory — they are different answers and only
  // one of them is about the directory.
  if (!reply) {
    // The control that separates "it did not answer" from "we never spoke". Without it, both look
    // the same and the temptation is to record the more interesting one.
    showVerdict(
      verdictAfterSilence({
        what: "Listing",
        alive: await linkIsAlive(output),
        outcome: `nothing within ${LIST_TIMEOUT_MS}ms`,
        log,
        means:
          "this device does not implement the listing, or the request shape is wrong. A genuine " +
          "negative, worth recording.",
      }),
    );
    return;
  }

  try {
    const listing = parseListing(reply);
    const changed = diffAgainstPrevious(path, listing.entries);
    const rows: [string, string][] = [
      ...log,
      ["Entries", `${listing.entries.length}, starting at ${listing.first}`],
      ["Next cursor", String(listing.next)],
    ];
    if (changed) rows.push(["Changed since last list", changed]);

    for (const e of listing.entries.slice(0, 40)) {
      rows.push([
        `${String(e.index).padStart(4)}  ${e.kind === "directory" ? "dir " : "file"}`,
        `${e.name}${e.size !== undefined ? `  ${e.size.toLocaleString()} B` : ""}` +
          `${e.children !== undefined ? `  ${e.children} items` : ""}` +
          // Shown, because this is where the answer to "which project is loaded?" may be hiding.
          // These bytes are **not constant across projects**, and nothing yet explains why.
          `${e.trailer ? `  [${[...e.trailer].map(hex2).join(" ")}]` : ""}`,
      ]);
    }
    if (listing.entries.length > 40) rows.push(["…", `${listing.entries.length - 40} more`]);

    verdictCard(`${path || "/"} — ${listing.entries.length} entries`, rows);
    status(
      changed
        ? `${path || "/"}: ${changed}`
        : `${path || "/"}: ${listing.entries.length} entries. The storage API works.`,
      "ok",
    );
  } catch (error) {
    verdictCard("The device answered, but the listing did not decode", [
      ...log,
      ["Error", String(error)],
      ["Bytes", [...reply.subarray(0, 32)].map((b) => b.toString(16).padStart(2, "0")).join(" ")],
      ["Means", String(error).includes("Invalid path") ? "the path was wrong — the request shape is right, which is the bigger news" : "the response format differs from what was decoded"],
    ]);
    status(String(error), "warn");
  }
}

/**
 * Compare this listing against the last one of the same path, and remember this one.
 *
 * The comparison lives in `changes.ts` and takes both sides as arguments; the *remembering* is the
 * page's, because it is per-session state rather than a rule. Kept per path, so listing
 * `/soundbanks` in between does not destroy a `/projects` comparison.
 */
function diffAgainstPrevious(path: string, entries: readonly Entry[]): string | undefined {
  const key = path || "/";
  const before = previousListings.get(key);
  previousListings.set(key, [...entries]);
  return describeListingChange(before, entries);
}

/** The last listing seen for each path, so two lists can be compared without saving a capture. */
const previousListings = new Map<string, Entry[]>();

// --- asking the device about itself ---------------------------------------------------------------

/**
 * Send one API information code and show what came back, **diffed against the last answer**.
 *
 * The diff is the point. `0x03` answered Elektron Transfer with the same four bytes 1,991 times —
 * but every one of those samples was taken while Transfer sat idle, so a value that tracks the
 * loaded project would have looked exactly that constant. Ask, load another project, ask again.
 *
 * Built after nearly reaching for a workaround instead: `Try code` sends `0x6n` dump requests only,
 * so the two codes most likely to answer *"which project is loaded?"* were unreachable while we
 * considered fingerprinting project content to infer it. **Native first** —
 * `docs/device-probing.md` rule 0a-prime.
 */
$("askSend").addEventListener("click", () => {
  askDevice().catch((error: unknown) => {
    status(`Ask failed: ${String(error)}`, "error");
    verdictCard("Ask failed", [["Error", String(error)]]);
  });
});

async function askDevice(): Promise<void> {
  const output = readyOutput("reply");
  if (!output) return;

  const code = Number($<HTMLSelectElement>("askCode").value);
  const key = "";
  const known = INFORMATION_CODES.find((c) => c.code === code);
  const msgId = issue(nextListId++);
  const log: [string, string][] = [
    ["Asking", `API 0x${hex2(code)} ${known?.name ?? "?"}${known?.takesKey ? ` "${key}"` : ""}`],
    ["Known", known?.note ?? "—"],
  ];

  let frame: ApiFrame;
  try {
    frame = await apiTransport(output).request(
      informationRequest(msgId, code, key),
      msgId,
      LIST_TIMEOUT_MS,
    );
  } catch (error) {
    // A silence is evidence only when we know we spoke. Two conclusions in this project were built
    // on silences that may never have left the machine.
    showVerdict(
      verdictAfterSilence({
        what: `0x${hex2(code)}`,
        alive: await linkIsAlive(output),
        outcome: String(error),
        outcomeLabel: "Error",
        log,
        means: "a genuine negative worth recording: this device does not implement that code.",
      }),
    );
    return;
  }

  const body = hexBody(frame.body);
  const previous = previousAnswers.get(code);
  previousAnswers.set(code, body);

  verdictCard(`0x${hex2(code)} answered 0x${hex2(frame.code)}`, [
    ...log,
    ["Reply", describeApiReply(frame)],
    ["Bytes", body],
    ["Since last ask", describeAnswerChange(previous, body)],
  ]);
  status(
    answerIsNews(previous, body)
      ? `0x${hex2(code)} CHANGED since the last ask.`
      : `0x${hex2(code)} answered ${frame.body.length} bytes.`,
    "ok",
  );
}

/** The last answer seen for each code, so two asks can be compared without saving a capture. */
const previousAnswers = new Map<number, string>();

// --- reading a whole file off the +Drive ----------------------------------------------------------

/**
 * Open, read and close a stored file — the sequence, never a piece of it.
 *
 * **This is the control that froze a Digitone 1 twice**, and it is back on the page only because
 * the shape that made it unsafe is gone: `storagesession.ts` owns the sequence and sends the close
 * in a `finally`, so no path through this button can leak a handle. That is a real fix for a real
 * defect, and it is **not** a claim that the freeze is solved — see `openRequest` for the other,
 * likelier explanation, which is that our request body was five bytes short.
 *
 * So: the Digitone II first, a scratch project, and expect to power-cycle a Digitone 1.
 *
 * What it unlocks is the thing the expander actually needs. `0x6f` reads whatever project is
 * *open*; this reads any project **by slot**, which is what "choose a source and a target from the
 * device's list" requires.
 */
$("fileRead").addEventListener("click", () => {
  readFile().catch((error: unknown) => {
    status(`Read failed: ${String(error)}`, "error");
    verdictCard("Read failed", [["Error", String(error)]]);
  });
});

async function readFile(): Promise<void> {
  const output = readyOutput("reply");
  if (!output) return;
  // **One at a time.** Two presses produced two sessions numbering their messages from 1, on a
  // transport with a single reply slot, so each stole the other's answers — three opens all
  // answering message 1, and a "whose traffic is this" verdict that contradicted itself. A
  // sequence that owns a device handle is not something to have two of.
  if (readingFile) {
    status("A read is already running. Wait for it to close its handle.", "warn");
    return;
  }

  const path = $<HTMLInputElement>("filePath").value;
  const log: [string, string][] = [
    ["File", path],
    ["Sending", "0x54 open (path, NUL-terminated) → 0x55 read × n → 0x56 close"],
    ["Guaranteed", "the close is sent on every path, including a read that throws"],
    ["Path form", "/projects/<index> — the index from a listing, not the project's name"],
  ];
  verdictCard("Reading…", log);

  readingFile = true;
  $<HTMLButtonElement>("fileRead").disabled = true;
  const started = performance.now();
  try {
    const file = await readStoredFile(path, {
      transport: apiTransport(output),
      // A band of its own, never from 1. Ids that restart per session collide with the previous
      // session's — and with Transfer's, which numbers from the low hundreds.
      msgId: reserveMessageIds(IDS_FOR.wholeProject),
      onProgress: (chunks, bytes) => {
        // No honest denominator for a +Drive read — see `progress.ts`.
        bar.working(`Reading ${path}`);
        status(`Reading ${path}: ${chunks} chunks, ${describeBytes(bytes)}…`, "warn");
      },
    });

    const ms = Math.round(performance.now() - started);
    // Saved immediately and unconditionally. The bytes are the entire point of the exercise and
    // this control may not survive the next press on a Digitone 1.
    const saved = await saveBytesTo(
      file.bytes, `${path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+/, "")}_${file.bytes.length}B.bin`, "probe",
    );
    verdictCard(`${path} — ${file.bytes.length.toLocaleString()} bytes`, [
      ...log,
      ["Saved to", whereSaved(saved)],
      ["Chunks", `${file.chunks} (${ms} ms)`],
      ["Handle closed", file.closed ? "yes, acknowledged" : "NOT acknowledged — the read still succeeded"],
      ["First bytes", [...file.bytes.subarray(0, 16)].map(hex2).join(" ")],
      // The one field that says what we have. A `.dnprj` opens `PK` and a raw image does not.
      ["Looks like", looksLikeZip(file.bytes) ? "a project file (PK header)" : "not a ZIP — raw or something else"],
      ["Metadata reply", file.metadata ? [...file.metadata].map(hex2).join(" ") : "none arrived"],
      // **The write question, answered by a read.** The device reports a checksum per chunk, so if
      // `driveChecksum` reproduces each one over its own slice, we can compute what a written chunk
      // should carry instead of only ever echoing a value the device gave us for a whole small
      // file. That is the difference between writing a 364-byte preset and writing a project.
      ...describeChunkChecksums(file),
      ["Before reading again", "check the saved file"],
    ]);
    status(`Read ${path}: ${file.bytes.length.toLocaleString()} bytes in ${file.chunks} chunks.`, "ok");
  } catch (error) {
    // The link check is the difference between "the device refused" and "we never spoke", and it
    // matters more here than anywhere: a silence from this message previously meant a dead device.
    showVerdict(
      verdictAfterSilence({
        what: "The read",
        alive: await linkIsAlive(output),
        outcome: String(error),
        outcomeLabel: "Error",
        log,
        means: "a genuine negative, worth recording — the request shape or the sequence is wrong.",
        canFreeze: true,
      }),
    );
  } finally {
    // Whatever happened, the handle is released by now and the next press is safe.
    bar.done();
    readingFile = false;
    $<HTMLButtonElement>("fileRead").disabled = false;
  }
}

/** True while a read owns a device handle. See the guard in `readFile`. */
let readingFile = false;

/**
 * What the chunk box falls back to, matching `storagewrite.ts`'s own default.
 *
 * Stated here rather than imported, because the two are the same number for different reasons: that
 * one is what the write path does when nobody chooses, this one is what the *form* shows. If the
 * transport's default ever changes, this should not silently follow it — a probe control that moves
 * when you are not looking is the opposite of an instrument.
 */
const DEFAULT_PROBE_CHUNK = 2048;

// Ids come from the page's one allocator now. This file used to keep its own band scheme, and
// `devicesource.ts` kept a second one — the same idea implemented twice and shared with nothing,
// which is how the library came to collide at id 1. See `messageids.ts`.

/**
 * **The first write to a Digitone's +Drive**, and the experiment that unblocks the rest.
 *
 * Reads `file`, then writes those exact bytes to `to` with the checksum the device reported on the
 * read — so the one field whose algorithm we cannot reproduce comes from the device itself.
 *
 * With **corrupt** ticked it flips a bit in that checksum. Refused means the field is validated and
 * we need the algorithm; accepted means it is decorative and arbitrary content can be written. That
 * question is worth more than this write is.
 *
 * The destination is looked up in a real listing and **refused unless empty**. Not warned about:
 * for most people the +Drive is the only copy of that work.
 */
$("fileWrite").addEventListener("click", () => {
  readThenWrite().catch((error: unknown) => {
    status(`Write failed: ${String(error)}`, "error");
    verdictCard("Write failed", [["Error", String(error)]]);
  });
});

async function readThenWrite(): Promise<void> {
  const output = readyOutput("readback");
  if (!output) return;
  if (readingFile) {
    status("A read is already running. Wait for it to close its handle.", "warn");
    return;
  }

  const source = $<HTMLInputElement>("filePath").value;
  const target = $<HTMLInputElement>("writeTarget").value;
  const corrupt = $<HTMLInputElement>("corruptSum").checked;
  // Read as a number and sanity-checked here rather than trusted from the input: `min`/`max` on a
  // number field are advisory, and a chunk size of 0 would loop forever slicing nothing.
  const typed = Number($<HTMLInputElement>("chunkSize").value);
  const chunkSize = Number.isInteger(typed) && typed >= 16 ? typed : DEFAULT_PROBE_CHUNK;
  const log: [string, string][] = [
    ["Reading", source],
    ["Writing to", target],
    ["Checksum", corrupt ? "DELIBERATELY WRONG — testing whether it is enforced" : "the device's own, from the read"],
    ["Chunk size", `${chunkSize} bytes per 0x58`],
    ["Guard", "the destination must be empty in a fresh listing, or nothing is sent"],
  ];
  verdictCard("Writing…", log);

  readingFile = true;
  $<HTMLButtonElement>("fileWrite").disabled = true;
  // Hoisted so the failure path can say whether this was a multi-chunk attempt. `file` is scoped to
  // the `try`, and a refusal is exactly when the difference between one chunk and six matters most.
  let sourceLength = 0;
  // **Whether a write was ever attempted**, which is not the same as whether this function failed.
  // The first run of this card reported "a refusal on a MULTI-CHUNK write" for a failure in the
  // *read*, before a single byte went out — the verdict keyed off the chunk arithmetic alone and
  // read as evidence about chunking when it was evidence about nothing.
  let wroteAnything = false;
  // Whether a chunk actually left for the device. A refusal from DNX's own guards happens after
  // `wroteAnything` and before this, and is not the instrument's to explain.
  let sentAnything = false;
  try {
    // The destination's own directory, listed now rather than trusted from earlier. A listing from
    // ten minutes ago is not evidence about what is in a slot at the moment of writing.
    const slash = target.lastIndexOf("/");
    const directory = target.slice(0, slash);
    const index = Number(target.slice(slash + 1));
    const listing = await listProjectsAt(output, directory);
    const entry = listing.find((e) => e.index === index);
    if (!entry) {
      throw new Error(`${target} is not in ${directory} — that listing has ${listing.length} entries`);
    }

    const file = await readStoredFile(source, {
      transport: apiTransport(output),
      // **Stored form, the only form a write accepts.** Read raw, /soundbanks/H/1 came back as 407
      // uncompressed bytes and `refuseRawForm` refused the copy every time, so this control could
      // not copy any file. Found in the first release test run, 2026-09-14.
      form: STORED_FORM,
      msgId: reserveMessageIds(IDS_FOR.wholeProject),
    });
    sourceLength = file.bytes.length;

    // **`undefined` is the right answer here now.** The write computes each chunk's own checksum,
    // which is what the device reports on a read and what it evidently wants back.
    //
    // This used to demand `file.checksum` and refuse without it — reasonable when the whole file's
    // value was the only thing a write could send, and the reason the first attempt at a six-chunk
    // write never left the page: a multi-chunk read deliberately reports no whole-file checksum,
    // so requiring one ruled out exactly the case being tested.
    //
    // Corruption still needs a single number to force onto every chunk. Taken from the read when
    // there is one, and from our own arithmetic when there is not, so the experiment is available
    // for a file of any size rather than only for one that fits in a chunk.
    const corruptFrom = file.checksum ?? driveChecksum(file.bytes);
    const checksum = corrupt ? ((corruptFrom ^ 1) >>> 0) : undefined;
    wroteAnything = true;
    // Through `safeWriteFile` like every other write in the codebase — the confirmation and the
    // read-back are not optional here either. **The read-back is skipped only for the corruption
    // run**, where the write is meant to be refused and a verifying read would report a failure
    // that is the finding rather than a fault.
    // Nothing reaches an instrument until somebody arms the switch. Thrown before a byte is
    // sent, so a control the page forgot to gate still cannot write. See `writeenable.ts`.
    requireWriteEnabled();
    const result = await safeWriteFile({
      transport: apiTransport(output),
      path: target,
      name: source,
      bytes: file.bytes,
      target: entry,
      confirm: confirmFileWrite,
      ...(checksum === undefined ? {} : { checksum }),
      chunkSize,
      msgId: reserveMessageIds(IDS_FOR.wholeProject),
      verifyMsgId: reserveMessageIds(IDS_FOR.wholeProject),
      skipVerify: corrupt,
      onStatus: (message) => status(message),
      onProgress: (written, total, stage) => {
        if (stage === "write" && written > 0) sentAnything = true;
        bar.at(written, total, `${STAGE_LABEL[stage]} ${target}`);
        status(`${STAGE_LABEL[stage]} ${target}: ${describeBytes(written)} of ${describeBytes(total)}…`);
      },
    });
    if (result.cancelled) {
      status("Not written.", "warn");
      verdictCard("Write cancelled", [...log, ["Sent", "nothing"]]);
      return;
    }

    verdictCard(`${target} — ${result.committed ? "COMMITTED" : "not committed"}`, [
      ...log,
      [
        "Read",
        `${file.bytes.length.toLocaleString()} bytes in ${file.chunks} chunk(s)` +
          (file.checksum === undefined ? "" : `, whole-file checksum ${hex8(file.checksum)}`),
      ],
      [
        "Sent",
        `${result.written.toLocaleString()} bytes in ${result.chunks} chunk(s), ` +
          (checksum === undefined
            ? "each chunk carrying its own checksum"
            : `${hex8(checksum)} forced onto every chunk`),
      ],
      ["Committed", result.committed ? "yes — 0x59 acknowledged" : "NO"],
      [
        "Verified",
        corrupt
          ? "not checked — a corruption run is expected to be refused, so a read-back would " +
            "report the finding as a fault"
          : result.verified
            ? `yes — read back and byte-identical, allowing for the slot index the device stamps ` +
              `at +${CONTAINER_SLOT_OFFSET}`
            : `NO — ${result.mismatches.map((m) => m.reason).join("; ")}`,
      ],
      [
        "Means",
        corrupt
          ? "the device ACCEPTED a wrong checksum, so the field is not validated and arbitrary " +
            "content can be written. Check the slot on the instrument before believing it."
          : result.chunks > 1
            ? `a MULTI-CHUNK write was accepted — ${result.chunks} chunks, each carrying the ` +
              `whole file's checksum. That is the open question in storagewrite.ts answered: the ` +
              `field is per file, not per chunk, so a project of ~6,294 chunks has no new ` +
              `unknown in its way.` +
              (result.verified ? " The read-back above confirms it." : " The read-back does NOT confirm it.")
            : result.verified
              ? "the write sequence works, and the file on the +Drive is the file we sent — the " +
                "read-back is the proof, not the acknowledgement."
              : "the device acknowledged the commit and the read-back disagrees with what was " +
                "sent. An acknowledgement was never the same as bytes on the +Drive; this is what " +
                "that looks like.",
      ],
    ]);
    status(`${target} written and committed. Verify it on the instrument.`, "ok");
  } catch (error) {
    if (wroteAnything && !sentAnything) {
      /*
       * **Refused here, so said here.** This path used to run the silence verdict, which checks the
       * link and titles the card "no answer, and the link is proven", then ends "a genuine refusal.
       * The device's own wording…". The raw-form refusal it was describing came from DNX before a
       * single chunk was sent; the instrument was never asked.
       */
      showVerdict({
        title: "The write — refused by DNX before anything was sent",
        rows: [
          ...log,
          ["Error", String(error)],
          ["Sent", "nothing — the instrument was not asked"],
          ["Means", "one of DNX's own checks stopped the write. The error above says which, and what to change."],
        ],
        message: `Not written: ${String(error)}`,
        level: "warn",
      });
      return;
    }
    showVerdict(
      verdictAfterSilence({
        what: "The write",
        alive: await linkIsAlive(output),
        outcome: String(error),
        outcomeLabel: "Error",
        log,
        means: !wroteAnything
          ? "this failed BEFORE any write was attempted, so it says nothing about writing at all — " +
            "read the error as being about the read, the listing or the guard."
          : corrupt
            ? "if that refusal names the checksum, the field IS validated — which is the answer we " +
              "wanted and the reason to try it."
            : sourceLength > chunkSize
              ? "a refusal on a MULTI-CHUNK write, where the same bytes at one chunk succeed, says " +
                "the whole-file checksum is not what a second chunk should carry — try per-chunk " +
                "next. Run the one-chunk control before concluding that: a refusal that happens at " +
                "any chunk size is about something else entirely."
              : "a genuine refusal. The device's own wording is the best documentation this protocol has.",
        canFreeze: true,
      }),
    );
  } finally {
    bar.done();
    readingFile = false;
    $<HTMLButtonElement>("fileWrite").disabled = false;
  }
}

/**
 * List one directory and hand back its entries, for checking a destination is empty.
 *
 * Throws on silence rather than returning nothing, because its caller is about to **write**: a
 * destination that could not be listed must stop the write, and an empty array would read as
 * "nothing in the way".
 */
async function listProjectsAt(output: MIDIOutput, path: string): Promise<Entry[]> {
  const reply = await requestListing(linkTo(output), issue(nextListId++), path, undefined);
  if (!reply) throw new Error(`no answer listing ${path} — refusing to treat that as empty`);
  // Whole or refused. A write deciding "nothing in the way" from part of a directory is the
  // one use of a partial listing that costs somebody a project.
  return wholeListing({ body: reply }, path).entries;
}



/** A `.dnprj` and a `.dn2prj` are both ZIPs, so this says whether we got a project file at all. */
/**
 * Web MIDI as an `ApiTransport`.
 *
 * The correlation lives in `devicelink.ts` and is shared with the manager's device source. This
 * page's own contribution is `issue`: the id is recorded as ours **before** the send, so a reply
 * cannot arrive before its id is known. Omitting that is why a capture of 6,404 of our own reads
 * was once labelled `Not ours: 8192, 8193, …` — the verdict was confidently wrong about traffic we
 * had just generated.
 */
function apiTransport(output: MIDIOutput): ApiTransport {
  return linkTo(output).transport({ onSend: issue });
}

/** Message ids start high, the way elk-herd stays out of Transfer's numbering. */
let nextListId = 30_000;


// --- trying an unidentified request code ---------------------------------------------------------

/**
 * Ask the device about a dump type nobody has identified, one at a time.
 *
 * The question behind it: **Transfer writes projects into chosen slots on a Digitone, so some
 * mechanism exists.** It is probably not the SysEx file API — project storage on both machines is
 * a flat indexed list rather than a filesystem, which is exactly the shape the *dump* protocol
 * already addresses. Nine or ten dump types are unidentified, and that is where a project object
 * would sit.
 *
 * Everything sent here is a `0x6n` request with an empty body — same shape and same argument as
 * the five already proven. That argument is inference rather than certainty, so the discipline is
 * the safeguard: **a scratch project, one code per press, a look at the device in between.** There
 * is no sweep-all button, deliberately.
 */
function fillProbeCodes(advertised: readonly number[]): void {
  const select = $<HTMLSelectElement>("probeCode");
  select.innerHTML = codesUnderTest(advertised)
    .map((c) => {
      const label = c.known
        ? `${hex(c.code)} → ${hex(c.response)}  ${c.known} (control)`
        : `${hex(c.code)} → ${hex(c.response)}  unknown${c.advertised ? ", advertised" : ""}`;
      return `<option value="${c.code}">${escapeHtml(label)}</option>`;
    })
    .join("");
  const usable = advertised.length > 0;
  select.disabled = !usable;
  $<HTMLInputElement>("probeObj").disabled = !usable;
  $<HTMLButtonElement>("probeSend").disabled = !usable;
}

$("probeSend").addEventListener("click", () => {
  tryUnknownCode().catch((error: unknown) => {
    status(`Could not try that code: ${String(error)}`, "error");
  });
});

async function tryUnknownCode(): Promise<void> {
  const ready = readyDump("reply");
  if (!ready) return;
  const { output, productId } = ready;

  const code = Number($<HTMLSelectElement>("probeCode").value);
  const objNr = Number($<HTMLInputElement>("probeObj").value);
  const info = codesUnderTest([]).find((c) => c.code === code)!;

  if (
    !info.known &&
    !(await askConfirm({
      title: `Send ${hex(code)}, an unidentified request, object ${objNr}?`,
      body: [
        "It carries an empty body, like every request already proven on both machines — so by " +
          "that convention it asks rather than stores. That is an inference, not a certainty.",
        "Load a scratch project first, and check the device after this returns.",
      ],
      confirmLabel: `Send ${hex(code)}`,
      danger: true,
    }))
  ) {
    return;
  }

  const log: [string, string][] = [
    ["Sent", `${hex(code)} object ${objNr}, empty body`],
    ["Expecting", `${hex(code - 0x10)} by the +0x10 convention, if it answers at all`],
    ["Known as", info.known ?? "nothing — no source names this code"],
  ];
  verdictCard("Trying a code", log);

  // Anything at all counts, not only the predicted response: an unknown request answering with an
  // unexpected code would be the most interesting outcome available, and matching strictly on the
  // convention would throw it away.
  const reply = await tryCode(linkTo(output), productId, code, objNr, (error) =>
    log.push(["Send failed", String(error)]),
  );

  if (!reply) {
    // **This is the check whose absence voided a whole afternoon.** A run of silences was recorded
    // as "not implemented" while Elektron Transfer held the output port, so those requests may
    // never have been sent at all. The control makes a negative worth something.
    showVerdict(
      verdictAfterSilence({
        what: hex(code),
        alive: await linkIsAlive(output),
        outcome: `nothing within ${UNKNOWN_TIMEOUT_MS}ms`,
        log,
        means:
          "the link is proven, so this is a real negative: the code is not implemented, or it " +
          "wants an argument we did not send. Worth recording.",
      }),
    );
    return;
  }

  const described = describeReply(
    code,
    reply.dumpType,
    reply.objNr,
    reply.payload.length,
    reply.storedChecksum === reply.computedChecksum,
    KNOWN_RECORD_SIZES,
  );

  verdictCard(`${hex(code)} ANSWERED with ${hex(described.dumpType)}`, [
    ...log,
    [
      "Answered",
      `${hex(described.dumpType)}${described.asExpected ? " — as the convention predicts" : " — NOT the predicted code"}`,
    ],
    ["Object", String(described.objNr)],
    ["Payload", `${described.payloadBytes.toLocaleString()} bytes`],
    ["Resembles", described.resembles ?? "no record size we know — this is something new"],
    ["Checksum", described.checksumOk ? "good" : "BAD"],
    ["Next", "Save the capture and check the device screen before trying another code."],
  ]);
  status(
    `${hex(code)} answered ${hex(described.dumpType)}, ${described.payloadBytes.toLocaleString()} bytes.`,
    "ok",
  );
}

/** The write verdict, into the element this page reserves for it. */
function verdictCard(title: string, rows: [string, string][]): void {
  drawVerdict($("writeResult"), title, rows);
}

/**
 * Draw a verdict and say the same thing in the status bar.
 *
 * Both halves come from one object, so the card and the line under it cannot disagree — which they
 * could when each call site wrote them out separately, and twice did.
 */
function showVerdict(
  verdict: Verdict,
  into: (title: string, rows: [string, string][]) => void = verdictCard,
): void {
  into(verdict.title, verdict.rows);
  status(verdict.message, verdict.level);
}

/** Supported messages, with this page's hex formatter. */
function messageCard(into: HTMLElement, codes: readonly number[]): void {
  drawMessages(into, codes, hex);
}

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
