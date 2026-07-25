/**
 * ZIP reading and writing for the browser.
 *
 * The library's own ZIP layer uses `node:zlib`, which is synchronous and unavailable here.
 * The web platform offers `DecompressionStream` and `CompressionStream` instead, which are
 * asynchronous — so rather than making the library async for everyone, the browser keeps its
 * own small ZIP implementation and hands the library what it actually wants: the payload
 * bytes.
 *
 * That leaves the hardware-validated write path in `src/project/write.ts` untouched. Both
 * sides produce ordinary method-8 entries; only the code that gets them there differs.
 */

/** ZIP local file header magic, and the flag bit that marks a streaming data descriptor. */
const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const STREAMING_FLAG = 0x08;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export class ZipError extends Error {}

async function through(data: Uint8Array, stream: GenericTransformStream): Promise<Uint8Array> {
  // The DOM lib types these streams as BufferSource-in / Uint8Array-out, which pipeThrough
  // cannot express; the cast is to the shape the runtime actually provides.
  const piped = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

const inflateRaw = (data: Uint8Array) => through(data, new DecompressionStream("deflate-raw"));
const deflateRaw = (data: Uint8Array) => through(data, new CompressionStream("deflate-raw"));

/** Standard CRC-32, as ZIP requires. Not the zero-init variant the payload check field uses. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Read every entry of a ZIP file, decompressing what needs it. */
export async function readZip(file: Uint8Array): Promise<Map<string, Uint8Array>> {
  const entries = new Map<string, Uint8Array>();
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let at = 0;

  while (at + 30 <= file.length && view.getUint32(at, true) === LOCAL_HEADER) {
    const flags = view.getUint16(at + 6, true);
    const method = view.getUint16(at + 8, true);
    const compressedSize = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(file.subarray(at + 30, at + 30 + nameLength));
    const dataStart = at + 30 + nameLength + extraLength;

    if (compressedSize === 0 && (flags & STREAMING_FLAG) !== 0) {
      throw new ZipError(`entry "${name}" uses a streaming data descriptor, which is not supported`);
    }

    const chunk = file.subarray(dataStart, dataStart + compressedSize);
    if (method === METHOD_STORED) entries.set(name, chunk);
    else if (method === METHOD_DEFLATE) entries.set(name, await inflateRaw(chunk));
    else throw new ZipError(`entry "${name}" uses unsupported compression method ${method}`);

    at = dataStart + compressedSize;
  }

  if (entries.size === 0) throw new ZipError("no ZIP entries found — not a project file");
  return entries;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** Build a ZIP file with one deflated entry per input, in the order given. */
export async function buildZip(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const deflated = await deflateRaw(entry.data);
    const checksum = crc32(entry.data);

    const local = new Uint8Array(30 + name.length + deflated.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_HEADER, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(8, METHOD_DEFLATE, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, deflated.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(deflated, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_HEADER, true);
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed
    centralView.setUint16(10, METHOD_DEFLATE, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, deflated.length, true);
    centralView.setUint32(24, entry.data.length, true);
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
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
