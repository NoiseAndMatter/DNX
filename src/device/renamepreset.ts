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
 * 4. **`safeWriteFile` with `overwrite`**: it asks, saves the slot's current file to the DNX folder
 *    or your downloads, writes and commits.
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
 * The copy is saved as `.dn2snd` from a Digitone II and `.dnsnd` from a Digitone 1, which is what a
 * backup names the same bytes, so it opens in DNX and can be written back.
 *
 * ## Both instruments, one path
 *
 * A Digitone 1's stored preset body is its 302-byte sound object with nothing in front; a Digitone
 * II's has five bytes first. `objectInStoredBody` finds the object by its magic either way, so the
 * name is written at +12 of the object on both.
 */

import { type ConfirmHook, type FileWriteReview, safeWriteFile } from "./safewrite.js";
import { readStoredFile } from "./storagesession.js";
import { STORED_FORM, listRequest, wholeListing } from "./storage.js";
import { bankPath, slotPath } from "./library.js";
import { renamePresetFile } from "./presetrename.js";
import { decodeProjectImage } from "../project/dn2codec.js";
import { type ConnectedDevice } from "./identify.js";
import { IDS_FOR, type MessageIds } from "./messageids.js";
import { extensionsFor } from "../project/objectextensions.js";

/**
 * What renaming a preset needs from its host.
 *
 * The same shape `DriveWriteHost` takes, plus one more. `saveCopy` is handed the slot's current
 * contents before the rename is sent, and answers where it put them, because this write is an
 * overwrite and `safeWriteFile` refuses one without a backup. Where a copy goes is the host's
 * business: a folder the person picked, a download, an Android document tree.
 */
export interface RenamePresetHost {
  ids: MessageIds;
  gate: () => void;
  confirm: ConfirmHook<FileWriteReview>;
  saveCopy: (bytes: Uint8Array, name: string) => Promise<string>;
}

export interface RenamePresetOptions {
  host: RenamePresetHost;
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
  const { device, host, bank, index } = options;
  const status = options.onStatus ?? ((): void => {});

  // Nothing reaches an instrument until somebody arms the switch. Thrown before a byte is sent,
  // so a control the page forgot to gate still cannot write. The host supplies the switch; in the
  // browser it is `requireWriteEnabled`.
  host.gate();

  const transport = device.api;
  const path = slotPath("preset", bank, index);

  status(`Checking ${path}…`);
  const listId = host.ids.reserve(IDS_FOR.oneMessage);
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
    msgId: host.ids.reserve(IDS_FOR.oneObject),
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
      status(`Copy of ${target.name} saved to ${await host.saveCopy(backup.bytes, name)}`);
    },
    confirm: host.confirm,
    msgId: host.ids.reserve(IDS_FOR.oneObject),
    verifyMsgId: host.ids.reserve(IDS_FOR.oneObject),
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
      msgId: host.ids.reserve(IDS_FOR.oneObject),
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
    const againId = host.ids.reserve(IDS_FOR.oneMessage);
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
