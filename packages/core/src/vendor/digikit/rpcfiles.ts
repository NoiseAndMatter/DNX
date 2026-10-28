// The stock MidiRpc file commands of the Digitakt II (docs/MIDI-SYSEX-RPC.md section 12): the +Drive, the filesystem the device's own sample browser
// lists. A generic client over `DkSession.rpc`: it knows the commands, not the device (which device uses it for samples is the profile's `[storage]`).
// Every FsSample reply starts with a status byte, 1 for OK. Integers are big-endian. Written without TS-only runtime syntax so node can import it.
import { DkError, be32, concat, u32 } from './dkupload-core.js';

export const RPC_FILE = {
  STORAGE_SPACE: 0x05,
  READ_DIR: 0x10,
  CREATE_DIR: 0x11,
  DELETE_DIR: 0x12,
  DELETE_FILE: 0x20,
  RENAME_FILE: 0x21,
  FILE_INFO_V2: 0x28,
  OPEN_WRITE: 0x40,
  CLOSE_WRITE: 0x41,
  WRITE_V1: 0x42,
} as const;

/** The status byte of an OK reply. */
export const RPC_OK = 1;
/** A path is a C-string of fewer than 256 bytes. */
export const MAX_PATH = 255;
/** Data bytes in one WriteFileV1 or ReadFileV1 request. */
export const RPC_CHUNK = 2048;

export interface RpcEntry {
  /** `hash | 1` of the file, trailer included; 0 for a folder. */
  hash: number;
  /** The size without the 16-byte trailer the firmware adds at close (the bytes the host sent). */
  size: number;
  flag: number;
  kind: 'D' | 'F';
  name: string;
}
export interface RpcFileInfo {
  found: boolean;
  size: number;
  hash: number;
}
/** What a close answers: the record id of the file (not its hash: `info` and `readDir` give that) and its size without the trailer. */
export interface RpcClosed {
  id: number;
  size: number;
}
export interface RpcSpace {
  free: bigint;
  total: bigint;
}
/** The transport of the requests: `DkSession` (`rpc` takes its turn with the other requests). */
export interface RpcPort {
  rpc(type: number, payload?: Uint8Array, timeoutMs?: number): Promise<Uint8Array>;
  /** Data bytes per write request this link takes (`DkTransport.rpcChunk`); `RPC_CHUNK` when absent. */
  readonly rpcChunk?: number;
}

const text = new TextEncoder();
const textIn = new TextDecoder();

/**
 * A path as the C-string of a request, always absolute: OpenFileForWrite with a bare name (`kick`) fails and makes a folder of that name, while
 * `/kick` and `/drums/kick` work **[D]** (emulator). A folder of the path must exist for a file in it; `RpcFiles.write` makes it.
 */
export function pathBytes(path: string): Uint8Array {
  const b = text.encode(`/${path.replace(/^\/+/, '')}`);
  if (b.length > MAX_PATH || b.includes(0))
    throw new DkError({ error: `path too long or with a NUL: ${path}`, kind: 'usage' });
  return concat(b, Uint8Array.of(0));
}

const fail = (what: string, status: number) =>
  new DkError({ error: `${what}: the device answered status ${status}`, kind: 'device', status: `RPC_${status}` });

/** The big-endian u64 at `at`. */
const u64 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0);

export class RpcFiles {
  private port: RpcPort;
  private chunk: number;
  private timeoutMs?: number;
  constructor(port: RpcPort, options: { chunk?: number; timeoutMs?: number } = {}) {
    this.port = port;
    this.chunk = options.chunk ?? port.rpcChunk ?? RPC_CHUNK;
    this.timeoutMs = options.timeoutMs;
  }

  /** One command; the reply after its status byte. A status other than OK is an error. */
  private async call(type: number, what: string, payload: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
    const r = await this.port.rpc(type, payload, this.timeoutMs);
    if (r.length === 0) throw new DkError({ error: `${what}: empty reply`, kind: 'protocol' });
    if (r[0] !== RPC_OK) throw fail(what, r[0]!);
    return r.subarray(1);
  }

  /** The entries of a folder (`.` and `..` are not listed by the firmware). */
  async readDir(path = '/'): Promise<RpcEntry[]> {
    // ReadDir has no status byte: the reply is the entries (an unknown path answers an empty list)
    const r = await this.port.rpc(RPC_FILE.READ_DIR, pathBytes(path), this.timeoutMs);
    const out: RpcEntry[] = [];
    let at = 0;
    while (at + 10 <= r.length) {
      const end = r.indexOf(0, at + 10);
      if (end < 0) throw new DkError({ error: 'readDir: an entry without NUL', kind: 'protocol' });
      const kind = String.fromCharCode(r[at + 9]!);
      if (kind !== 'D' && kind !== 'F')
        throw new DkError({ error: `readDir: unknown entry type ${kind}`, kind: 'protocol' });
      out.push({
        hash: u32(r, at),
        size: u32(r, at + 4),
        flag: r[at + 8]!,
        kind,
        name: textIn.decode(r.subarray(at + 10, end)),
      });
      at = end + 1;
    }
    return out;
  }

  /** Free and total bytes of a drive: 1 is the +Drive (drive 0 answers status 0). The reply is 17 bytes (status, two u64) or 20 (seen once on a real device: the last 16 are the numbers). */
  async space(drive = 1): Promise<RpcSpace> {
    const r = await this.port.rpc(RPC_FILE.STORAGE_SPACE, Uint8Array.of(drive), this.timeoutMs);
    if (r.length < 17) throw new DkError({ error: `space: a ${r.length}-byte reply`, kind: 'protocol' });
    const at = r.length - 16;
    if (r[at - 1] !== RPC_OK) throw fail('space', r[at - 1]!);
    return { free: u64(r, at), total: u64(r, at + 8) };
  }

  /** `mkdir -p`. */
  async mkdir(path: string): Promise<void> {
    await this.call(RPC_FILE.CREATE_DIR, `mkdir ${path}`, pathBytes(path));
  }
  /** Remove an empty folder. */
  async rmdir(path: string): Promise<void> {
    await this.call(RPC_FILE.DELETE_DIR, `rmdir ${path}`, pathBytes(path));
  }
  async remove(path: string): Promise<void> {
    await this.call(RPC_FILE.DELETE_FILE, `remove ${path}`, pathBytes(path));
  }
  async rename(from: string, to: string): Promise<void> {
    await this.call(RPC_FILE.RENAME_FILE, `rename ${from}`, concat(pathBytes(from), pathBytes(to)));
  }

  /** GetFileInfoV2: whether the path is a file, its size without the trailer and its `hash | 1`. */
  async info(path: string): Promise<RpcFileInfo> {
    const r = await this.port.rpc(RPC_FILE.FILE_INFO_V2, pathBytes(path), this.timeoutMs);
    if (r.length < 9) throw new DkError({ error: `info: a ${r.length}-byte reply`, kind: 'protocol' });
    return { found: r[0] === RPC_OK, size: u32(r, 1), hash: u32(r, 5) };
  }

  /**
   * Write a file: mkdir -p of its folder, OpenFileForWrite, WriteFileV1 in chunks (sequential offsets), CloseFileWriter with the byte count.
   * The firmware appends a 16-byte trailer at close and hashes the file with it; the reply says the record id and the size without the trailer.
   * The firmware closes a writer that is idle for 20 s, so the chunks follow one another. A failed write closes nothing: the caller removes the file.
   */
  async write(
    path: string,
    data: Uint8Array,
    onProgress: (sent: number, total: number) => void = () => {},
  ): Promise<RpcClosed> {
    const slash = path.replace(/^\/+/, '').lastIndexOf('/');
    if (slash > 0) await this.mkdir(path.replace(/^\/+/, '').slice(0, slash));
    const open = await this.call(RPC_FILE.OPEN_WRITE, `open ${path}`, concat(be32(0), pathBytes(path)));
    if (open.length < 4) throw new DkError({ error: `open ${path}: a short reply`, kind: 'protocol' });
    const handle = u32(open, 0);
    let sent = 0;
    try {
      for (; sent < data.length;) {
        const part = data.subarray(sent, Math.min(data.length, sent + this.chunk));
        const r = await this.call(
          RPC_FILE.WRITE_V1,
          `write ${path} at ${sent}`,
          concat(be32(handle), be32(part.length), be32(sent), part),
        );
        if (r.length >= 4 && u32(r, 0) !== sent + part.length)
          throw new DkError({
            error: `write ${path}: the device is at ${u32(r, 0)}, expected ${sent + part.length}`,
            kind: 'protocol',
          });
        sent += part.length;
        onProgress(sent, data.length);
      }
      if (data.length === 0) onProgress(0, 0);
      const r = await this.call(RPC_FILE.CLOSE_WRITE, `close ${path}`, concat(be32(handle), be32(data.length)));
      if (r.length < 8) throw new DkError({ error: `close ${path}: a short reply`, kind: 'protocol' });
      return { id: u32(r, 0), size: u32(r, 4) };
    } catch (e) {
      // an abandoned writer may block the next open until the firmware's 20 s timer closes it (not tried **[O]**), so close it here (the half file stays: remove it)
      await this.port.rpc(RPC_FILE.CLOSE_WRITE, concat(be32(handle), be32(sent)), this.timeoutMs).catch(() => {});
      throw e;
    }
  }
}

/** The trailer the firmware adds at close: 16 bytes, zeros when the file is written over MidiRpc (the hash below proves it **[D]**: emulator only). */
export const TRAILER = new Uint8Array(16);

export interface RpcVerified {
  ok: boolean;
  /** What the device keeps: its `hash | 1` of the stored file, or null when it does not know the path. */
  firmware: number | null;
  /** What the host computed over the bytes it sent and the trailer. */
  host: number;
  /** The size the device reports (without the trailer) and the bytes sent. */
  size: number | null;
  sent: number;
  /** What was compared, for a message. */
  compared: string;
}

/**
 * The device's own content hash of a written file against the host's: `hashOf` (`Sample.hash`, the +Drive's `hash | 1`) over the bytes sent and the 16-byte trailer
 * the firmware appended. The hash is the firmware's, computed when it closed the file from the card, so it covers what is stored, not what was sent.
 */
export async function verifyWritten(
  files: RpcFiles,
  path: string,
  sent: Uint8Array,
  hashOf: (data: Uint8Array) => number,
): Promise<RpcVerified> {
  const stored = concat(sent, TRAILER);
  const host = hashOf(stored) >>> 0;
  const info = await files.info(path);
  const firmware = info.found ? info.hash >>> 0 : null;
  return {
    ok: info.found && info.size === sent.length && firmware === host,
    firmware,
    host,
    size: info.found ? info.size : null,
    sent: sent.length,
    compared:
      'the firmware hash|1 of the stored file (GetFileInfoV2) with the content hash of the bytes sent plus a 16-byte zero trailer',
  };
}

/** Write a file into the +Drive (`RpcFiles.write` makes its folder) and check it with `verifyWritten`. */
export async function putVerified(
  files: RpcFiles,
  path: string,
  data: Uint8Array,
  hashOf: (data: Uint8Array) => number,
  onProgress?: (sent: number, total: number) => void,
): Promise<{ closed: RpcClosed; verified: RpcVerified }> {
  const closed = await files.write(path, data, onProgress);
  return { closed, verified: await verifyWritten(files, path, data, hashOf) };
}
