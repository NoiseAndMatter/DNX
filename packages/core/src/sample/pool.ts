/**
 * A project's sample pool: how much of the DSP's memory its samples take, and whether they fit.
 *
 * **One job: the memory arithmetic.** A sample machine plays from the DSP's DDR, not from the
 * +Drive, so a project's samples load into a pool first. This plans that pool before anything
 * is sent.
 *
 * ## The Digitakt II's rules, read statically in DT2 1.16 MAIN OS (2026-10-22)
 *
 * The dn2_firmware session read these, and `dnfw/bloom/pool.py` models them:
 *
 * - **An allocation is the length plus 16 bytes, rounded up to 8 KiB** (`0x40154476`:
 *   `(length + 8207) & ~8191`). A DT2 sample file ends in a 16-byte trailer, which fits.
 * - **No sample is loaded twice.** The allocator first looks the sample up by its key.
 * - **First fit into freed space**, else the pool grows at its end.
 * - The DT2's pool is 400 MiB.
 *
 * Which length the DT2 rounds (the samples only, or a header with them) is not traced. This uses
 * the stored samples' length, as the model does.
 *
 * ## The DN2's budget is an estimate
 *
 * Waverider reserves 258.5 MiB of the DSP's DDR for table levels today, used or not, which leaves
 * about 180.5 MiB ("Bloom prototype", 2026-10-22). That is `DN2_POOL_BYTES`. It is not measured
 * on the unit, and it grows if Waverider allocates its levels on demand. A caller passes its own
 * budget when it knows better.
 */

import { SampleError } from "./errors.js";
import { sampleKey, type SampleId } from "./identity.js";

/** The DN2's sample pool budget today: about 180.5 MiB. An estimate, not a measurement. */
export const DN2_POOL_BYTES = Math.round(180.5 * 2 ** 20);

/** The DT2's pool, 400 MiB (`0x40153814` returns `0x19000000`). */
export const DT2_POOL_BYTES = 400 * 2 ** 20;

const ALIGN = 8192;
const TRAILER = 16;

/** The DT2's allocation for a sample of `length` bytes. */
export function allocationBytes(length: number): number {
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new SampleError(`a sample of ${length} bytes cannot be allocated`);
  }
  return Math.ceil((length + TRAILER) / ALIGN) * ALIGN;
}

export interface PoolPlan {
  /** One per distinct sample, in the order first asked for. */
  allocations: { id: SampleId; bytes: number }[];
  /** The sum of the allocations. */
  totalBytes: number;
  budgetBytes: number;
  fits: boolean;
  /** How far past the budget, 0 when it fits. */
  overBytes: number;
  /** Requests for a sample already planned, which take nothing more. */
  duplicates: number;
}

/**
 * Plan a project's pool from the samples it uses. A sample asked for twice is planned once, as
 * the DT2 loads it once.
 */
export function planPool(samples: readonly SampleId[], budgetBytes: number = DN2_POOL_BYTES): PoolPlan {
  const seen = new Set<string>();
  const allocations: PoolPlan["allocations"] = [];
  let duplicates = 0;
  for (const id of samples) {
    const key = sampleKey(id);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    allocations.push({ id: { ...id }, bytes: allocationBytes(id.size) });
  }
  const totalBytes = allocations.reduce((sum, a) => sum + a.bytes, 0);
  return {
    allocations,
    totalBytes,
    budgetBytes,
    fits: totalBytes <= budgetBytes,
    overBytes: Math.max(0, totalBytes - budgetBytes),
    duplicates,
  };
}

/** Refuse a plan past its budget, with the numbers a person needs. */
export function requireFits(plan: PoolPlan): PoolPlan {
  if (!plan.fits) {
    const mib = (bytes: number): string => (bytes / 2 ** 20).toFixed(1);
    throw new SampleError(
      `these samples need ${mib(plan.totalBytes)} MiB of sample memory and the budget is ` +
        `${mib(plan.budgetBytes)} MiB, ${mib(plan.overBytes)} MiB too much`,
    );
  }
  return plan;
}

/** Minutes of 16-bit 48 kHz audio that fit in `bytes`. */
export function minutesIn(bytes: number, channels: 1 | 2 = 1): number {
  return bytes / (2 * channels * 48_000) / 60;
}

export type LoadResult = "present" | "reused" | "appended" | "full";

interface Region {
  key: string;
  offset: number;
  bytes: number;
  loaded: boolean;
}

/**
 * The pool as it changes while samples load and unload, with the DT2's first-fit rule. For
 * planning what a sequence of loads leaves behind: a freed region is reused only by a sample that
 * fits in it, so the pool can fragment.
 */
export class SamplePool {
  private readonly regions: Region[] = [];

  constructor(readonly budgetBytes: number = DN2_POOL_BYTES) {}

  private end(): number {
    return this.regions.reduce((end, r) => Math.max(end, r.offset + r.bytes), 0);
  }

  /** Bytes held by loaded samples. */
  usedBytes(): number {
    return this.regions.filter((r) => r.loaded).reduce((sum, r) => sum + r.bytes, 0);
  }

  /** Bytes free: past the end, plus every freed region. */
  freeBytes(): number {
    return this.budgetBytes - this.end() + this.regions.filter((r) => !r.loaded).reduce((sum, r) => sum + r.bytes, 0);
  }

  load(id: SampleId): LoadResult {
    const key = sampleKey(id);
    if (this.regions.some((r) => r.loaded && r.key === key)) return "present";
    const need = allocationBytes(id.size);
    const freed = this.regions.find((r) => !r.loaded && r.bytes >= need);
    if (freed) {
      freed.key = key;
      freed.loaded = true;
      return "reused";
    }
    const offset = this.end();
    if (offset + need > this.budgetBytes) return "full";
    this.regions.push({ key, offset, bytes: need, loaded: true });
    return "appended";
  }

  unload(id: SampleId): boolean {
    const key = sampleKey(id);
    const region = this.regions.find((r) => r.loaded && r.key === key);
    if (!region) return false;
    region.loaded = false;
    return true;
  }
}
