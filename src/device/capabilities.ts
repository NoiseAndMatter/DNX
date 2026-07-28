/**
 * What a device says it can do, and what that means for us.
 *
 * A `Device` response carries `supportedMessages` — the codes the instrument implements. It is
 * capability discovery built into the protocol, and the reason to read it rather than assume is
 * now a matter of record:
 *
 * **We assumed the Digitone had the +Drive filesystem API and it does not.** elk-herd supports
 * the Digitakt II, which does, and the assumption was generalised across the storage family
 * without evidence. A Digitone II reported none of the nine file-API codes and `DirList` timed
 * out; a Digitone 1, probed alongside it, reported none of them either. Two devices, two
 * firmware generations, same answer — so this is a **Digitone-family** fact, not one device's
 * quirk, and the file API belongs to the Digitakt line.
 *
 * elk-herd gates the same way: its `hasDriveSamples` requires 0x10, 0x11, 0x12, 0x20 and 0x21 to
 * all be present, and by that test neither Digitone qualifies.
 *
 * Had the transfer layer been built on the assumption, that is where it would have surfaced.
 *
 * ## Two numbering spaces in one list
 *
 * The list mixes both. `0x01`–`0x4f` are **API** messages — device info, directories, file
 * transfer. `0x50`–`0x5e` are **dump types**, the same values `src/sysex/devices.ts` records for
 * the classic dump protocol (`0x50` PATTERN_KIT, `0x51` PATTERN, `0x52` KIT, `0x53` SOUND,
 * `0x54` PROJECT_SETTINGS). A device advertises what it speaks, whichever protocol it belongs to.
 */

/**
 * API messages, by code. Named where we know them.
 *
 * Sources: elk-herd's `SysEx/Message.elm` for everything it implements, and this file for the
 * gaps. Four codes a Digitone II advertises — `0x03`, `0x04`, `0x06`, `0x07` — appear in no
 * source we have, so they are listed as unknown rather than guessed at.
 */
export const API_MESSAGES: Readonly<Record<number, string>> = {
  0x01: "Device",
  0x02: "Version",
  0x09: "Query",
  0x10: "DirList",
  0x11: "DirCreate",
  0x12: "DirDelete",
  0x20: "FileDelete",
  0x21: "ItemRename",
  0x23: "SampleFileInfo",
  0x30: "FileReadOpen",
  0x31: "FileReadClose",
  0x32: "FileRead",
  0x40: "FileWriteOpen",
  0x41: "FileWriteClose",
  0x42: "FileWrite",
};

/** Dump types, by code. From `src/sysex/devices.ts`, which derived them from real dumps. */
export const DUMP_MESSAGES: Readonly<Record<number, string>> = {
  0x50: "PatternKit dump",
  0x51: "Pattern dump",
  0x52: "Kit dump",
  0x53: "Sound dump",
  0x54: "ProjectSettings dump",
};

/** The codes that together make the +Drive readable as a filesystem. */
export const DRIVE_FILE_MESSAGES: readonly number[] = [0x10, 0x30, 0x31, 0x32];

/** The codes elk-herd requires before it will manage drive samples. */
export const DRIVE_MANAGE_MESSAGES: readonly number[] = [0x10, 0x11, 0x12, 0x20, 0x21];

export interface MessageInfo {
  code: number;
  /** `Device`, `Kit dump`, or `unknown` when no source names it. */
  name: string;
  known: boolean;
  kind: "api" | "dump";
}

/** Name every advertised code, in the order the device listed them. */
export function describeMessages(codes: readonly number[]): MessageInfo[] {
  return codes.map((code) => {
    const dump = DUMP_MESSAGES[code];
    if (dump !== undefined) return { code, name: dump, known: true, kind: "dump" as const };
    const api = API_MESSAGES[code];
    return {
      code,
      name: api ?? "unknown",
      known: api !== undefined,
      // Anything in the dump band is a dump type even when we cannot name it; that band is
      // where Elektron puts them, and calling an unnamed 0x5b an API message would be worse
      // than calling it an unnamed dump.
      kind: code >= 0x50 && code <= 0x5f ? ("dump" as const) : ("api" as const),
    };
  });
}

export interface Capabilities {
  /** True when whole files can be read off the +Drive by path. False on the Digitone II. */
  driveFiles: boolean;
  /** Which of `DRIVE_FILE_MESSAGES` are missing, so a refusal can say what is absent. */
  missingForDriveFiles: number[];
  /** True when the drive can also be reorganised — elk-herd's `hasDriveSamples`. */
  driveManagement: boolean;
  /** Dump types the device speaks, named or not. */
  dumps: number[];
  /**
   * Advertised **API** codes no source we have can name — `0x03`, `0x04`, `0x06`, `0x07` on a
   * Digitone II. The genuine research lead: elk-herd does not implement them either, and on a
   * device with no file API they are the only unexplored messages left.
   */
  unknownApi: number[];
  /**
   * Dump types in the `0x50`–`0x5f` band we have not catalogued.
   *
   * Kept apart from `unknownApi` because they are a different kind of gap. These are almost
   * certainly more dump types — the band is where Elektron puts them — so the question is *which
   * data* rather than *what kind of message*.
   */
  unknownDumps: number[];
}

export function capabilitiesOf(codes: readonly number[]): Capabilities {
  const has = new Set(codes);
  const missingForDriveFiles = DRIVE_FILE_MESSAGES.filter((c) => !has.has(c));
  const described = describeMessages(codes);

  return {
    driveFiles: missingForDriveFiles.length === 0,
    missingForDriveFiles,
    driveManagement: DRIVE_MANAGE_MESSAGES.every((c) => has.has(c)),
    dumps: described.filter((m) => m.kind === "dump").map((m) => m.code),
    unknownApi: described.filter((m) => !m.known && m.kind === "api").map((m) => m.code),
    unknownDumps: described.filter((m) => !m.known && m.kind === "dump").map((m) => m.code),
  };
}

/** `0x1f`, for messages and errors. */
export function hex(code: number): string {
  return `0x${code.toString(16).padStart(2, "0")}`;
}

/**
 * What a Digitone II running 1.10E (build 0050) advertises.
 *
 * A capture, not a specification: one device, one firmware. Kept because it is the hardware
 * evidence behind everything above, and because the tests that check `capabilitiesOf` should be
 * reading a real answer rather than one written to pass.
 */
export const OBSERVED_DIGITONE_II: readonly number[] = [
  0x01, 0x02, 0x03, 0x04, 0x06, 0x07, 0x09,
  0x50, 0x52, 0x51, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e,
];

/**
 * What a Digitone 1 running 1.42A (build 0097) advertises.
 *
 * Probed side by side with the DN2, which turned a one-device observation into a family one:
 *
 * - **Neither Digitone has the +Drive file API.** So it is not a Digitone II quirk — the *file
 *   API is a Digitakt thing*, and elk-herd having it says nothing about this family.
 * - **`0x03` and `0x04` are on both**, so they are family-wide and old. They appear in no source
 *   we have, elk-herd included, which makes them the standing lead.
 * - **`0x06`, `0x07` and `0x09` are Digitone II only** — newer. `0x09` is `Query`, so the DN1
 *   cannot be asked about itself by key.
 * - The DN1 stops at `0x5d`; the DN2 adds `0x5e`. One more dump type on the newer machine.
 * - Both list the dump band in the same unsorted order — `0x50 0x52 0x51 0x53 …` — which makes
 *   that ordering a family trait rather than noise from one device.
 *
 * **Build numbers are per product line, not comparable.** The older machine reports the higher
 * number: DN1 build 0097 at version 1.42A against DN2 build 0050 at 1.10E. elk-herd calls build
 * "an increasing number", which is true within a line and misleading across two.
 */
export const OBSERVED_DIGITONE_1: readonly number[] = [
  0x01, 0x02, 0x03, 0x04,
  0x50, 0x52, 0x51, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d,
];
