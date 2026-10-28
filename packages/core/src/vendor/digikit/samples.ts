// Samples on a device, one API over two backends (docs/plans/storage.md). The device profile's `[storage] samples` names the backend:
//   "stock-rpc"  the device's own MidiRpc file commands, the +Drive its sample browser lists (rpcfiles.ts; the Digitakt II)
//   "digikit"    the `samples/` folder of the digikit store, the runtime's SysEx commands (`DkSession`; the Digitone II)
// Both take the file `prepareUpload` (dksample.ts) makes, the same native sample file, so a sampling engine reads one format. The result of a verify has one
// shape on both: what the device keeps against what the host sent. Written without TS-only runtime syntax so node can import it.
import { DkError, hasCap, hexSha256, storeSpace } from './dkupload-core.js';
import type { DkEntry, DkInfoFull, DkSession } from './dkupload-core.js';
import type { Prepared } from './dksample.js';
import { RpcFiles, verifyWritten } from './rpcfiles.js';
import type { RpcPort } from './rpcfiles.js';

export type SamplesKind = 'stock-rpc' | 'digikit';

/** A file or a folder of the listing; `size` is what the device reports. */
export interface SampleEntry {
  name: string;
  kind: 'file' | 'folder';
  size: number;
}
export interface SampleSpace {
  free: number;
  /** null when the device does not say. */
  total: number | null;
}
export interface SampleVerified {
  ok: boolean;
  /** The device's hash of the stored file (hex), null when it does not have the file. For a file checked in ranges: the hash of the first range that differs. */
  device: string | null;
  /** The host's hash of the same bytes (hex). */
  host: string;
  /** The size the device reports and the bytes of the file the host sent. */
  size: number | null;
  sent: number;
  /** Offset of the first range that differs (digikit), else null. */
  mismatchAt: number | null;
  /** What was compared, and a line for the page: "device sha256 matches", "device content hash matches", or why not. */
  compared: string;
  message: string;
}

export interface SamplesBackend {
  readonly kind: SamplesKind;
  /** The files and folders directly in `folder` ('' is the top). */
  list(folder?: string): Promise<SampleEntry[]>;
  space(): Promise<SampleSpace>;
  /** Whether `mkdir` of an empty folder works (the digikit store needs the runtime's FOLDERS capability). */
  canMkdir(): Promise<boolean>;
  mkdir(folder: string): Promise<void>;
  /** Remove an empty folder. */
  rmdir(folder: string): Promise<void>;
  put(folder: string, file: Prepared, onProgress?: (sent: number, total: number) => void): Promise<void>;
  /** Compare the stored file with `file` (a device that does not have it, or has other bytes, reports `ok` false). */
  verify(folder: string, file: Prepared): Promise<SampleVerified>;
  remove(folder: string, name: string): Promise<void>;
}

/** What the digikit backend needs of the store session (`DkSession`). */
export type StorePort = Pick<DkSession, 'info' | 'list' | 'mkdir' | 'put' | 'delete' | 'verify' | 'capacity'>;

export interface SamplesOptions {
  /** The transport of the commands: one `DkSession` serves both backends. */
  session: StorePort & RpcPort;
  /** The +Drive content hash (`Sample.hash`); needed by "stock-rpc". */
  hashOf?: (data: Uint8Array) => number;
}

/** The backend for the profile's `[storage] samples` value. */
export function openSamples(kind: string, o: SamplesOptions): SamplesBackend {
  if (kind === 'stock-rpc') {
    if (!o.hashOf) throw new DkError({ error: 'stock-rpc samples need the content hash (dksample)', kind: 'usage' });
    return new RpcSamples(new RpcFiles(o.session), o.hashOf);
  }
  if (kind === 'digikit') return new StoreSamples(o.session);
  throw new DkError({ error: `unknown samples backend "${kind}" (stock-rpc or digikit)`, kind: 'usage' });
}

const clean = (folder: string) => folder.replace(/^\/+|\/+$/g, '');
const join = (folder: string, name: string) => {
  if (!name || name.includes('/') || name.includes('\0'))
    throw new DkError({ error: `not a file name: "${name}"`, kind: 'usage' });
  const f = clean(folder);
  return f ? `${f}/${name}` : name;
};
const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, '0');

// ---- the +Drive over MidiRpc ----------------------------------------------------------------------------------------------------

class RpcSamples implements SamplesBackend {
  readonly kind = 'stock-rpc' as const;
  private files: RpcFiles;
  private hashOf: (data: Uint8Array) => number;
  constructor(files: RpcFiles, hashOf: (data: Uint8Array) => number) {
    this.files = files;
    this.hashOf = hashOf;
  }
  async list(folder = '') {
    const rows = await this.files.readDir(`/${clean(folder)}`);
    return rows.map((e) => ({
      name: e.name,
      kind: e.kind === 'D' ? ('folder' as const) : ('file' as const),
      size: e.size,
    }));
  }
  async space() {
    const s = await this.files.space();
    return { free: Number(s.free), total: Number(s.total) };
  }
  async canMkdir() {
    return true;
  }
  mkdir(folder: string) {
    return this.files.mkdir(clean(folder));
  }
  rmdir(folder: string) {
    return this.files.rmdir(clean(folder));
  }
  async put(folder: string, file: Prepared, onProgress?: (sent: number, total: number) => void) {
    await this.files.write(join(folder, file.name), file.bytes, onProgress);
  }
  async verify(folder: string, file: Prepared): Promise<SampleVerified> {
    const v = await verifyWritten(this.files, join(folder, file.name), file.bytes, this.hashOf);
    return {
      ok: v.ok,
      device: v.firmware === null ? null : hex8(v.firmware),
      host: hex8(v.host),
      size: v.size,
      sent: v.sent,
      mismatchAt: null,
      compared: v.compared,
      message: v.ok
        ? 'device content hash matches'
        : v.firmware === null
          ? 'the device does not have the file'
          : 'device content hash differs',
    };
  }
  async remove(folder: string, name: string) {
    return this.files.remove(join(folder, name));
  }
}

// ---- the digikit store ----------------------------------------------------------------------------------------------------------

/** The folder of the store that holds samples. */
export const STORE_FOLDER = 'samples';
/** VERIFY covers at most this many bytes of a file at a time (the device hashes about 2 MB a second: a request for a large file would outlast the timeout). */
export const VERIFY_PIECE = 1 << 20;

const isFolderEntry = (e: DkEntry) => e.size === 0 && /^0+$/.test(e.sha256);

class StoreSamples implements SamplesBackend {
  readonly kind = 'digikit' as const;
  private s: StorePort;
  private caps?: Promise<DkInfoFull>;
  constructor(session: StorePort) {
    this.s = session;
  }
  private info() {
    return (this.caps ??= this.s.info());
  }
  private async folders() {
    return hasCap(await this.info(), 'FOLDERS'); // runtime 0.3.0: LIST by prefix, MKDIR
  }
  /** The store's entries whose path starts with `prefix`: the runtime filters (and pages) when it can, else the host does. */
  private async under(prefix: string): Promise<DkEntry[]> {
    if (await this.folders()) return this.s.list(prefix);
    return (await this.s.list()).filter((e) => e.path.startsWith(prefix));
  }
  private path(folder: string) {
    const f = clean(folder);
    return f ? `${STORE_FOLDER}/${f}` : STORE_FOLDER;
  }
  async list(folder = '') {
    const prefix = `${this.path(folder)}/`;
    const out = new Map<string, SampleEntry>();
    for (const e of await this.under(prefix)) {
      const rest = e.path.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash >= 0) out.set(rest.slice(0, slash), { name: rest.slice(0, slash), kind: 'folder', size: 0 });
      else if (isFolderEntry(e)) out.set(rest, { name: rest, kind: 'folder', size: 0 });
      else out.set(rest, { name: rest, kind: 'file', size: e.size });
    }
    return [...out.values()];
  }
  async space() {
    return storeSpace(this.s);
  }
  canMkdir() {
    return this.folders();
  }
  async mkdir(folder: string) {
    if (!(await this.folders())) throw new DkError({ error: 'this runtime has no folder entries', kind: 'usage' });
    await this.s.mkdir(this.path(folder));
  }
  async rmdir(folder: string) {
    // a folder entry is an entry of the store; a folder with files in it is only implied by their paths (nothing to delete)
    await this.s.delete(this.path(folder));
  }
  async put(folder: string, file: Prepared, onProgress?: (sent: number, total: number) => void) {
    return this.s.put(this.path(join(folder, file.name)), file.stored, onProgress);
  }
  async verify(folder: string, file: Prepared): Promise<SampleVerified> {
    const path = this.path(join(folder, file.name));
    const want = file.stored;
    const host = await hexSha256(want);
    const entry = (await this.under(path)).find((e) => e.path === path && !isFolderEntry(e));
    const base = {
      host,
      sent: want.length,
      mismatchAt: null,
      compared: 'the device sha256 of the stored file, read from the card (VERIFY), with the sha256 of the bytes sent',
    };
    if (!entry) return { ...base, ok: false, device: null, size: null, message: 'the device does not have the file' };
    // one VERIFY for a small file, ranges of VERIFY_PIECE for a large one (all the ranges equal: the whole file is equal)
    let device = host;
    let mismatchAt: number | null = null;
    for (let off = 0; off < Math.max(1, want.length); off += VERIFY_PIECE) {
      const part = want.subarray(off, Math.min(want.length, off + VERIFY_PIECE));
      const whole = want.length <= VERIFY_PIECE;
      const got = whole ? await this.s.verify(path) : await this.s.verify(path, off, part.length);
      if (got !== (whole ? host : await hexSha256(part))) {
        device = got;
        mismatchAt = off;
        break;
      }
    }
    const ok = mismatchAt === null && entry.size === want.length;
    return {
      ...base,
      ok,
      device,
      size: entry.size,
      mismatchAt,
      message: ok
        ? 'device sha256 matches'
        : mismatchAt === null
          ? 'the device file has another size'
          : 'device sha256 differs',
    };
  }
  async remove(folder: string, name: string) {
    return this.s.delete(this.path(join(folder, name)));
  }
}
