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
 * How dangerous a message is to send.
 *
 * The reason this exists rather than a list of "ones to avoid": **an allowlist fails safe and a
 * blocklist fails dangerous.** A code nobody has classified is one nobody has shown to be
 * harmless, and the honest default for "we do not know what this does to your instrument" is not
 * to send it.
 *
 * - `read` — proven to only report. Safe to send at will.
 * - `write` — known to change the device. Never sent by the probe.
 * - `unknown` — **not classified.** Never sent by the probe either, and deliberately not lumped
 *   in with `write`: the distinction is between *"this is dangerous"* and *"we have no idea"*,
 *   and collapsing them would lose the fact that these are the ones worth learning about.
 */
export type Safety = "read" | "write" | "unknown";

/**
 * API messages, by code, with what sending one does.
 *
 * Sources: elk-herd's `SysEx/Message.elm` for everything it implements, and this file for the
 * gaps. Four codes a Digitone II advertises — `0x03`, `0x04`, `0x06`, `0x07` — appear in no
 * source we have, so they are `unknown` rather than guessed at.
 */
export const API_MESSAGES: Readonly<Record<number, { name: string; safety: Safety }>> = {
  0x01: { name: "Device", safety: "read" },
  0x02: { name: "Version", safety: "read" },
  0x09: { name: "Query", safety: "read" },
  0x10: { name: "DirList", safety: "read" },
  0x11: { name: "DirCreate", safety: "write" },
  0x12: { name: "DirDelete", safety: "write" },
  0x20: { name: "FileDelete", safety: "write" },
  0x21: { name: "ItemRename", safety: "write" },
  0x23: { name: "SampleFileInfo", safety: "read" },
  0x30: { name: "FileReadOpen", safety: "read" },
  0x31: { name: "FileReadClose", safety: "read" },
  0x32: { name: "FileRead", safety: "read" },
  0x40: { name: "FileWriteOpen", safety: "write" },
  0x41: { name: "FileWriteClose", safety: "write" },
  0x42: { name: "FileWrite", safety: "write" },
};

/**
 * Dump types, by code. From `src/sysex/devices.ts`, which derived them from real dumps.
 *
 * **Every one of these is a write.** In this family a dump *is* the data: the device sends one to
 * hand you a pattern, and you send one to give it a pattern. So `0x50` addressed to an instrument
 * is "here is a pattern, store it" — which is how uploading works and exactly why sweeping the
 * advertised codes to see what happens is the one experiment not to run.
 *
 * Requesting a dump is a **different code**, `0x60` and up, and that is the read half.
 */
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
  safety: Safety;
}

/** Name every advertised code, in the order the device listed them. */
export function describeMessages(codes: readonly number[]): MessageInfo[] {
  return codes.map((code) => {
    // Anything in the dump band is a dump type even when we cannot name it: that band is where
    // Elektron puts them, and calling an unnamed 0x5b an API message would be a worse guess.
    // Every dump is a write, named or not — an unnamed one is not a safer one.
    const isDump = code >= 0x50 && code <= 0x5f;
    if (isDump) {
      const dump = DUMP_MESSAGES[code];
      return {
        code,
        name: dump ?? "unknown",
        known: dump !== undefined,
        kind: "dump" as const,
        safety: "write" as const,
      };
    }

    const api = API_MESSAGES[code];
    return {
      code,
      name: api?.name ?? "unknown",
      known: api !== undefined,
      kind: "api" as const,
      safety: api?.safety ?? ("unknown" as const),
    };
  });
}

/**
 * Whether the probe may send this code unprompted.
 *
 * The single gate everything goes through, so "we only send reads" is enforced in one place
 * rather than remembered in several.
 */
export function safeToSend(code: number): boolean {
  return describeMessages([code])[0]!.safety === "read";
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
 * Keys to ask a device about itself.
 *
 * Safe to try in bulk, and that is a property of `Query` rather than of the list: a key goes in,
 * a tagged value comes back, and an unrecognised key answers `none`. So a wrong guess costs one
 * round trip and tells us the key does not exist — which is itself information.
 *
 * Only the first is attested; elk-herd names it in a comment about stereo support. The rest are
 * **guesses**, built from that one's shape (`noun_noun.property`) and from the things a Digitone
 * would plausibly know about itself. They are here to map the namespace, and most are expected
 * to come back empty.
 */
export const QUERY_KEYS: readonly string[] = [
  // Attested, from elk-herd's `supportsStereo` comment.
  "sample_file.interleaved_stereo_support",

  // The shape of the attested key, applied to what this family has.
  "project.storage_version",
  "project.pattern_count",
  "project.sound_count",
  "pattern.storage_version",
  "kit.storage_version",
  "sound.storage_version",

  // Identity, which the Device and Version messages report in part and might expose in full.
  "device.name",
  "device.serial",
  "device.firmware_version",
  "device.build",
];

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
