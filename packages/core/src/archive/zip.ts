/**
 * The ZIP container, with the compression codec passed in.
 *
 * A `.dnprj`, a `.dn2prj` and a `.dnx` are all ZIP files, and DNX both writes and reads them on
 * two hosts: `node:zlib` on the command line, `CompressionStream` in a browser, and whatever
 * Android provides next. Everything except the compression is the same work on all of them —
 * local headers, the central directory, the end record and CRC-32 — so it is written once here
 * and each host hands in its own codec.
 *
 * ## Why the codec is a parameter and not an import
 *
 * There were two copies of this file, one per host, and they had already drifted: one carried its
 * own CRC-32 table, the other took zlib's, and only a reading of both said whether the bytes came
 * out the same. The container is an external contract — Elektron Transfer and the instruments'
 * own tooling open what DNX writes — and a contract with two implementations is a contract nobody
 * is holding. `test/archive.test.ts` pins it field by field.
 *
 * ## Why there are synchronous and asynchronous pairs
 *
 * `deflateRawSync` returns bytes; `CompressionStream` returns a promise. Neither host can be made
 * to look like the other without cost: making the library async would change forty call sites and
 * every CLI command for the benefit of a browser, and making the browser sync is not possible at
 * all. So the container work is written once, and `buildZip`/`buildZipAsync` and
 * `readZip`/`readZipAsync` are the two four-line ways of reaching it.
 *
 * ## What this does not do
 *
 * No directories, no ZIP64, no encryption, no data descriptors. A project file holds two entries
 * and a backup holds a flat list of them, which is the whole of what DNX has ever needed. An
 * input using anything else is refused by name rather than read wrongly.
 */

/** ZIP local file header magic, and the flag bit that marks a streaming data descriptor. */
const LOCAL_HEADER = 0x0403_4b50;
const CENTRAL_HEADER = 0x0201_4b50;
const END_OF_CENTRAL = 0x0605_4b50;
const STREAMING_FLAG = 0x08;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/**
 * The version field both headers carry, as DNX has always written it.
 *
 * Elektron's own writer puts 10 in the local header and sets the UTF-8 name flag; DNX writes 20
 * and no flags, and Transfer and the instruments read both. Pinned rather than corrected, because
 * these are bytes that already work.
 */
const VERSION = 20;

/** A file that is not a ZIP, or is one this reader will not guess at. */
export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** A host's raw-deflate compressor. Raw: no zlib or gzip wrapper, as ZIP method 8 requires. */
export type Deflate = (data: Uint8Array) => Uint8Array;
export type DeflateAsync = (data: Uint8Array) => Promise<Uint8Array>;
export type Inflate = (data: Uint8Array) => Uint8Array;
export type InflateAsync = (data: Uint8Array) => Promise<Uint8Array>;

/** Standard CRC-32, as ZIP requires. Not the zero-init variant the payload check field uses. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffff_ffff) >>> 0;
}

/** One entry as it sits in the file: compressed, and with the method that compressed it. */
interface PackedEntry {
  name: string;
  method: number;
  compressed: Uint8Array;
  /** Of the original bytes, not of `compressed`. */
  crc: number;
  size: number;
}

/**
 * Split a ZIP into its entries without decompressing any of them.
 *
 * Reads the local headers in order and stops at the first thing that is not one, which is how the
 * central directory is reached. The directory is not consulted: the entries are all DNX writes
 * and all it needs, and a reader that trusted the directory over the headers would accept a file
 * whose two halves disagreed.
 */
function packedEntriesOf(file: Uint8Array): PackedEntry[] {
  const entries: PackedEntry[] = [];
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let at = 0;

  while (at + 30 <= file.length && view.getUint32(at, true) === LOCAL_HEADER) {
    const flags = view.getUint16(at + 6, true);
    const method = view.getUint16(at + 8, true);
    const crc = view.getUint32(at + 14, true);
    const compressedSize = view.getUint32(at + 18, true);
    const size = view.getUint32(at + 22, true);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(file.subarray(at + 30, at + 30 + nameLength));
    const dataStart = at + 30 + nameLength + extraLength;

    if (compressedSize === 0 && (flags & STREAMING_FLAG) !== 0) {
      throw new ZipError(`entry "${name}" uses a streaming data descriptor, which is not supported`);
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new ZipError(`entry "${name}" uses unsupported compression method ${method}`);
    }

    entries.push({ name, method, compressed: file.subarray(dataStart, dataStart + compressedSize), crc, size });
    at = dataStart + compressedSize;
  }

  if (entries.length === 0) throw new ZipError("no ZIP entries found — not a project file");
  return entries;
}

/**
 * Assemble the container around entries that are already compressed.
 *
 * Everything a ZIP holds apart from the compressed bytes themselves. The modification time and
 * date are left zero and the external attributes empty: DNX writes no timestamp, so two runs over
 * the same input produce the same file, which is what makes a byte comparison worth anything.
 */
function containerOf(parts: readonly PackedEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const part of parts) {
    const name = new TextEncoder().encode(part.name);

    const local = new Uint8Array(30 + name.length + part.compressed.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_HEADER, true);
    localView.setUint16(4, VERSION, true); // version needed
    localView.setUint16(8, part.method, true);
    localView.setUint32(14, part.crc, true);
    localView.setUint32(18, part.compressed.length, true);
    localView.setUint32(22, part.size, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(part.compressed, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_HEADER, true);
    centralView.setUint16(4, VERSION, true); // version made by
    centralView.setUint16(6, VERSION, true); // version needed
    centralView.setUint16(10, part.method, true);
    centralView.setUint32(16, part.crc, true);
    centralView.setUint32(20, part.compressed.length, true);
    centralView.setUint32(24, part.size, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL, true);
  endView.setUint16(8, parts.length, true);
  endView.setUint16(10, parts.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const chunk of [...locals, ...centrals, end]) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function packed(entry: ZipEntry, compressed: Uint8Array): PackedEntry {
  return {
    name: entry.name,
    method: METHOD_DEFLATE,
    compressed,
    crc: crc32(entry.data),
    size: entry.data.length,
  };
}

/** Build a ZIP with one deflated entry per input, in the order given. */
export function buildZip(entries: readonly ZipEntry[], deflate: Deflate): Uint8Array {
  return containerOf(entries.map((entry) => packed(entry, deflate(entry.data))));
}

/** The same, for a host whose compressor is asynchronous. */
export async function buildZipAsync(
  entries: readonly ZipEntry[],
  deflate: DeflateAsync,
): Promise<Uint8Array> {
  const parts: PackedEntry[] = [];
  for (const entry of entries) parts.push(packed(entry, await deflate(entry.data)));
  return containerOf(parts);
}

/** Read every entry of a ZIP, decompressing what needs it. */
export function readZip(file: Uint8Array, inflate: Inflate): Map<string, Uint8Array> {
  return new Map(
    packedEntriesOf(file).map((entry) => [
      entry.name,
      entry.method === METHOD_STORED ? entry.compressed : inflate(entry.compressed),
    ]),
  );
}

/** The same, for a host whose decompressor is asynchronous. */
export async function readZipAsync(
  file: Uint8Array,
  inflate: InflateAsync,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const entry of packedEntriesOf(file)) {
    out.set(entry.name, entry.method === METHOD_STORED ? entry.compressed : await inflate(entry.compressed));
  }
  return out;
}
