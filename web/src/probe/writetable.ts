/**
 * Sending a wavetable from this computer to a `/waverider` slot.
 *
 * **One job, and it is the only control in DNX that sends a file from disk to the instrument.**
 * Everything else moves bytes the device already has: `drivefile.ts` reads a slot and writes it
 * elsewhere, `writeback.ts` and `writeslot.ts` return captured records, and the manager writes a
 * project it opened. A wavetable has never been on the instrument, so it has to come from a file,
 * and until this existed there was no way to put one there.
 *
 * ## What it adds to the bytes, and why none of it is optional
 *
 * The chosen file is raw samples. `buildSlotFile` wraps it with its 128-byte index entry and the
 * container the route expects, and **computes the table hash from the bytes rather than accepting
 * one**, because the device's commit cannot refuse: a table whose hash disagrees with its entry
 * gets `commit ok` and writes nothing. Measured on slot 9 by the firmware session.
 *
 * `writeTableToSlot` then does the sequence every other write here does — gate, confirm, refuse an
 * occupied slot, send, read back and compare — and adds the one check the generic path cannot
 * make: **it re-lists the directory afterwards and requires the slot to be occupied.** A successful
 * commit is not evidence on this route.
 *
 * ## Geometry is typed, not guessed
 *
 * A length cannot tell 16 x 512 from 32 x 256, and the player cuts the table up by those two
 * numbers, so a wrong pair is a table read as something else entirely. The boxes default to the
 * only geometry the pool currently loads and `buildSlotFile` refuses a pair that does not measure
 * the file.
 */

import { status } from "./chrome.js";
import { apiTransport } from "./link.js";
import { readyOutput } from "./ready.js";
import { verdictCard } from "./verdicts.js";
import { $ } from "../dom.js";
import { requireWriteEnabled } from "../writeenable.js";
import { confirmFileWrite } from "../safewriteui.js";
import { pageMessageIds } from "../messageids.js";
import { writeTableToSlot } from "@noiseandmatter/dnx-core/device/waveriderwrite.js";
import { type PendingSlot } from "@noiseandmatter/dnx-core/waverider/slotfile.js";
import { unplayableReason } from "@noiseandmatter/dnx-core/waverider/pool.js";
import { askPlayableBounds } from "./waveriderbounds.js";
import { xxHash32 } from "@noiseandmatter/dnx-core/waverider/xxhash32.js";

/**
 * The `PendingSlot` for one already-converted file.
 *
 * Exported because the batch control builds the same thing for each of its files, and a second
 * copy of *what a table's index entry says about itself* is how two controls come to disagree
 * about the gain or the source hash. The hash is still computed inside `buildSlotFile`; this only
 * records what the table was made from.
 */
export function pendingFrom(
  table: Uint8Array,
  slot: number,
  name: string,
  waves: number,
  points: number,
): PendingSlot {
  return {
    slot,
    name,
    waves,
    points,
    interpolate: true,
    table,
    // The file is already converted samples, so nothing was scaled and the source is the table
    // itself. A gain of 1 says "no level change applied", which is the truth here.
    sourceHash: xxHash32(table),
    sourceSize: table.length,
    gain: 1,
  };
}

let writing = false;

$("tableWrite").addEventListener("click", () => {
  writeTable().catch((error: unknown) => {
    status(`Table write failed: ${String(error)}`, "error");
    verdictCard("Table write failed", [["Error", String(error)]]);
  });
});

async function writeTable(): Promise<void> {
  const output = readyOutput("readback");
  if (!output) return;
  if (writing) {
    status("A table write is already running.", "warn");
    return;
  }

  const picked = $<HTMLInputElement>("tableFile").files?.[0];
  if (!picked) {
    status("Choose a table file first — this control sends a file, not a slot.", "warn");
    return;
  }

  const slot = Number($<HTMLInputElement>("tableSlot").value);
  const waves = Number($<HTMLInputElement>("tableWaves").value);
  const points = Number($<HTMLInputElement>("tablePoints").value);
  const name = $<HTMLInputElement>("tableName").value.trim();

  const table = new Uint8Array(await picked.arrayBuffer());
  // Asked before the card is built, so "will it play" is this build's answer rather than the rule
  // of the builds that came before it.
  const playable = await askPlayableBounds(output);
  const unplayable = unplayableReason({ waves, points }, playable.bounds);

  verdictCard("Writing a table…", [
    ["File", `${picked.name} — ${table.length.toLocaleString()} bytes`],
    ["To", `/waverider/${slot}`],
    ["Name", name],
    ["Geometry", `${waves} x ${points}`],
    ["Hash", `0x${xxHash32(table).toString(16).padStart(8, "0")} — computed here, not taken`],
    ["The pool plays", playable.why],
    ["Will it play", unplayable ?? "yes, the pool loads this geometry"],
    ["Guard", "the slot must be empty in a fresh listing, and the listing must show it afterwards"],
  ]);

  writing = true;
  $<HTMLButtonElement>("tableWrite").disabled = true;
  try {
    const result = await writeTableToSlot({
      transport: apiTransport(output),
      host: {
        ids: pageMessageIds,
        // Handed over rather than called here. `safeWriteFile` requires its own and will not take
        // a caller's word that one was consulted, which is what keeps a control that forgot to
        // gate from writing anyway.
        gate: requireWriteEnabled,
        confirm: confirmFileWrite,
      },
      table: pendingFrom(table, slot, name, waves, points),
      ...(playable.bounds === undefined ? {} : { playable: playable.bounds }),
      onStatus: (message) => status(message),
      timeoutMs: 60_000,
    });

    if (result.cancelled) {
      status("Cancelled — nothing was sent.", "warn");
      verdictCard("Cancelled", [["Sent", "nothing"]]);
      return;
    }

    const rows: [string, string][] = [
      ["Sent", `${result.written.toLocaleString()} bytes to /waverider/${result.slot}`],
      ["Commit", result.committed ? "answered ok" : "did not answer ok"],
      ["Listed after", result.listed ? `yes — "${result.listedAs ?? ""}"` : "NO — the slot is still empty"],
      ["Read back", result.verified ? "identical" : "differs"],
      ["Will it play", result.unplayable ?? "yes, once the pool refills"],
    ];
    if (result.problem) rows.push(["Problem", result.problem]);

    verdictCard(result.problem ? "Table write FAILED" : "Table written", rows);
    status(
      result.problem
        ? `Table write failed: ${result.problem}`
        : `Slot ${result.slot} written, listed and verified.`,
      result.problem ? "error" : "ok",
    );
  } finally {
    writing = false;
    $<HTMLButtonElement>("tableWrite").disabled = false;
  }
}
