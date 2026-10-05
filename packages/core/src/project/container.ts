/**
 * Elektron .dnprj / .dn2prj project container.
 *
 * A project file is a ZIP archive holding exactly two entries:
 *
 *   manifest.json   small JSON descriptor
 *   <Payload>       raw binary, named by manifest.Payload
 *
 * The payload is NOT SysEx-framed and NOT 8-in-7 encoded, which makes it a far better
 * route into project data than the SysEx dump protocol.
 *
 * It IS compressed. The body between 0x1F and len-12 is a chain of LZ4 block-format
 * blocks sharing one continuous dictionary (LZ4 "linked blocks"), each preceded by a
 * u32be compressed size and terminated by a u32be zero. Blocks decompress to 32768 bytes
 * each, the last one short. See dn2codec.ts for the decoder, and dn2image.ts for the
 * fixed geometry of the decompressed image.
 *
 * A warning for anyone re-deriving this: windowed entropy over a project payload reads
 * 3.7-6.2 bits, which looks nothing like compressed data and led us to conclude for some
 * time that the body was plain binary. LZ4 leaves long literal runs of ASCII and
 * structure, so entropy is not a reliable compression test here. Worse, the leftover
 * literals invite pattern-matching on raw bytes: a run of u16le match offsets can put an
 * 0xFF every six bytes and look exactly like a field layout. Decompress first, always.
 *
 * Payload layout, measured over 140 containers (every one on disk: both families, every
 * firmware present, projects, kits, soundbanks, sounds and presets, files and device reads):
 *
 *   0x00  AC 11 D3 03      container magic
 *   0x04  u16le, u16le     2, 5 in all 140
 *   0x08  u8               9 on DN1, 15 on DN2
 *   0x09  4 x ASCII        format version, "0097"/"0104" DN1, "0050"/"0059" DN2
 *   0x0D  u32be            CONTENT KIND: 1 project, 3 soundbank/sound/preset, 5 kit
 *   0x11  u32be            object version, the root object's own
 *   0x15  u32be            INDEX, 0-based: bank in byte 0x17, slot in byte 0x18
 *   0x19  u32be            UNCOMPRESSED body length
 *   0x1D  u8               1 = the body is an LZ4 chain, 0 = raw
 *   0x1E  u8               12 in all 140, the trailer's own length
 *   0x1F  body             the LZ4 chain, or the first object when 0x1D is 0
 *
 *   end-12  u32be          CRC-32 seeded zero, over the body
 *   end-8   u32be          body length == payloadLength - 43
 *   end-4   AA A1 DA AA    container footer magic
 *
 * **Four big-endian words, not the little-endian fields this file described until 2026-10-05.**
 * The old reading had three zeros at 0x0D, a constant 1 at 0x10, a version at 0x14, a 16-bit slot
 * at 0x18, then 11 unidentified bytes and the body at 0x25. It returned the right number for a
 * version below 256 sitting in bank A, which is what the first 53 DN1 projects all were, and it
 * is wrong by construction: a little-endian word at 0x14 reaches into the index, so a soundbank in
 * bank H reads its object version as 117,440,514 rather than 2. `soundbanks_H_1_407B.bin`, read
 * off a device in 2026, is the fixture that says so.
 *
 * Two entries went with it. The "device signature `2A 72 04 01` on DN1, `C4 AE 04 01` on DN2" was
 * the length at 0x19 read one byte early, `00 2A 72 04` being 2,781,700 and `00 C4 AE 04` being
 * 12,889,604 — the two families' image sizes, which is exactly why it looked like identity. And
 * the body starts at 0x1F, not 0x25; the `F0 05` tag at 0x23 was two bytes of an LZ4 chain.
 *
 * Object headers inside the image are big-endian too, so the mixed endianness this file warned
 * about is only the pair of u16le at 0x04.
 *
 * Objects are marked by the magic BE EF BA CE followed by a u32be version. The same
 * BEEFBACE magic heads DN1 sound dumps over SysEx, so objects are shared between the
 * two transports.
 */

export const CONTAINER_MAGIC = Uint8Array.of(0xac, 0x11, 0xd3, 0x03);
export const FOOTER_MAGIC = Uint8Array.of(0xaa, 0xa1, 0xda, 0xaa);
export const OBJECT_MAGIC = Uint8Array.of(0xbe, 0xef, 0xba, 0xce);

/** Difference between payload length and the stored length field: 31 of header, 12 of trailer. */
export const LENGTH_BIAS = 43;

/**
 * What the container holds, from `0x0D`.
 *
 * Measured: 112 containers say 1 and are projects, 11 say 3 and are soundbanks, sounds or
 * presets, 2 say 5 and are kits. **The firmware checks it.** OS 1.11's `/projects` validator at
 * `0x400eb2f2` refuses a container whose word here is not 1, which makes this a type guard on the
 * route rather than a label, and a reason to check it before a write instead of after a refusal.
 */
export const CONTENT_KIND = { project: 1, sound: 3, kit: 5 } as const;

/** The content kind at `0x0D`, or `undefined` when the head is too short or not a container. */
export function contentKind(head: Uint8Array): number | undefined {
  if (head.length < 0x11 || !startsWith(head, CONTAINER_MAGIC)) return undefined;
  return readBe32(head, 0x0d);
}

/**
 * The root object's version, at `0x11`.
 *
 * Seen: 2, 3 and 5 on DN2 projects, 12 and 14 on DN1, 2 and 4 on kits and soundbanks. A DN2
 * writes 3 up to OS 1.10E and 5 on OS 1.11, which is the same number `projectObjectVersion` reads
 * from the decompressed image, available here without decompressing anything.
 *
 * **OS 1.11 refuses a project whose version here exceeds 5**, in the same validator that checks
 * the content kind. The ceiling sits exactly at the newest version that firmware writes, so a
 * project saved by a firmware that bumps it again is not writable back to 1.11.
 */
export function containerObjectVersion(head: Uint8Array): number | undefined {
  if (head.length < 0x15 || !startsWith(head, CONTAINER_MAGIC)) return undefined;
  return readBe32(head, 0x11);
}

/**
 * Where the body's compression flag sits. `1` is an LZ4 chain, `0` is raw.
 *
 * **Named from evidence.** Every one of the 122 compressed containers on disk carries 1 and holds
 * a body shorter than the length at `0x19`; all 18 raw ones carry 0 and hold a body exactly that
 * length. Device reads are raw, files are compressed, and `project/write.ts` has to set it because
 * Elektron Transfer trusts it: a compressed body behind a 0 stopped Transfer at "Calculating
 * Checksum" and crashed it.
 */
export const COMPRESSED_FLAG_OFFSET = 0x1d;

/** True when the body is an LZ4 chain, false when raw, `undefined` when it cannot be read. */
export function containerIsCompressed(head: Uint8Array): boolean | undefined {
  if (head.length <= COMPRESSED_FLAG_OFFSET || !startsWith(head, CONTAINER_MAGIC)) return undefined;
  return head[COMPRESSED_FLAG_OFFSET] !== 0;
}

function readBe32(data: Uint8Array, at: number): number {
  return (
    ((data[at]! << 24) | (data[at + 1]! << 16) | (data[at + 2]! << 8) | data[at + 3]!) >>> 0
  );
}

/**
 * Where the container header holds its own zero-based slot index. The `0x18` in the layout above.
 *
 * **A Digitone II stamps this byte itself.** `/kits/A/1` written verbatim into `/kits/A/38` reads
 * back differing in exactly one byte of 10,795: container offset 24, `0x00` → `0x25`, which is 37
 * for slot 38. It is the same idea as `slotIndexOffset` in a pattern record, and because the
 * instrument writes it, a byte-exact comparison has to expect it or call every correct write a
 * corruption. Measured 2026-08-13; see `device/storagewrite.ts` and `device/safewrite.ts`.
 */
export const CONTAINER_SLOT_OFFSET = 0x18;

/**
 * Where the index word at `0x15` begins, for a caller that wants the whole thing.
 *
 * `0x17` is the bank and `0x18` is the slot, which is why `device/safewrite.ts` excuses two bytes
 * rather than four: the top two are zero for every route that exists. A soundbank read from
 * `/soundbanks/H/1` carries 1,792 here, which is bank 7 and slot 0 rather than a flat 896, so the
 * two bytes are separate coordinates and not one number.
 */
export const CONTAINER_INDEX_OFFSET = 0x15;

/** Where the container header repeats the body length, as a big-endian u32. */
const HEAD_LENGTH_OFFSET = 25;

/**
 * Enough bytes to read it. The header is 31; this is the least that answers the question.
 *
 * It reaches one byte past the length field, because the answer depends on the compression flag at
 * `0x1D` as well as on the length at `0x19`.
 */
export const HEAD_LENGTH_MINIMUM = COMPRESSED_FLAG_OFFSET + 1;

/**
 * How long the whole file will be, from the first bytes of it.
 *
 * **The length is in the header as well as in the trailer.** `parsePayload` reads `storedLength`
 * from `raw.length - 8`, which is why it looks like a fact only available once the file is
 * complete — and on that reading a +Drive read could never report a percentage, only bytes
 * arriving. It can: the same number sits at header offset 25.
 *
 * Measured on two files four hundred times apart in size, header against trailer:
 *
 * | | header `+25` | trailer | file |
 * |---|---|---|---|
 * | a stored preset | **364** | 364 | 31 + 364 + 12 = 407 |
 * | a stored kit | **10,752** | 10,752 | 31 + 10,752 + 12 = 10,795 |
 *
 * Returns the **file** length, `LENGTH_BIAS` included, because that is what a caller counting
 * received bytes is comparing against.
 *
 * `undefined` for anything too short to answer, without the container magic, **or holding a
 * compressed body**. The field at `0x19` is the *uncompressed* length, which equals the body only
 * when `0x1D` says the body is raw. Every file on a computer is compressed, so for a `.dn2prj`
 * this field declares 12,889,604 against a 139,596-byte file and a bar built on it would finish at
 * one percent. Device reads are raw, which is the only reason this was ever right: the two
 * measurements below are both device reads, as is everything `drive.ts` and `backup.ts` pass here.
 *
 * This is used for a progress bar, so a wrong number is worse than none.
 */
export function fileLengthFromHead(head: Uint8Array): number | undefined {
  if (head.length < HEAD_LENGTH_MINIMUM) return undefined;
  if (!startsWith(head, CONTAINER_MAGIC)) return undefined;
  // A compressed body makes the declared length the decompressed size, which is not what a caller
  // counting arriving bytes is comparing against.
  if (containerIsCompressed(head) !== false) return undefined;

  const body =
    ((head[HEAD_LENGTH_OFFSET]! << 24) |
      (head[HEAD_LENGTH_OFFSET + 1]! << 16) |
      (head[HEAD_LENGTH_OFFSET + 2]! << 8) |
      head[HEAD_LENGTH_OFFSET + 3]!) >>>
    0;

  // A zero-length body is not a file this could describe, and it would make a bar divide by zero.
  return body > 0 ? body + LENGTH_BIAS : undefined;
}

export interface ProjectManifest {
  FormatVersion: string;
  /** Transfer-protocol device IDs this file targets. DN1 projects list ["24","30"]. */
  ProductType: string[];
  /** Name of the ZIP entry holding the binary payload. */
  Payload: string;
  FileType: string;
  /** Device OS version that wrote the file, e.g. "1.42A" (DN1) or "1.10E" (DN2). */
  FirmwareVersion: string;
}

export interface ProjectObject {
  /** Byte offset of the BEEFBACE magic within the payload. */
  offset: number;
  /** u32be version field following the magic. */
  version: number;
  /** Bytes from this object's magic up to the next object (or the footer). */
  data: Uint8Array;
}

export interface ProjectPayload {
  /** Value at 0x08: 9 on DN1, 15 on DN2. The device family, despite the name. */
  kind: number;
  /** What the container holds, at 0x0D. See `CONTENT_KIND`. */
  contentKind: number;
  /** ASCII format version at 0x09: "0097"/"0104" on DN1, "0050"/"0059" on DN2. */
  formatVersion: string;
  /** Object version at 0x11, big-endian. See `containerObjectVersion`. */
  objectVersion: number;
  /** Zero-based bank at 0x17. Non-zero only on soundbanks so far. */
  bank: number;
  /** Zero-based slot at 0x18. */
  slot: number;
  /** True when the body is an LZ4 chain, from the flag at 0x1D. */
  compressed: boolean;
  /** 32-bit check field from the footer. Algorithm not yet identified — preserved verbatim. */
  checkField: number;
  storedLength: number;
  computedLength: number;
  objects: ProjectObject[];
  /** The complete payload, so unparsed regions can be re-emitted untouched. */
  raw: Uint8Array;
}

export interface Project {
  manifest: ProjectManifest;
  payload: ProjectPayload;
}

export class ProjectParseError extends Error {}

function startsWith(data: Uint8Array, magic: Uint8Array, at = 0): boolean {
  for (let i = 0; i < magic.length; i++) if (data[at + i] !== magic[i]) return false;
  return true;
}

function findAll(data: Uint8Array, magic: Uint8Array): number[] {
  const hits: number[] = [];
  outer: for (let i = 0; i + magic.length <= data.length; i++) {
    for (let j = 0; j < magic.length; j++) if (data[i + j] !== magic[j]) continue outer;
    hits.push(i);
  }
  return hits;
}

const dv = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);

/** Parse the raw binary payload extracted from a project ZIP. */
export function parsePayload(raw: Uint8Array): ProjectPayload {
  if (raw.length < 64) throw new ProjectParseError(`Payload too short (${raw.length} bytes)`);
  if (!startsWith(raw, CONTAINER_MAGIC)) {
    throw new ProjectParseError("Payload does not start with the AC11D303 container magic");
  }
  if (!startsWith(raw, FOOTER_MAGIC, raw.length - 4)) {
    throw new ProjectParseError("Payload does not end with the AAA1DAAA footer magic");
  }

  const view = dv(raw);
  const objects = findAll(raw, OBJECT_MAGIC).map((offset, i, all) => ({
    offset,
    version: view.getUint32(offset + 4, false),
    data: raw.subarray(offset, all[i + 1] ?? raw.length - 12),
  }));

  return {
    kind: raw[8]!,
    contentKind: readBe32(raw, 0x0d),
    formatVersion: new TextDecoder("latin1").decode(raw.subarray(9, 13)),
    // Big-endian at 0x11. The old little-endian read at 0x14 straddled the index word and gave a
    // soundbank outside bank A a version of 117,440,514.
    objectVersion: readBe32(raw, 0x11),
    bank: raw[0x17]!,
    // One byte. The old u16le read byte 0x19 as the high half, which is the length's top byte and
    // zero for every file that exists.
    slot: raw[CONTAINER_SLOT_OFFSET]!,
    compressed: raw[COMPRESSED_FLAG_OFFSET] !== 0,
    checkField: view.getUint32(raw.length - 12, false),
    storedLength: view.getUint32(raw.length - 8, false),
    computedLength: raw.length - LENGTH_BIAS,
    objects,
    raw,
  };
}

export function isLengthValid(payload: ProjectPayload): boolean {
  return payload.storedLength === payload.computedLength;
}

/**
 * Minimal ZIP reader for project files.
 *
 * Project ZIPs hold two small entries that are either stored or deflated, so walking
 * the local file headers is enough — no need for the central directory.
 */

