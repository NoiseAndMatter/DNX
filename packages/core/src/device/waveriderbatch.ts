/**
 * Writing several wavetables into empty `/waverider` slots, asking once.
 *
 * **One job: the safety sequence around a run of `writeTableToSlot` calls.** The single write
 * protects a slot. This protects the *set*, and it has to establish that before the first byte goes
 * out. The library's import and the probe's folder batch both run it; each keeps only the words of
 * its own question and its own way of showing the outcome.
 *
 * It used to be two copies, one in each page, and the copies drifted: the probe refused a slot
 * missing from the listing and the library took it as empty, the probe passed the playable bounds
 * and the library did not, and the library let a thrown write escape with nobody told the run had
 * stopped. Found by review on 2026-10-15.
 *
 * ## Asking once is a relaxation, and here is exactly how much
 *
 * - **Every target must be empty in a listing taken now**, not the one on screen. One occupied or
 *   missing slot refuses the whole run before anything is sent, and says which. So nothing can be
 *   overwritten, and the per-write backup has nothing to protect.
 * - **Each write still passes the gate itself.** `writeTableToSlot` calls `host.gate`, so turning
 *   WRITE off part-way stops the rest. The switch is the stop button.
 * - **It stops at the first failure.** A run that carries on past a slot the store refused turns one
 *   problem into a directory nobody can reason about.
 *
 * The confirm hook each write receives answers yes, because **the person has already been asked
 * about precisely this set**. It is local to this function and never exported.
 *
 * ## Every outcome is returned, never thrown
 *
 * A timeout during the listing or during a write is an outcome to show a person, so it comes back
 * as `unread` or `stopped` with what was written before it. A caller cannot forget to catch it.
 */

import { type ApiTransport } from "./storagesession.js";
import { type MessageIds } from "./messageids.js";
import { readStoreListing } from "./wavepoolread.js";
import { type WriteTableResult, writeTableToSlot } from "./waveriderwrite.js";
import { type PendingSlot } from "../waverider/slotfile.js";
import { type PlayableBounds } from "../waverider/pool.js";
import { type StoreSlotFacts } from "../waverider/poolview.js";

export interface BatchWriteHost {
  ids: MessageIds;
  /** The WRITE switch. Called before the question and again by every write. */
  gate: () => void;
  /**
   * The one question, asked after the fresh listing has shown every target empty.
   * Resolves `true` to write the whole set.
   */
  ask: (tables: readonly PendingSlot[]) => Promise<boolean>;
}

export interface BatchWriteOptions {
  transport: ApiTransport;
  host: BatchWriteHost;
  /** In the order they are written. Each carries its own slot. */
  tables: readonly PendingSlot[];
  /** From `askWaveriderSupport`. Omitted means the 16 x 512 rule, as for one write. */
  playable?: PlayableBounds;
  /** Called before each write: `done` tables are already written, out of `total`. */
  onWriting?: (done: number, total: number, table: PendingSlot) => void;
  timeoutMs?: number;
}

export type BatchWriteOutcome =
  /** The listing could not be read. Nothing was sent. */
  | { kind: "unread"; problem: string }
  /** These slots are not in the listing. Nothing was sent. */
  | { kind: "missing"; slots: number[] }
  /** These slots already hold a table. Nothing was sent. */
  | { kind: "occupied"; slots: StoreSlotFacts[] }
  /** The WRITE switch is off. Nothing was asked and nothing was sent. */
  | { kind: "gated"; problem: string }
  /** The person said no. Nothing was sent. */
  | { kind: "declined" }
  /**
   * Stopped at `at`. `written` were written and verified before it; the rest were not sent.
   *
   * `landed` is set when `at` itself **is in the store**: the listing shows the slot in use and
   * the problem came after, a read-back that differs. Counting it as not sent would leave it
   * staged on a slot the next run is refused for, and moving it would write the table twice.
   */
  | { kind: "stopped"; written: WriteTableResult[]; at: PendingSlot; problem: string; landed?: WriteTableResult }
  | { kind: "done"; written: WriteTableResult[] };

export async function writeTablesToSlots(options: BatchWriteOptions): Promise<BatchWriteOutcome> {
  const { transport, host, tables } = options;
  const timeoutMs = options.timeoutMs ?? 60_000;

  let listing: StoreSlotFacts[];
  try {
    listing = await readStoreListing(transport, host.ids);
  } catch (error: unknown) {
    return { kind: "unread", problem: messageOf(error) };
  }

  const missing = tables.filter((table) => !listing.some((slot) => slot.slot === table.slot));
  if (missing.length > 0) return { kind: "missing", slots: missing.map((table) => table.slot) };

  const occupied = listing.filter(
    (slot) => slot.occupied && tables.some((table) => table.slot === slot.slot),
  );
  if (occupied.length > 0) return { kind: "occupied", slots: occupied };

  // Before the question, so nobody is asked about a write the switch would refuse.
  try {
    host.gate();
  } catch (error: unknown) {
    return { kind: "gated", problem: messageOf(error) };
  }
  if (!(await host.ask(tables))) return { kind: "declined" };

  // Already asked, about exactly this set. Local and unexported; see the module note.
  const alreadyAsked = (): Promise<boolean> => Promise.resolve(true);

  const written: WriteTableResult[] = [];
  for (const table of tables) {
    options.onWriting?.(written.length, tables.length, table);
    let result: WriteTableResult;
    try {
      result = await writeTableToSlot({
        transport,
        host: { ids: host.ids, gate: host.gate, confirm: alreadyAsked },
        table,
        ...(options.playable === undefined ? {} : { playable: options.playable }),
        timeoutMs,
      });
    } catch (error: unknown) {
      return { kind: "stopped", written, at: table, problem: messageOf(error) };
    }
    if (result.cancelled || result.problem !== undefined || !result.listed) {
      return {
        kind: "stopped", written, at: table, problem: result.problem ?? "cancelled",
        ...(result.listed ? { landed: result } : {}),
      };
    }
    written.push(result);
  }
  return { kind: "done", written };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
