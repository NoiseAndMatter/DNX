/**
 * `/modinfo`: what the image on the instrument is modded with.
 *
 * **One job: 256 bytes in, a capability record out.** The decision this record feeds — which parts
 * of DNX appear — is `device/waveridersupport.ts`, because that one needs the device. This is the
 * codec, and it reads only: the route is write-protected by the session itself, so nothing here
 * builds a record.
 *
 * Spec: `dn2_firmware/docs/for-dnx-modinfo.md` rev 2. Built and checked in digikit's emulator, not
 * on the instrument.
 *
 * ## Why a record at all, when the root listing already answers the coarse question
 *
 * `waverider` in the `/` listing says the store is there, and no build without it lists that root.
 * What the listing cannot say is *which* of DNX's features this build serves — rename in place, a
 * compare-and-swap on a pool write, the instrument's own wavetable page — or which image it is.
 * Two builds with the same mods and the same tag differ only in the image id, and on 2026-10-06
 * `tbl128` and `tbl128b` differed in one loader constant with everything else identical.
 *
 * ## It grows by appending, so a reader takes the hash from the end
 *
 * The record declares its own length at offset 6 and the hash sits at `bytes - 4`, not at a
 * constant. A reader **accepts a length larger than it knows** and reads the fields it knows,
 * which is how an older DNX keeps working against a newer image.
 *
 * That is the opposite of `poolfile.ts`, whose size is fixed and whose hash is at offset 508, and
 * the difference is deliberate: a data record must not be half-understood, while a capability set
 * is expected to grow.
 *
 * ## Unknown capability bits are ignored, not refused
 *
 * The same reasoning in the other direction: an older DNX meeting newer firmware should lose
 * features rather than refuse the device. The bits outside the known mask are kept in `unknown` so
 * a page can say *this build reports something DNX does not know about* without acting on it.
 *
 * **Bit `0x08` is retired.** It meant `delete` in rev 1, and since every build with the store can
 * delete, the flag said nothing. Nothing infers anything from it, set or clear.
 */

import { be16, be32 } from "./bytes.js";
import { WaveriderError } from "./errors.js";
import { xxHash32 } from "./xxhash32.js";
import {
  CONTAINER_MAGIC,
  HEADER_BYTES,
  TRAILER_BYTES,
  containerIsCompressed,
  containerObjectVersion,
  contentKind,
} from "../project/container.js";

/** The container's content kind for a mod-info record. */
export const CONTENT_KIND_MODINFO = 0x4d;

/** The container's object version, and the record's own version field. Both 1 in rev 2. */
export const MODINFO_VERSION = 1;

/** `DNMI` at offset 0. */
export const MODINFO_MAGIC = Uint8Array.of(0x44, 0x4e, 0x4d, 0x49);

/** What the record is today. A longer one is read, which is the point of the length field. */
export const MODINFO_BYTES = 256;

/** The route. One file, index 0, write-protected by the session itself. */
export const MODINFO = "/modinfo";
export const MODINFO_PATH = `${MODINFO}/0`;

/** Field offsets inside the record. The hash is not here: it is at `bytes - 4`. */
export const INFO = {
  magic: 0,
  version: 4,
  bytes: 6,
  capabilities: 8,
  poolSlots: 12,
  poolRecordVersion: 14,
  storeSlots: 16,
  poolNameChars: 18,
  shownNameChars: 19,
  imageId: 20,
  os: 24,
  buildTag: 32,
  commit: 56,
  modCount: 68,
  mods: 72,
  reserved: 248,
} as const;

const TEXT = { os: 8, buildTag: 24, commit: 12 } as const;

/** One mod: a 12-byte id and the xxHash32 of its code, which is `0` when it has none. */
export const MOD_BYTES = 16;
export const MOD_ID_BYTES = 12;

/** How many mods a 256-byte record has room for, between `mods` and `reserved`. */
export const MODS_IN_RECORD = (INFO.reserved - INFO.mods) / MOD_BYTES;

/**
 * One bit per thing DNX does differently.
 *
 * Named for what the firmware serves rather than for the button it enables, because one bit gates
 * more than one thing: `page` is the only way to know there is a second writer of the working
 * project's pool, which decides both a warning and the wording of a refusal.
 */
export const CAPABILITY = {
  /** `/waverider`: list, read, write a table. Without it there is no Wavetables tab. */
  store: 0x01,
  /** `/wavepool`: a project's pool list, read and written whole. */
  pool: 0x02,
  /** A 128-byte body to `/waverider/<n>` renames in place. */
  rename: 0x04,
  /** A pool write that sends a generation is refused when the record moved under it. */
  poolCas: 0x10,
  /** The instrument has its own wavetable page, so the working project's pool has two writers. */
  page: 0x20,
} as const;

/** `0x08` meant `delete` in rev 1 and said nothing. Named so that nothing reuses it. */
export const RETIRED_CAPABILITY = 0x08;

const KNOWN_CAPABILITIES =
  CAPABILITY.store |
  CAPABILITY.pool |
  CAPABILITY.rename |
  CAPABILITY.poolCas |
  CAPABILITY.page |
  RETIRED_CAPABILITY;

export interface ModInfoMod {
  /** The mod's id, as the build writes it. */
  id: string;
  /** xxHash32 of its code, absent where it has none — which is not the same as a hash of zero. */
  codeHash?: number;
}

export interface ModInfoCapabilities {
  store: boolean;
  pool: boolean;
  rename: boolean;
  poolCas: boolean;
  page: boolean;
}

export interface ModInfo {
  /** The record's own version field, which agrees with the container's. */
  version: number;
  /** What the record says it is. **May be larger than `MODINFO_BYTES`**, and that is allowed. */
  bytes: number;
  /** The capability word verbatim, so a caller can show it when a bit is unknown. */
  capabilities: number;
  can: ModInfoCapabilities;
  /** The bits outside the known mask. Reported, never acted on. */
  unknown: number;
  /**
   * How many slots this build's pools hold: 127 or 128.
   *
   * **Draw the grid from this** rather than from DNX's own `POOL_ENTRIES`, which is only what the
   * build in front of us happens to be. Where there is no record there is no honest default, and
   * `waveridersupport.ts` says so rather than picking one.
   */
  poolSlots: number;
  /** The pool record version this build writes. It reads 1 and 2. */
  poolRecordVersion: number;
  storeSlots: number;
  /** Characters of a table's name the pool keeps. The store itself holds 64. */
  poolNameChars: number;
  /** Characters the instrument's TBL header shows after the slot number. */
  shownNameChars: number;
  /**
   * xxHash32 of the whole MAIN OS payload: **which image this is**.
   *
   * The one field that separates two builds of the same mods and the same tag, which is the
   * question a build tag cannot answer and a loader constant can hide.
   */
  imageId: number;
  /** The OS it was built from. Information only: never gate on it. */
  os: string;
  buildTag: string;
  /** The commit, with a trailing `+` where it was built with uncommitted changes. */
  commit: string;
  /** What the record says it carries, which may exceed what this reader has room for. */
  modCount: number;
  /** The mods this reader could reach, in order. */
  mods: ModInfoMod[];
}

/** NUL-terminated, Windows-1252 like every other name in the store. */
const latin1 = new TextDecoder("windows-1252");

function text(record: Uint8Array, at: number, length: number): string {
  const field = record.subarray(at, at + length);
  const nul = field.indexOf(0);
  return latin1.decode(nul === -1 ? field : field.subarray(0, nul)).trimEnd();
}

/**
 * Read the record.
 *
 * Refuses one it cannot trust — wrong magic, a declared length that is not the length that
 * arrived, a hash that does not match — and reads one that is merely *longer* than it knows. A
 * caller shows a refusal as *could not ask*, never as *not supported*.
 */
export function readModInfo(record: Uint8Array): ModInfo {
  if (record.length < INFO.mods) {
    throw new WaveriderError(
      `a mod-info record is at least ${INFO.mods} bytes, and this is ${record.length}`,
    );
  }
  for (let i = 0; i < MODINFO_MAGIC.length; i++) {
    if (record[INFO.magic + i] !== MODINFO_MAGIC[i]) {
      throw new WaveriderError('the record does not begin "DNMI"');
    }
  }

  const bytes = be16(record, INFO.bytes);
  if (bytes !== record.length) {
    throw new WaveriderError(`the record says it is ${bytes} bytes and ${record.length} arrived`);
  }

  /*
   * **The hash is at the end, not at a constant.** Taking it from 252 would read a longer record's
   * payload as its hash and report corruption on a record that is fine, which is the failure this
   * layout exists to avoid.
   */
  const hash = be32(record, bytes - 4);
  const computed = xxHash32(record.subarray(0, bytes - 4));
  if (hash !== computed) {
    throw new WaveriderError("the mod-info record's hash does not match its bytes");
  }

  const capabilities = be32(record, INFO.capabilities);
  const modCount = record[INFO.modCount]!;
  const room = Math.floor((Math.min(bytes, INFO.reserved) - INFO.mods) / MOD_BYTES);
  const mods: ModInfoMod[] = [];
  for (let i = 0; i < Math.min(modCount, room); i++) {
    const at = INFO.mods + i * MOD_BYTES;
    const id = text(record, at, MOD_ID_BYTES);
    if (id.length === 0) continue;
    const codeHash = be32(record, at + MOD_ID_BYTES);
    mods.push({ id, ...(codeHash === 0 ? {} : { codeHash }) });
  }

  return {
    version: be16(record, INFO.version),
    bytes,
    capabilities,
    can: {
      store: (capabilities & CAPABILITY.store) !== 0,
      pool: (capabilities & CAPABILITY.pool) !== 0,
      rename: (capabilities & CAPABILITY.rename) !== 0,
      poolCas: (capabilities & CAPABILITY.poolCas) !== 0,
      page: (capabilities & CAPABILITY.page) !== 0,
    },
    unknown: capabilities & ~KNOWN_CAPABILITIES,
    poolSlots: be16(record, INFO.poolSlots),
    poolRecordVersion: be16(record, INFO.poolRecordVersion),
    storeSlots: be16(record, INFO.storeSlots),
    poolNameChars: record[INFO.poolNameChars]!,
    shownNameChars: record[INFO.shownNameChars]!,
    imageId: be32(record, INFO.imageId),
    os: text(record, INFO.os, TEXT.os),
    buildTag: text(record, INFO.buildTag, TEXT.buildTag),
    commit: text(record, INFO.commit, TEXT.commit),
    modCount,
    mods,
  };
}

/**
 * Read what a read of `/modinfo/0` returns: the record inside a transfer container.
 *
 * The container is checked the way `readPoolFile` checks a pool file's, and for the same reason — a
 * read in the wrong form succeeds and returns different bytes, so a codec that skipped the header
 * would report a hash mismatch on a healthy record.
 */
export function readModInfoFile(file: Uint8Array): ModInfo {
  const least = HEADER_BYTES + INFO.mods + TRAILER_BYTES;
  if (file.length < least) {
    throw new WaveriderError(`a mod-info file is at least ${least} bytes, and this is ${file.length}`);
  }
  for (let i = 0; i < CONTAINER_MAGIC.length; i++) {
    if (file[i] !== CONTAINER_MAGIC[i]) throw new WaveriderError("not an Elektron container");
  }
  const kind = contentKind(file);
  if (kind !== CONTENT_KIND_MODINFO) {
    throw new WaveriderError(
      `content kind 0x${(kind ?? 0).toString(16)} is not a mod-info record's ` +
        `0x${CONTENT_KIND_MODINFO.toString(16)}`,
    );
  }
  if (containerIsCompressed(file) !== false) {
    throw new WaveriderError("the body must be raw; this one says it is an LZ4 chain");
  }

  const record = file.subarray(HEADER_BYTES, file.length - TRAILER_BYTES);
  const info = readModInfo(record);

  /*
   * Both version fields, as the pool record checks both of its own: they describe the same thing,
   * and a record where they differ is one whose reading depends on which field a reader consulted.
   */
  const containerVersion = containerObjectVersion(file) ?? 0;
  if (containerVersion !== info.version) {
    throw new WaveriderError(
      `the container says mod-info version ${containerVersion} and the record says ${info.version}`,
    );
  }
  return info;
}
