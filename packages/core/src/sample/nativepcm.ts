/**
 * The audio in a native sample file, for a preview on the host.
 *
 * The native file is the one digikit's converter writes and the store holds: a 64-byte header,
 * big-endian int16 PCM with stereo frames interleaved (L, R), then a 16-byte trailer. The header
 * fields used here are digikit's `isNative` test (`vendor/digikit/dksample.ts`): byte 1 is the
 * stereo flag, +4 the PCM length in bytes and +8 the rate.
 */

const HEADER = 0x40;

export interface NativeAudio {
  rate: number;
  channels: 1 | 2;
  frames: number;
  /** One array per channel, -1 to 1. */
  channelData: Float32Array[];
}

export function readNative(file: Uint8Array): NativeAudio {
  if (file.length < HEADER || file[0] !== 0 || file[1]! > 1 || file[0x14] !== 0x7f) {
    throw new Error("not a native sample file");
  }
  const view = new DataView(file.buffer, file.byteOffset, file.length);
  const channels = file[1] === 1 ? 2 : 1;
  const bytes = view.getUint32(4);
  const rate = view.getUint32(8);
  if (HEADER + bytes > file.length) throw new Error("the native file is shorter than its header says");
  const frames = Math.floor(bytes / (2 * channels));
  const channelData = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      channelData[c]![f] = view.getInt16(HEADER + 2 * (f * channels + c)) / 32768;
    }
  }
  return { rate, channels, frames, channelData };
}
