/**
 * The +Drive, listed, and the device, asked about itself.
 *
 * The first use of the storage API — see `docs/device-storage.md`. **The responses were decoded
 * from Elektron Transfer's own traffic; the request is a reconstruction**, because Web MIDI let us
 * watch the device's half of that conversation and never Transfer's.
 *
 * Being wrong is cheap: these are reads, and the device answers a bad path with **`Invalid path`**
 * in as many words. So this is the rare case where guessing is the right move rather than a
 * shortcut.
 *
 * Unlike the dump protocol, a listing states each entry's **position** in a 32-bit field — which is
 * the thing the 7-bit object number cannot do, and the reason a project browser is possible at all.
 * Both halves remember their last answer, so a second press says what changed rather than repeating
 * itself.
 */

import { listing } from "./cards.js";
import { answerIsNews, describeAnswerChange, describeListingChange } from "./changes.js";
import { status } from "./chrome.js";
import { hex2 } from "./format.js";
import { apiTransport, issue, linkIsAlive, linkTo } from "./link.js";
import { readyOutput } from "./ready.js";
import { verdictAfterSilence } from "./silence.js";
import { LIST_TIMEOUT_MS, requestListing } from "./storageio.js";
import { showVerdict, verdictCard } from "./verdicts.js";
import { $ } from "../dom.js";
import { type ApiFrame } from "@noiseandmatter/dnx-core/device/api.js";
import {
  describeApiReply,
  hexBody,
  INFORMATION_CODES,
  informationRequest,
} from "../../../src/research/apiprobe.js";
import { type Entry, parseListing, StorageCode } from "@noiseandmatter/dnx-core/device/storage.js";
import { IDS_FOR, reserveMessageIds } from "../messageids.js";

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

  const listId = issue(reserveMessageIds(IDS_FOR.oneMessage));
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
  const msgId = issue(reserveMessageIds(IDS_FOR.oneMessage));
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
