/**
 * Rename a preset on the instrument's +Drive.
 *
 * **The one control on the library page that writes to the instrument.** Everything else here edits
 * a project held in the page. So it goes through every rule the other writes do, in the same order:
 *
 * 1. **The write switch**, before anything else, so a button the page forgot to gate still cannot write.
 * 2. **A listing taken now.** The slot has to be occupied, and the instrument must not mark it
 *    protected: factory presets read `0x12` and are refused here rather than by the device.
 * 3. **The file read in stored form**, renamed by `renamePresetFile`, which checks that only the
 *    name moved before anything is sent.
 * 4. **`safeWriteFile` with `overwrite`**: it asks, saves the slot's current file to your downloads,
 *    writes and commits.
 * 5. **The slot is read back and decoded**, and the body compared with the renamed body.
 *
 * ## Why the read-back is decoded, not compared byte for byte
 *
 * The instrument keeps its own LZ4 encoding of what it is sent. Renaming `/soundbanks/H/129` twice on
 * 2026-09-14 sent 271 bytes each time; the first read back as sent, the second read back as **275**
 * and `safeWriteFile`'s byte comparison called a rename that had landed a failure. The notebook
 * already said so for projects: LZ4 is a deterministic format and not a deterministic encoding, and
 * a write is verified by what it decodes to. `writeProjectToDrive` skips the byte check for exactly
 * this reason, and so does this.
 *
 * The copy is saved as `.dn2snd`, which is what a backup names the same bytes, so it opens in DNX
 * and can be written back.
 */

import { safeWriteFile } from "../../../src/device/safewrite.js";
import { readStoredFile } from "../../../src/device/storagesession.js";
import { STORED_FORM, listRequest, wholeListing } from "../../../src/device/storage.js";
import { bankPath, slotPath } from "../../../src/device/library.js";
import { renamePresetFile } from "../../../src/device/presetrename.js";
import { decodeProjectImage } from "../../../src/project/dn2codec.js";
import { apiTransport, type ConnectedDevice } from "../devicesource.js";
import { IDS_FOR, reserveMessageIds } from "../messageids.js";
import { requireWriteEnabled } from "../writeenable.js";
import { confirmFileWrite } from "../safewriteui.js";
import { saveFile, whereSaved } from "../dnxfolder.js";
import { extensionsFor } from "../objectextensions.js";

export interface RenamePresetOptions {
  device: ConnectedDevice;
  bank: string;
  index: number;
  name: string;
  onStatus?: (message: string) => void;
}

export type RenamePresetResult =
  | { outcome: "cancelled" | "unchanged"; from: string; to: string; notes: string[] }
  | {
    outcome: "written";
    from: string;
    to: string;
    notes: string[];
    committed: boolean;
    verified: boolean;
    /** Where the read-back differed, when it did. */
    problem?: string;
    /** What the instrument's own listing calls the slot afterwards. */
    listedAs?: string;
  };

export class PresetNotRenameable extends Error {}

export async function renamePresetOnDrive(options: RenamePresetOptions): Promise<RenamePresetResult> {
  const { device, bank, index } = options;
  const status = options.onStatus ?? ((): void => {});

  // Nothing reaches an instrument until somebody arms the switch. Thrown before a byte is sent,
  // so a control the page forgot to gate still cannot write. See `writeenable.ts`.
  requireWriteEnabled();

  const transport = apiTransport(device);
  const path = slotPath("preset", bank, index);

  status(`Checking ${path}…`);
  const listId = reserveMessageIds(IDS_FOR.oneMessage);
  const listing = wholeListing(
    await transport.request(listRequest(listId, bankPath("preset", bank)), listId, 10_000),
    bankPath("preset", bank),
  );
  const target = listing.entries.find((e) => e.kind === "file" && e.index === index);
  if (!target) throw new PresetNotRenameable(`${path} is not in its bank's listing`);
  if (!target.occupied) throw new PresetNotRenameable(`${path} is empty, so there is nothing to rename`);
  if (target.writable === false) {
    throw new PresetNotRenameable(
      `${path} (${target.name}) is write-protected on the instrument. Factory presets are, and ` +
        `renaming one would be refused by the device anyway. Save a copy to a free slot and rename that.`,
    );
  }

  status(`Reading ${target.name}…`);
  const stored = await readStoredFile(path, {
    transport,
    form: STORED_FORM,
    msgId: reserveMessageIds(IDS_FOR.oneObject),
  });

  const plan = renamePresetFile(stored.bytes, options.name);
  if (!plan.changed) {
    return { outcome: "unchanged", from: plan.from, to: plan.to, notes: plan.notes };
  }

  const sound = extensionsFor(device.productId).sound;
  const result = await safeWriteFile({
    transport,
    path,
    name: plan.to,
    bytes: plan.bytes,
    target,
    overwrite: true,
    onBackup: async (backup) => {
      const name = backup.name.replace(/\.payload$/, sound);
      const saved = await saveFile(new Blob([backup.bytes as BlobPart], { type: "application/octet-stream" }), name, "copies");
      status(`Copy of ${target.name} saved to ${whereSaved(saved)}`);
    },
    confirm: confirmFileWrite,
    msgId: reserveMessageIds(IDS_FOR.oneObject),
    verifyMsgId: reserveMessageIds(IDS_FOR.oneObject),
    // Replaced below by a decoded comparison. See the module note.
    skipVerify: true,
    onStatus: status,
  });

  if (result.cancelled) {
    return { outcome: "cancelled", from: plan.from, to: plan.to, notes: plan.notes };
  }

  let verified = false;
  let problem: string | undefined;
  let listedAs: string | undefined;
  if (result.committed) {
    status(`Verifying: reading ${path} back…`);
    const back = await readStoredFile(path, {
      transport,
      form: STORED_FORM,
      msgId: reserveMessageIds(IDS_FOR.oneObject),
    });
    const wanted = decodeProjectImage(plan.bytes).image;
    try {
      const held = decodeProjectImage(back.bytes).image;
      const at = held.length !== wanted.length ? -1 : held.findIndex((b, i) => b !== wanted[i]);
      verified = at === -1 && held.length === wanted.length;
      if (!verified) {
        problem = held.length !== wanted.length
          ? `the slot decodes to ${held.length} bytes, and the renamed preset is ${wanted.length}`
          : `the slot's body differs from the renamed preset at byte ${at}`;
      }
    } catch (error) {
      problem = `the slot read back but did not decode: ${String(error)}`;
    }

    // The listing is the instrument's own word on the new name, independent of the comparison.
    const againId = reserveMessageIds(IDS_FOR.oneMessage);
    const again = wholeListing(
      await transport.request(listRequest(againId, bankPath("preset", bank)), againId, 10_000),
      bankPath("preset", bank),
    );
    listedAs = again.entries.find((e) => e.kind === "file" && e.index === index)?.name;
  }

  return {
    outcome: "written",
    from: plan.from,
    to: plan.to,
    notes: plan.notes,
    committed: result.committed,
    verified,
    ...(listedAs === undefined ? {} : { listedAs }),
    ...(problem === undefined ? {} : { problem }),
  };
}
