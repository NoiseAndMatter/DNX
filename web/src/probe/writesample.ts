/**
 * Sending a sample from this computer to the Bloom prototype's `/samples` store.
 *
 * **Local only: Bloom is not released.** The store is `device/samplestore.ts`. This control picks a
 * file, converts it with the same import the sample library uses, and hands it to
 * `BloomSampleStore.put`. That does the sequence every write here does: gate, confirm, send, read
 * back and compare. Then it adds the proof this route needs, which is `/samples/index` holding the
 * sample's identity and payload hash.
 *
 * The firmware allocates, so the card shows where the sample landed only after the write.
 * A Bloom track's SMPL value plays the entry of that number, and entries above 127 cannot be
 * played yet, so the card says so.
 *
 * "List samples" reads `/samples/index` and nothing else, so it needs no WRITE switch.
 */

import { status } from "./chrome.js";
import { apiTransport } from "./link.js";
import { readyOutput } from "./ready.js";
import { verdictCard } from "./verdicts.js";
import { $ } from "../dom.js";
import { requireWriteEnabled } from "../writeenable.js";
import { confirmFileWrite } from "../safewriteui.js";
import { pageMessageIds } from "../messageids.js";
import { whileWriting } from "../writing.js";
import { BloomSampleStore } from "@noiseandmatter/dnx-core/device/samplestore.js";
import { importAudioFile } from "@noiseandmatter/dnx-core/sample/importfile.js";
import { sampleKey } from "@noiseandmatter/dnx-core/sample/identity.js";
import { payloadBytes } from "@noiseandmatter/dnx-core/sample/blsm.js";

/** The highest entry a Bloom track's SMPL value can reach in the prototype. */
const PLAYABLE_ENTRIES = 128;

let busy = false;

function store(output: MIDIOutput, name: string): BloomSampleStore {
  return new BloomSampleStore({
    transport: apiTransport(output),
    host: { ids: pageMessageIds, gate: requireWriteEnabled, confirm: confirmFileWrite },
    nameFor: () => name,
    // This control never deletes.
    confirmDelete: () => false,
    onStatus: (message) => status(message),
    timeoutMs: 60_000,
  });
}

function fail(what: string) {
  return (error: unknown): void => {
    status(`${what} failed: ${String(error)}`, "error");
    verdictCard(`${what} FAILED`, [["Error", String(error)]]);
  };
}

$("sampleList").addEventListener("click", () => {
  listSamples().catch(fail("Sample list"));
});

$("sampleWrite").addEventListener("click", () => {
  writeSample().catch(fail("Sample write"));
});

async function listSamples(): Promise<void> {
  const output = readyOutput("readback");
  if (!output || busy) return;
  busy = true;
  try {
    const index = await store(output, "").readIndex();
    const rows: [string, string][] = [
      ["Store", index.superblock ? `generation ${index.superblock.generation}, ${index.entries.length} of 1,024 entries used` : "empty, never written"],
    ];
    for (const e of index.entries) {
      rows.push([
        `/samples/${e.n}`,
        `"${e.name}", ${e.channels === 1 ? "mono" : "stereo"}, ${(e.frames / 48_000).toFixed(2)} s, ` +
          `${payloadBytes(e).toLocaleString()} bytes, start 0x${e.startSector.toString(16)}`,
      ]);
    }
    verdictCard("Bloom samples", rows);
    status(`${index.entries.length} samples in /samples.`, "ok");
  } finally {
    busy = false;
  }
}

async function writeSample(): Promise<void> {
  const output = readyOutput("readback");
  if (!output) return;
  if (busy) {
    status("A sample operation is already running.", "warn");
    return;
  }
  const picked = $<HTMLInputElement>("sampleFile").files?.[0];
  if (!picked) {
    status("Choose a WAV or AIFF file first.", "warn");
    return;
  }

  const imported = importAudioFile(new Uint8Array(await picked.arrayBuffer()), {
    ...($<HTMLInputElement>("sampleMono").checked ? { channels: "mono" as const } : {}),
    ...($<HTMLInputElement>("sampleNormalise").checked ? { normalise: true } : {}),
  });
  const { sample, id, report } = imported;
  const name = $<HTMLInputElement>("sampleName").value.trim() || picked.name.replace(/\.[^.]+$/, "");

  verdictCard("Writing a sample…", [
    ["File", `${picked.name}: ${report.sourceChannels} ch, ${report.sourceRate} Hz, ${report.sourceFormat}`],
    ["Stored as", `${sample.channels === 1 ? "mono" : "stereo"}, 48 kHz, ${(sample.frames / 48_000).toFixed(2)} s, ${id.size.toLocaleString()} bytes`],
    ["Identity", sampleKey(id)],
    ["Name", name],
    ["Guard", "the lowest free entry in /samples/index, and the index must hold the sample afterwards"],
  ]);

  busy = true;
  $<HTMLButtonElement>("sampleWrite").disabled = true;
  try {
    const s = store(output, name);
    const outcome = await whileWriting(() =>
      s.put(id, sample, (sent, total) => status(`Sending ${Math.round((100 * sent) / total)} %…`)),
    );
    const entry = (await s.readIndex()).entries.find((e) => e.identityHash === id.hash);
    if (!entry) throw new Error("the write finished and /samples/index does not hold the sample");
    const playable = entry.n < PLAYABLE_ENTRIES ? `yes: set SMPL to ${entry.n} on a Bloom track` : `no: SMPL reaches entries 0..${PLAYABLE_ENTRIES - 1}`;
    verdictCard(outcome === "sent" ? "Sample written" : "Sample already stored", [
      ["Entry", `/samples/${entry.n}, "${entry.name}"`],
      ["Placed at", `start sector 0x${entry.startSector.toString(16)}, extent ${entry.extentSectors} sectors`],
      ["Read back", outcome === "sent" ? "identical, outside the fields the firmware fills" : "not sent: the store already held this sample"],
      ["Plays", playable],
    ]);
    status(`Sample stored in /samples/${entry.n}.`, "ok");
  } catch (error) {
    if (error instanceof Error && /cancelled/.test(error.message)) {
      status("Cancelled. Nothing was sent.", "warn");
      verdictCard("Cancelled", [["Sent", "nothing"]]);
      return;
    }
    throw error;
  } finally {
    busy = false;
    $<HTMLButtonElement>("sampleWrite").disabled = false;
  }
}
