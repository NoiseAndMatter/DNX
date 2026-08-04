/**
 * Minimal ZIP writer for project files.
 *
 * A .dnprj / .dn2prj is a ZIP holding exactly two entries: `manifest.json` and the binary
 * payload. That is all this needs to produce — no directories, no zip64, no reading.
 *
 * Hand-rolled rather than pulled from npm so the eventual browser build carries no
 * Node-only archive dependency. The one Node import here (`zlib`) is swappable for
 * CompressionStream in a browser build — `web/src/zip.ts` is that swap, and `test/web.test.ts`
 * checks the two agree.
 *
 * ## Why this is in `src/node/`
 *
 * Everything else under `src/` is platform-free and shared byte for byte with the browser. This is
 * not: it imports `node:zlib`. That used to be expressed as a filename in `tsconfig.web.json`'s
 * exclude list, which is a boundary somebody has to remember — and forgetting would drag Node into
 * the browser bundle, where it fails at page load with an unhelpful error.
 *
 * The directory *is* the boundary now. `tsconfig.web.json` excludes `src/node/**`, and
 * `test/web.test.ts` fails if anything outside `src/node/` or `src/cli/` imports a `node:` module.
 */

import { crc32, deflateRawSync } from "node:zlib";

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const VERSION = 20;
const METHOD_DEFLATE = 8;

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const deflated = new Uint8Array(deflateRawSync(entry.data));
    const checksum = crc32(entry.data) >>> 0;

    const local = new Uint8Array(30 + name.length + deflated.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
    lv.setUint16(4, VERSION, true);
    lv.setUint16(8, METHOD_DEFLATE, true);
    lv.setUint32(14, checksum, true);
    lv.setUint32(18, deflated.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(deflated, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
    cv.setUint16(4, VERSION, true);
    cv.setUint16(6, VERSION, true);
    cv.setUint16(10, METHOD_DEFLATE, true);
    cv.setUint32(16, checksum, true);
    cv.setUint32(20, deflated.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const chunk of [...locals, ...centrals, end]) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
