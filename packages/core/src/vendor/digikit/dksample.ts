// The WAV to native sample converter and the +Drive content hash (packages/dksample, `dksample.wasm`): the code the card builder uses, so a sample sent over
// MidiRpc is byte for byte the file the +Drive build writes. `prepareUpload` decides what a file needs before it goes to the device.
// Written without TS-only runtime syntax so node can import it for the tests.
import { DkError } from './dkupload-core.js';

export interface SampleInfo {
  srcRate: number;
  channels: number;
  srcFrames: number;
  frames: number;
  /** Bytes of PCM. */
  dataLen: number;
}
export interface Converted {
  /** The native file the card builder writes: header, PCM and the 16-byte trailer of zeros. */
  file: Uint8Array;
  /** What goes over MidiRpc: the file without the trailer (the firmware adds its own at close). */
  rpc: Uint8Array;
  info: SampleInfo;
}

interface Exports {
  memory: WebAssembly.Memory;
  ds_alloc(n: number): number;
  ds_free(p: number, n: number): void;
  ds_convert(wav: number, len: number): number;
  ds_hash(data: number, len: number): number;
  ds_out_ptr(): number;
  ds_out_len(): number;
  ds_info_ptr(): number;
  ds_info_len(): number;
}

export class Sample {
  private x: Exports;
  private constructor(x: Exports) {
    this.x = x;
  }
  static async create(wasm: BufferSource): Promise<Sample> {
    const { instance } = await WebAssembly.instantiate(wasm, {});
    return new Sample(instance.exports as unknown as Exports);
  }

  private copy(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.x.memory.buffer.slice(ptr, ptr + len));
  }
  private withBytes<T>(b: Uint8Array, f: (p: number) => T): T {
    const p = this.x.ds_alloc(b.length);
    new Uint8Array(this.x.memory.buffer, p, b.length).set(b);
    try {
      return f(p);
    } finally {
      this.x.ds_free(p, b.length);
    }
  }

  /** A WAV (8 to 32 bit integer or float, any rate, one or two channels) as the native sample file at 48 kHz. Throws `DkError` kind `convert`. */
  convert(wav: Uint8Array): Converted {
    const rc = this.withBytes(wav, (p) => this.x.ds_convert(p, wav.length));
    const info = JSON.parse(new TextDecoder().decode(this.copy(this.x.ds_info_ptr(), this.x.ds_info_len())));
    if (rc !== 0) throw new DkError({ error: `not a usable WAV: ${info.error}`, kind: 'convert' });
    const file = this.copy(this.x.ds_out_ptr(), this.x.ds_out_len());
    return {
      file,
      rpc: file.subarray(0, info.rpc_len),
      info: {
        srcRate: info.src_rate,
        channels: info.channels,
        srcFrames: info.src_frames,
        frames: info.frames,
        dataLen: info.data_len,
      },
    };
  }

  /** The `hash | 1` the +Drive keeps of a file (record word +0x0c), over all the bytes the file holds. */
  hash(data: Uint8Array): number {
    return this.withBytes(data, (p) => this.x.ds_hash(p, data.length)) >>> 0;
  }
}

const NATIVE_TRAILER = 16;

/** The native sample test on the first 0x40 bytes of a file of `size` bytes. */
function nativeHead(h: Uint8Array, size: number): boolean {
  if (h.length < 0x40 || h[0] !== 0 || h[1]! > 1 || h[0x14] !== 0x7f) return false;
  const v = new DataView(h.buffer, h.byteOffset, h.length);
  const body = v.getUint32(4);
  return v.getUint32(8) === 48000 && (size === 0x40 + body || size === 0x40 + body + NATIVE_TRAILER);
}

/** Is `b` a native sample file (header: byte 0 is 0, byte 1 the stereo flag, +4 the PCM length, +8 the rate 48000, +0x14 is 0x7F), with or without the trailer? */
export const isNative = (b: Uint8Array): boolean => nativeHead(b, b.length);

export const isWav = (b: Uint8Array) =>
  b.length >= 12 &&
  String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' &&
  String.fromCharCode(...b.subarray(8, 12)) === 'WAVE';

export interface Prepared {
  /** The name on the device: a WAV loses its extension, as the card builder names it. */
  name: string;
  /** The bytes to send over the stock MidiRpc file commands (the firmware adds the trailer at close). */
  bytes: Uint8Array;
  /** The file the digikit store holds: the same native file as on the DT2's +Drive, so with its 16-byte trailer. Any other file is unchanged. */
  stored: Uint8Array;
  /** What was done: converted from a WAV, a native file passed on, or any other file unchanged. */
  kind: 'converted' | 'native' | 'unchanged';
  info?: SampleInfo;
}

/** What `prepareUpload` will do with a file of `size` bytes, from its first 64 bytes: the page labels the local files with it without reading them in full. */
export function sourceKind(head: Uint8Array, size: number): Prepared['kind'] {
  return isWav(head) ? 'converted' : nativeHead(head, size) ? 'native' : 'unchanged';
}

/** What a file needs before it goes to the +Drive: a WAV is converted, a native sample and any other file go unchanged. */
export function prepareUpload(sample: Sample, name: string, bytes: Uint8Array): Prepared {
  if (isWav(bytes)) {
    const c = sample.convert(bytes);
    return { name: name.replace(/\.wav$/i, ''), bytes: c.rpc, stored: c.file, kind: 'converted', info: c.info };
  }
  if (isNative(bytes)) {
    // a native file that carries its trailer goes without it: the firmware adds its own
    const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(4);
    const body = bytes.subarray(0, 0x40 + n);
    const stored = new Uint8Array(body.length + NATIVE_TRAILER);
    stored.set(body);
    return { name, bytes: body, stored, kind: 'native' };
  }
  return { name, bytes, stored: bytes, kind: 'unchanged' };
}
