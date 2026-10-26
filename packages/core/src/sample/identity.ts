/**
 * A sample's identity: the 64-bit hash of its canonical bytes, and their size.
 *
 * **This is the link.** A sound reaches its sample by identity, the catalog names a sample by
 * identity, and the device is asked what it holds by identity. Moving or renaming a sample changes
 * the catalog, never the identity, so no link breaks. Elektron links samples the same way: the
 * DN2's `.metadata` template carries `"sample_references":[{"hash":…,"size":…}]`.
 *
 * The bytes are `canonicalBytes` (interleaved little-endian `int16`). Two imports of the same
 * audio with the same options produce the same bytes, because the conversion's dither is seeded
 * (`convert.ts`), so they produce one sample and not two.
 *
 * **The channel count is the hash's seed.** The bytes alone cannot tell four mono frames from
 * two stereo frames of the same points, and hash plus size would then name two samples as one.
 * A DT2 sample file carries a mono/stereo flag in its header, so Elektron's own hash sees it too.
 * Seeding costs nothing and keeps `size` equal to the bytes stored.
 */

import { SampleError } from "./errors.js";
import { canonicalBytes, storedBytes, type StoredSample } from "./format.js";
import { xxHash64 } from "./xxhash64.js";

export interface SampleId {
  /** xxHash64 of the canonical bytes, 16 lower-case hex digits. */
  hash: string;
  /** The canonical bytes' length. */
  size: number;
}

export function identify(sample: StoredSample): SampleId {
  return {
    hash: xxHash64(canonicalBytes(sample), BigInt(sample.channels)).toString(16).padStart(16, "0"),
    size: storedBytes(sample),
  };
}

/** One string per identity, for a map key: `hash:size`. */
export function sampleKey(id: SampleId): string {
  return `${id.hash}:${id.size}`;
}

const KEY = /^([0-9a-f]{16}):(\d+)$/;

/** The identity a key names. Throws on anything `sampleKey` would not produce. */
export function parseSampleKey(key: string): SampleId {
  const match = KEY.exec(key);
  if (!match) throw new SampleError(`"${key}" is not a sample key`);
  const size = Number(match[2]);
  if (!Number.isSafeInteger(size) || size <= 0 || size % 2 !== 0) {
    throw new SampleError(`"${key}" names a size of ${match[2]} bytes, which no stored sample has`);
  }
  return { hash: match[1]!, size };
}

export function sameSample(a: SampleId, b: SampleId): boolean {
  return a.hash === b.hash && a.size === b.size;
}
