/**
 * Execute a read plan: ask for one object, wait for its answer, ask for the next.
 *
 * **Paced by completion, not by a clock.** One request is in flight at a time and the next goes
 * out when the previous answer has landed, so the device sets the rate. A fixed delay would have
 * to be tuned to the slowest case and would still be wrong when something is slower than that.
 *
 * Nothing here knows what a project is — that is `readplan.ts` — and nothing here touches MIDI.
 * It is given a `send` and it is fed arriving messages, which is what makes it testable without a
 * device, and the reason the plan and the pump are separate files at all.
 *
 * ## Three failures this is shaped around
 *
 * 1. **A silence must not stop the run.** A device may simply not answer for an empty slot, and
 *    aborting on the first one would throw away the 200 answers after it. Same lesson as the
 *    probe's query sweep: the interesting result is a *mixture*, and only a run that continues
 *    can show one. So a silent step is recorded and the plan carries on.
 *
 * 2. **A late answer must not be counted as the next step's.** If step *n* times out and its
 *    answer arrives while step *n+1* is waiting, matching purely on dump type would file it
 *    against the wrong object and every step after it would be off by one — silently, with all
 *    the bytes present and every checksum good. So an answer whose object number belongs to a
 *    step we already gave up on is counted **late** and the wait continues.
 *
 * 3. **We do not know whether a response echoes the requested object number.** It should; the
 *    front-panel dumps number their objects. But it has never been checked for a *requested* one,
 *    and strict matching would turn that unknown into a hang. So a mismatch resolves the step and
 *    is reported, which turns the first run into the experiment that settles it.
 *
 * ## Retries, deliberately absent
 *
 * A retry doubles the chance of exactly failure 2, and buys little: the timeout is already sized
 * from the payload. A step that goes silent is reported as silent, and the caller can plan a
 * second pass over just those steps — which is a better tool than a retry anyway, because it is
 * visible.
 */

import { SysExParseError, parseMessage } from "../sysex/container.js";
import { ProductId } from "../sysex/devices.js";
import { dumpRequest } from "./dumprequest.js";
import { type ReadStep, wireBytes } from "./readplan.js";

/** How this step ended. */
export type StepStatus = "ok" | "silent" | "stopped";

export interface StepResult {
  step: ReadStep;
  status: StepStatus;
  /** The object number the answer carried. Absent when nothing came. */
  objNr?: number;
  /** Decoded payload size, against `step.payloadBytes` which is only a prediction. */
  payloadBytes?: number;
  /** Whole message including framing, which is what the transfer actually cost. */
  wireBytes?: number;
  /** Milliseconds from sending the request to the answer landing. */
  elapsedMs?: number;
  checksumOk?: boolean;
}

export interface ReadReport {
  results: StepResult[];
  ok: number;
  silent: number;
  /** Bytes actually received, framing included. */
  bytes: number;
  /**
   * Answers that arrived after their step had given up.
   *
   * Non-zero means the timeouts are too tight for this transport — most likely DIN MIDI, which
   * the manual says will throttle a transfer to roughly 3 kB/s (§13.4.2).
   */
  late: number;
  /** Messages that were not the response we were waiting for, ignored but counted. */
  foreign: number;
  /**
   * Steps whose answer carried an object number other than the one requested.
   *
   * Expected to be zero. If it is not, the device does not echo the request's index, and any
   * reassembly must go by **send order** rather than by the number in the message — the same
   * trap §5c records for banks past 128 objects.
   */
  objNrMismatches: number;
  /** Steps whose payload was not the size the plan predicted. */
  sizeMismatches: number;
  /**
   * Answers whose stored checksum disagreed with the recomputed one.
   *
   * Promoted to the report after the first hardware run made the case for it. A Digitone II sent
   * `G11` with a bad checksum and 6,433 wrong bytes in one 248-message dump, and returned it
   * perfectly the next night — so corruption here is **real, rare and silent**, and a transfer
   * that trusted a single pass would have written those bytes into a project. Counted at the top
   * level rather than left for a caller to derive, because the derivation is exactly the step
   * somebody skips.
   */
  badChecksums: number;
  /** True when `stop()` ended the run before the plan did. */
  stopped: boolean;
}

export interface DumpReaderOptions {
  /** The dump protocol's product id — `0x0D` or `0x15`. */
  productId: number;
  send: (bytes: Uint8Array) => void;
  onProgress?: (result: StepResult, done: number, total: number) => void;
  /** Injectable so tests need no real clock. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * Override the size-derived wait. Only for tests and for a transport we have not met.
   */
  timeoutMs?: number;
}

/**
 * Bytes per millisecond a device is assumed to manage over USB, by product.
 *
 * From elk-herd's `SysEx.elm`, which uses 200 for a Digitakt and 800 for a Digitakt II to pace
 * its *sends*. Adapted here with attribution (BSD 2-Clause) and used the other way round: to
 * decide how long an answer of a given size is allowed to take. The generation split matches ours
 * exactly — one machine of each era, one an order of magnitude quicker.
 */
const BYTES_PER_MS: Readonly<Record<number, number>> = {
  [ProductId.DN1]: 200,
  [ProductId.DN2]: 800,
};

const DEFAULT_BYTES_PER_MS = 200;

/**
 * Floor under every wait.
 *
 * A Digitone II PatternKit is about 114 KB, which at 800 B/ms is 143 ms — far too short to
 * distinguish a busy device from a silent one. The floor is what makes a silence mean something.
 */
const MIN_TIMEOUT_MS = 3000;

/** Room for a device that is doing something else as well as answering. */
const SLACK = 4;

/** How long to allow for one step's answer. */
export function timeoutFor(step: ReadStep, productId: number): number {
  const rate = BYTES_PER_MS[productId] ?? DEFAULT_BYTES_PER_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.ceil((wireBytes(step.payloadBytes) / rate) * SLACK));
}

interface Waiting {
  step: ReadStep;
  resolve: (result: StepResult) => void;
  startedAt: number;
  timer: unknown;
}

export class DumpReader {
  private readonly options: DumpReaderOptions;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private waiting: Waiting | undefined;
  /** Object numbers of steps that gave up, so their late answers are recognised as late. */
  private readonly abandoned = new Map<number, Set<number>>();

  private late = 0;
  private foreign = 0;
  private stopping = false;

  constructor(options: DumpReaderOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * Feed one MIDI message.
   *
   * Everything is offered, and this decides. Non-SysEx and unparseable traffic is counted rather
   * than thrown on, because a live port carries clock and notes as well as dumps and a reader
   * that fell over on a clock byte would be useless on a working setup.
   */
  receive(data: Uint8Array): void {
    const waiting = this.waiting;
    if (!waiting) return;

    let message;
    try {
      message = parseMessage(data);
    } catch (error) {
      if (error instanceof SysExParseError) this.foreign++;
      else throw error;
      return;
    }

    if (message.dumpType !== waiting.step.expect) {
      this.foreign++;
      return;
    }

    // A dump of the right type but belonging to a step we already gave up on. Filing this against
    // the current step would shift every remaining result by one, with nothing to show for it.
    if (this.wasAbandoned(message.dumpType, message.objNr)) {
      this.late++;
      return;
    }

    this.settle(waiting, {
      step: waiting.step,
      status: "ok",
      objNr: message.objNr,
      payloadBytes: message.payload.length,
      wireBytes: message.byteLength,
      elapsedMs: this.now() - waiting.startedAt,
      checksumOk: message.storedChecksum === message.computedChecksum,
    });
  }

  /** End the run after the step in flight. */
  stop(): void {
    this.stopping = true;
    const waiting = this.waiting;
    if (waiting) {
      this.settle(waiting, { step: waiting.step, status: "stopped" });
    }
  }

  /** Send every step in the plan, one at a time, and say what came back. */
  async run(plan: readonly ReadStep[]): Promise<ReadReport> {
    const results: StepResult[] = [];

    for (const step of plan) {
      if (this.stopping) break;
      const result = await this.step(step);
      results.push(result);
      this.options.onProgress?.(result, results.length, plan.length);
      if (result.status === "stopped") break;
    }

    return this.report(results);
  }

  private step(step: ReadStep): Promise<StepResult> {
    return new Promise<StepResult>((resolve) => {
      const timeoutMs = this.options.timeoutMs ?? timeoutFor(step, this.options.productId);

      this.waiting = {
        step,
        resolve,
        startedAt: this.now(),
        timer: this.setTimer(() => {
          const waiting = this.waiting;
          if (!waiting || waiting.step !== step) return;
          this.abandon(step);
          this.settle(waiting, { step, status: "silent", elapsedMs: timeoutMs });
        }, timeoutMs),
      };

      // Sent after the wait is armed. The other order is a race that only shows up on a fast
      // device: a synchronous transport could deliver the answer before anything is listening.
      this.options.send(dumpRequest(this.options.productId, { code: step.code, objNr: step.objNr }));
    });
  }

  private settle(waiting: Waiting, result: StepResult): void {
    this.clearTimer(waiting.timer);
    this.waiting = undefined;
    waiting.resolve(result);
  }

  private abandon(step: ReadStep): void {
    const set = this.abandoned.get(step.expect) ?? new Set<number>();
    set.add(step.objNr);
    this.abandoned.set(step.expect, set);
  }

  private wasAbandoned(dumpType: number, objNr: number): boolean {
    return this.abandoned.get(dumpType)?.has(objNr) ?? false;
  }

  private report(results: StepResult[]): ReadReport {
    return {
      results,
      ok: results.filter((r) => r.status === "ok").length,
      silent: results.filter((r) => r.status === "silent").length,
      bytes: results.reduce((total, r) => total + (r.wireBytes ?? 0), 0),
      late: this.late,
      foreign: this.foreign,
      objNrMismatches: results.filter((r) => r.status === "ok" && r.objNr !== r.step.objNr).length,
      sizeMismatches: results.filter(
        (r) => r.status === "ok" && r.payloadBytes !== r.step.payloadBytes,
      ).length,
      badChecksums: results.filter((r) => r.checksumOk === false).length,
      stopped: this.stopping,
    };
  }
}

/**
 * The steps worth asking for again: the ones that answered nothing, and the ones that answered
 * badly.
 *
 * A second pass over a short list rather than a retry inside the run — the difference being that
 * this one is *visible*, and that it cannot desync the first pass by racing it. The first hardware
 * run is the argument: 257 objects, and the only thing wrong with any of them was a checksum that
 * a re-read would have fixed in under a second.
 *
 * **A caller re-running these has to decide what to do with the duplicates.** The bytes land in
 * the same capture, so the `.syx` then holds two copies of a record. Harmless for inspection, and
 * a decision anything rebuilding a project file has to make explicitly — later wins, on the
 * grounds that a step is only retried because the earlier answer was unusable.
 */
export function stepsToRetry(report: ReadReport): ReadStep[] {
  return report.results
    .filter((r) => r.status === "silent" || r.checksumOk === false)
    .map((r) => r.step);
}
