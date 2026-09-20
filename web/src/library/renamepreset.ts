/**
 * Renaming a preset on the instrument, from a browser.
 *
 * The work is `src/device/renamepreset.ts`. This page supplies the four things it cannot own: the
 * one message-id allocator, the write switch, the confirmation dialog, and somewhere to put the
 * copy taken before the overwrite.
 *
 * The copy is the interesting one. `safeWriteFile` refuses an overwrite without a backup hook, so
 * where the copy lands is part of consent rather than a convenience: here it is the DNX folder if
 * the person chose one, and a download otherwise, which is what `saveFile` decides.
 */

import {
  type RenamePresetHost,
  type RenamePresetOptions,
  type RenamePresetResult,
  renamePresetOnDrive as coreRename,
} from "../../../src/device/renamepreset.js";
import { confirmFileWrite } from "../safewriteui.js";
import { pageMessageIds } from "../messageids.js";
import { requireWriteEnabled } from "../writeenable.js";
import { saveFile, whereSaved } from "../dnxfolder.js";

export {
  PresetNotRenameable,
  type RenamePresetOptions,
  type RenamePresetResult,
} from "../../../src/device/renamepreset.js";

const host: RenamePresetHost = {
  ids: pageMessageIds,
  gate: requireWriteEnabled,
  confirm: confirmFileWrite,
  saveCopy: async (bytes, name) => {
    const saved = await saveFile(
      new Blob([bytes as BlobPart], { type: "application/octet-stream" }), name, "copies",
    );
    return whereSaved(saved);
  },
};

/** Rename one preset in place, keeping a copy of what was there. */
export function renamePresetOnDrive(
  options: Omit<RenamePresetOptions, "host">,
): Promise<RenamePresetResult> {
  return coreRename({ ...options, host });
}
