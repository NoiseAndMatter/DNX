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
 * Payload layout (verified across 53 DN1 projects and 1 DN2 project):
 *
 *   0x00  AC 11 D3 03      container magic
 *   0x04  u16le, u16le     2, 5 in every file seen
 *   0x08  u8               9 on DN1, 15 on DN2
 *   0x09  4 x ASCII        format version, "0097" on DN1, "0050" on DN2
 *   0x0D  3 bytes          zero
 *   0x10  u32le            1 in every file seen
 *   0x14  u32le            object version — matches the root object's own version
 *   0x18  u16le            PROJECT SLOT (0-based; matches the 001..053 filenames)
 *   0x1A  ...              unidentified; byte 0x23..0x24 is the constant tag F0 05
 *   0x25  first object     start of the object chain
 *
 *   end-12  u32be          32-bit check field, algorithm unidentified
 *   end-8   u32be          length == payloadLength - 43
 *   end-4   AA A1 DA AA    container footer magic
 *
 * Note the mixed endianness: container header fields are little-endian, while object
 * headers are big-endian. That is what the bytes say in every file checked.
 *
 * Objects are marked by the magic BE EF BA CE followed by a u32be version. The same
 * BEEFBACE magic heads DN1 sound dumps over SysEx, so objects are shared between the
 * two transports.
 */

export const CONTAINER_MAGIC = Uint8Array.of(0xac, 0x11, 0xd3, 0x03);
export const FOOTER_MAGIC = Uint8Array.of(0xaa, 0xa1, 0xda, 0xaa);
export const OBJECT_MAGIC = Uint8Array.of(0xbe, 0xef, 0xba, 0xce);

/** Difference between payload length and the stored length field. Constant in all files seen. */
export const LENGTH_BIAS = 43;

/** Where the container header repeats the body length, as a big-endian u32. */
const HEAD_LENGTH_OFFSET = 25;

/** Enough bytes to read it. The header is 31; this is the least that answers the question. */
export const HEAD_LENGTH_MINIMUM = HEAD_LENGTH_OFFSET + 4;

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
 * `undefined` for anything too short to answer, or without the container magic. This is used for a
 * progress bar, so a wrong number is worse than none — a bar that overshoots its own total says
 * the thing it exists to say, wrongly.
 */
export function fileLengthFromHead(head: Uint8Array): number | undefined {
  if (head.length < HEAD_LENGTH_MINIMUM) return undefined;
  if (!startsWith(head, CONTAINER_MAGIC)) return undefined;

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
  /** Value at 0x08: 9 on DN1, 15 on DN2. */
  kind: number;
  /** ASCII format version at 0x09, "0097" on DN1 and "0050" on DN2. */
  formatVersion: string;
  /** Object version at 0x14. */
  objectVersion: number;
  /** Zero-based project slot at 0x18. */
  slot: number;
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
    formatVersion: new TextDecoder("latin1").decode(raw.subarray(9, 13)),
    objectVersion: view.getUint32(0x14, true),
    slot: view.getUint16(0x18, true),
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

