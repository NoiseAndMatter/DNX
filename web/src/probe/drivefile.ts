/**
 * Whole files off the +Drive, and the one write back onto it.
 *
 * Reading is the settled path: open by index, read by sequence, close, and the bytes have matched a
 * file taken off the device by other means. The chunk size is a control rather than a constant,
 * because what the device accepts is part of what this page exists to find out.
 *
 * ## The write is an experiment, and says so
 *
 * It reads a file, then writes those exact bytes to another path **with the checksum the device
 * reported on the read** — so the one field whose algorithm we cannot reproduce comes from the
 * device itself. Refused means we need the algorithm; accepted means the field is decorative and
 * arbitrary content can be written. That question is worth more than the write is.
 *
 * The destination is looked up in a real listing and refused unless empty. Not warned about: for
 * most people the +Drive is the only copy of that work.
 */

import { listing } from "./cards.js";
import { bar, status } from "./chrome.js";
import { describeChunkChecksums, hex2, hex8, looksLikeZip } from "./format.js";
import { apiTransport, issue, linkIsAlive, linkTo } from "./link.js";
import { readyOutput } from "./ready.js";
import { verdictAfterSilence } from "./silence.js";
import { requestListing } from "./storageio.js";
import { showVerdict, verdictCard } from "./verdicts.js";
import { $ } from "../dom.js";
import { safeWriteFile } from "@noiseandmatter/dnx-core/device/safewrite.js";
import {
  driveChecksum,
  type Entry,
  STORED_FORM,
  wholeListing,
} from "@noiseandmatter/dnx-core/device/storage.js";
import { readStoredFile } from "@noiseandmatter/dnx-core/device/storagesession.js";
import { CONTAINER_SLOT_OFFSET } from "@noiseandmatter/dnx-core/project/container.js";
import { saveBytesTo, whereSaved } from "../dnxfolder.js";
import { IDS_FOR, reserveMessageIds } from "../messageids.js";
import { describeBytes } from "../progress.js";
import { confirmFileWrite, STAGE_LABEL } from "../safewriteui.js";
import { requireWriteEnabled } from "../writeenable.js";

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
    const result = await safeWriteFile({
      // Nothing reaches an instrument until somebody arms the switch. Handed over rather than
      // called here: `safeWriteFile` requires one and throws it before anything is sent, so a
      // control the page forgot to gate still cannot write. See `writeenable.ts`.
      gate: requireWriteEnabled,
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
export async function listProjectsAt(output: MIDIOutput, path: string): Promise<Entry[]> {
  const reply = await requestListing(linkTo(output), issue(reserveMessageIds(IDS_FOR.oneMessage)), path, undefined);
  if (!reply) throw new Error(`no answer listing ${path} — refusing to treat that as empty`);
  // Whole or refused. A write deciding "nothing in the way" from part of a directory is the
  // one use of a partial listing that costs somebody a project.
  return wholeListing({ body: reply }, path).entries;
}
