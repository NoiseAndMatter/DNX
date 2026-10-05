/**
 * Deleting a wavetable from a `/waverider` slot.
 *
 * **One job, and it is the most destructive thing DNX can do to an instrument**, so almost all of
 * this file is about not doing it by accident.
 *
 * ## Why it is scoped to `/waverider` and nothing else
 *
 * `deleteRequest` addresses any path on the +Drive. A free-text field here would be the single
 * most dangerous control in the product: one typo and a project is gone, with no trash on the
 * instrument and usually no other copy of that work anywhere. The slot number is a bounded integer
 * and the route is a constant, so this control **cannot** be pointed at `/projects`.
 *
 * A wavetable is also the one thing that can always be put back: the source is a file on this
 * computer, and the slot is read and saved to disk before anything is sent. Widening this needs a
 * reason and an undo, not a wider input.
 *
 * ## Copy first, then delete, then prove it
 *
 * The same order as every write here. The slot is read and written to the Copies folder, so a
 * delete that turns out to be wrong costs the time to write it back. Then the directory is listed
 * again and the slot must read empty: the store's delete answers `01` and that answer, like the
 * commit's, is worth less than the listing.
 *
 * The device's own delete is `0x5c` with a **trailing slash** on the path, which `deleteRequest`
 * adds. Read and write opens take no slash. Two conventions in one API, and getting it wrong
 * answers `Could not resolve path`, which reads exactly like naming a file that is not there.
 */

import { status } from "./chrome.js";
import { apiTransport } from "./link.js";
import { readyOutput } from "./ready.js";
import { verdictCard } from "./verdicts.js";
import { listProjectsAt } from "./drivefile.js";
import { $ } from "../dom.js";
import { askConfirm } from "../dialog.js";
import { requireWriteEnabled } from "../writeenable.js";
import { saveBytesTo, whereSaved } from "../dnxfolder.js";
import { pageMessageIds } from "../messageids.js";
import { IDS_FOR } from "@noiseandmatter/dnx-core/device/messageids.js";
import { deleteRequest } from "@noiseandmatter/dnx-core/device/storage.js";
import { readStoredFile } from "@noiseandmatter/dnx-core/device/storagesession.js";
import { readFormOption } from "@noiseandmatter/dnx-core/device/storagewrite.js";
import { WAVERIDER, slotPath } from "@noiseandmatter/dnx-core/device/waveriderwrite.js";

let deleting = false;

$("tableDelete").addEventListener("click", () => {
  deleteTable().catch((error: unknown) => {
    status(`Delete failed: ${String(error)}`, "error");
    verdictCard("Delete failed", [["Error", String(error)]]);
  });
});

async function deleteTable(): Promise<void> {
  const output = readyOutput("readback");
  if (!output) return;
  if (deleting) {
    status("A delete is already running.", "warn");
    return;
  }

  const slot = Number($<HTMLInputElement>("tableDeleteSlot").value);
  if (!Number.isInteger(slot) || slot < 0 || slot > 255) {
    status(`Slot ${slot} is outside 0..255.`, "warn");
    return;
  }
  const path = slotPath(slot);
  const transport = apiTransport(output);

  // **A listing taken now**, because what matters is what is in the slot at this moment, and
  // because a delete of an already-empty slot is a question not worth asking the instrument.
  const before = await listProjectsAt(output, WAVERIDER);
  const entry = before.find((e) => e.index === slot);
  if (!entry) throw new Error(`${path} is not in the ${WAVERIDER} listing`);
  if (entry.occupied !== true) {
    status(`${path} is already empty — nothing to delete.`, "warn");
    verdictCard("Nothing to delete", [["Slot", path], ["State", "empty in a listing taken just now"]]);
    return;
  }

  deleting = true;
  $<HTMLButtonElement>("tableDelete").disabled = true;
  try {
    // Copy first. A delete whose copy failed is a delete nobody can undo, so a failure here stops
    // everything rather than being reported alongside a successful delete.
    status(`Copying ${path} before deleting it…`);
    const copy = await readStoredFile(path, {
      transport,
      ...readFormOption(path),
      msgId: pageMessageIds.reserve(IDS_FOR.oneObject),
    });
    const saved = await saveBytesTo(copy.bytes, `waverider-${slot}-${entry.name || "table"}.bin`, "copies");

    const agreed = await askConfirm({
      title: `Delete "${entry.name}" from ${path}?`,
      body: [
        `${copy.bytes.length.toLocaleString()} bytes, copied to ${whereSaved(saved)} first.`,
        "There is no undo on the instrument: the +Drive has no trash, and the only way back is " +
          "writing that copy again.",
      ],
      confirmLabel: "Delete it",
      danger: true,
    });
    if (!agreed) {
      status("Cancelled — nothing was sent.", "warn");
      verdictCard("Cancelled", [["Slot", path], ["Copy", whereSaved(saved)]]);
      return;
    }

    // Armed only after the person has agreed, and checked again by nothing else: this control
    // does not go through `safeWriteFile`, so the gate is called here or not at all.
    requireWriteEnabled();

    const id = pageMessageIds.reserve(IDS_FOR.oneMessage);
    await transport.request(deleteRequest(id, path), id, 20_000);

    // **The listing is the proof.** The delete's own `01` is an acknowledgement, not an outcome,
    // the same lesson the commit taught: on this device the reply that looks like success
    // frequently reports the attempt.
    const after = await listProjectsAt(output, WAVERIDER);
    const now = after.find((e) => e.index === slot);
    const gone = now?.occupied === false;

    verdictCard(gone ? "Table deleted" : "Delete NOT confirmed", [
      ["Slot", path],
      ["Was", `"${entry.name}" — ${copy.bytes.length.toLocaleString()} bytes`],
      ["Copy", whereSaved(saved)],
      ["Listed after", gone ? "empty" : `still occupied as "${now?.name ?? "?"}"`],
      ["Occupied slots left", String(after.filter((e) => e.occupied === true).length)],
    ]);
    status(
      gone ? `${path} is empty in a fresh listing.` : `${path} still reads occupied — the delete did not take.`,
      gone ? "ok" : "error",
    );
  } finally {
    deleting = false;
    $<HTMLButtonElement>("tableDelete").disabled = false;
  }
}
