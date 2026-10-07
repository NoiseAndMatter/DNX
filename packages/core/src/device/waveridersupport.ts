/**
 * Whether this instrument serves DNX's wavetable features, and which of them.
 *
 * **One job: the gate.** The record's bytes are `waverider/modinfo.ts`; this asks the device and
 * turns the answer into the three states a page can act on. Nothing here writes anything: both
 * questions are a listing and a read, and `/modinfo/0` is write-protected by the session itself.
 *
 * ## Three states, because two would lie
 *
 * A gate with *supported* and *not supported* turns a timeout, a busy instrument or a port another
 * application is holding into *stock firmware, no wavetables* — a wrong answer wearing the clothes
 * of a considered one. Someone whose port was busy would be told their instrument cannot do a
 * thing it does, and would have no reason to look further.
 *
 * | | |
 * |---|---|
 * | `supported` | `waverider` is in the `/` listing |
 * | `unsupported` | it is not, and stock's own *Could not resolve path* corroborates it |
 * | `unknown` | anything else, timeouts included, and every contradiction |
 *
 * **The root listing is the primary signal and the error string only corroborates it.** The string
 * is English text from firmware that changes under us; the listing is a positive answer, and no
 * build with the store fails to list the root.
 *
 * **Never gate on the OS version.** A mod built on 1.12 would carry the same routes, and a stock
 * 1.11 carries none of them. The record's `os` field is information for a person to read.
 *
 * ## A build with the store and no `/modinfo` is supported, not a contradiction
 *
 * Every build in the field predates the record, so reading those as *not supported* would hide the
 * view on the only instrument we have. The listing is self-consistent in that case: it says
 * `waverider` is there and `modinfo` is not, and both are true.
 *
 * What **is** a contradiction is the listing offering `modinfo` and the read of it failing, or the
 * record arriving malformed. Then the two answers disagree and this says so rather than resolving
 * it. Rev 2 of the spec treats any failed read as the contradiction; splitting it on whether the
 * listing offered the route keeps the listing primary in both branches, which is the rule, and
 * leaves *could not ask* meaning something went wrong rather than something is old.
 *
 * ## An unknown capability disables a feature and never suppresses a warning
 *
 * The one rule for a build whose capabilities cannot be read, and it pulls in two directions, so
 * collapsing it into *assume nothing works* or *assume everything works* goes wrong either way:
 *
 * - **Rename unknown** means the button is off. A feature is lost and nothing breaks.
 * - **The page flag unknown must not mean there is no second writer.** That build demonstrably has
 *   the instrument's own wavetable page, and taking silence for absence would fail in exactly the
 *   case the flag exists for.
 * - **The compare-and-swap unknown** means assuming the firmware does *not* refuse a stale write.
 *   So DNX warns **before** a pool write that a concurrent edit cannot be detected, rather than
 *   afterwards that one was.
 */

import { type ApiTransport, readStoredFile } from "./storagesession.js";
import { type MessageIds, IDS_FOR } from "./messageids.js";
import { ListingError, listRequest, wholeListing } from "./storage.js";
import { readFormOption } from "./storagewrite.js";
import { MODINFO_PATH, type ModInfo, readModInfoFile } from "../waverider/modinfo.js";
import { WaveriderError } from "../waverider/errors.js";

/** Root names, as the `/` listing gives them: no leading slash. */
export const ROOT = { store: "waverider", pool: "wavepool", info: "modinfo" } as const;

/** Stock 1.11's answer to an open of a path it does not have. Corroboration, never the signal. */
export const STOCK_REFUSAL = "could not resolve path";

/** What DNX shows and what it must warn about, with every unknown already resolved. */
export interface WaveriderFeatures {
  /** The Wavetables tab appears at all. */
  tab: boolean;
  /** The pool pane, rather than the store list on its own. */
  pool: boolean;
  /** Rename in place. Off whenever it is not known to be there. */
  rename: boolean;
  /**
   * Assume the working project's pool has a second writer.
   *
   * **True when unknown**, which is the one place the rule inverts: the instrument's own wavetable
   * page is what this flag reports, and taking silence for absence would fail in the case the flag
   * exists for.
   */
  secondWriter: boolean;
  /** A refused pool write can be reported as *the instrument changed this pool*. */
  conflictReported: boolean;
  /** Warn before a pool write that a concurrent edit cannot be detected. */
  warnConcurrentUndetectable: boolean;
  /** Whether any of this came from a record, as opposed to from the listing and the rule. */
  capabilitiesKnown: boolean;
  /**
   * Slots to draw a pool grid with, `undefined` where it is not known.
   *
   * **No default.** 127 and 128 are both builds that exist, drawing 128 on a 127-slot build offers
   * a slot that cannot be filled, and drawing 127 on a 128-slot build hides one that works. The
   * pool record itself carries its version, so a pane that has read one knows; a pane that has not
   * says so.
   */
  poolSlots?: number;
  /** Characters a name keeps in the pool and shows on the instrument, where the record says. */
  nameChars?: { pool: number; shown: number };
}

export type WaveriderSupport =
  | {
      state: "supported";
      roots: readonly string[];
      /** Absent on a build older than the record. Then `features.capabilitiesKnown` is false. */
      info?: ModInfo;
      features: WaveriderFeatures;
      why: string;
    }
  | {
      state: "unsupported";
      roots: readonly string[];
      /** The instrument's own sentence, where it answered one. */
      corroboration?: string;
      /** Whether that sentence was stock's. A listing without the root stands either way. */
      corroborated: boolean;
      why: string;
    }
  | {
      state: "unknown";
      /** Present when the root listing was read and something after it went wrong. */
      roots?: readonly string[];
      why: string;
    };

export interface AskSupportOptions {
  transport: ApiTransport;
  ids: MessageIds;
  timeoutMs?: number;
}

/**
 * What a build without the record leaves DNX able to do, and what the listing still proves.
 *
 * Exported because it is the rule, and a rule with three inversions in it belongs where a test can
 * state each one rather than inside the function that asks the device.
 */
export function featuresFrom(roots: readonly string[], info?: ModInfo): WaveriderFeatures {
  const store = roots.includes(ROOT.store);
  const poolRoute = roots.includes(ROOT.pool);

  if (!info) {
    return {
      tab: store,
      // The listing proves the route, which is all the pane needs to read a pool.
      pool: poolRoute,
      rename: false,
      secondWriter: true,
      conflictReported: false,
      warnConcurrentUndetectable: true,
      capabilitiesKnown: false,
    };
  }

  /*
   * **Both the bit and the route.** The record is filled from the same defines the routes use, so
   * the two agree on every build anyone has; where they would not, a feature whose route is absent
   * fails at the moment somebody uses it, and one whose bit is clear is simply off.
   */
  return {
    tab: info.can.store && store,
    pool: info.can.pool && poolRoute,
    rename: info.can.rename,
    secondWriter: info.can.page,
    conflictReported: info.can.poolCas,
    warnConcurrentUndetectable: !info.can.poolCas,
    capabilitiesKnown: true,
    poolSlots: info.poolSlots,
    nameChars: { pool: info.poolNameChars, shown: info.shownNameChars },
  };
}

async function listRoots(
  transport: ApiTransport,
  ids: MessageIds,
  timeoutMs: number,
): Promise<string[]> {
  const id = ids.reserve(IDS_FOR.oneMessage);
  const reply = await transport.request(listRequest(id, "/"), id, timeoutMs);
  return wholeListing(reply, "/").entries
    .map((entry) => entry.name.trim())
    .filter((name) => name.length > 0);
}

async function readRecord(
  transport: ApiTransport,
  ids: MessageIds,
  timeoutMs: number,
): Promise<ModInfo> {
  const file = await readStoredFile(MODINFO_PATH, {
    transport,
    // Asked rather than assumed, as every other read does: a new route must not inherit the form
    // of another. `/modinfo` is raw.
    ...readFormOption(MODINFO_PATH),
    msgId: ids.reserve(IDS_FOR.oneObject),
    timeoutMs,
  });
  return readModInfoFile(file.bytes);
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Ask the instrument, in at most two messages and one file read.
 *
 * Returns rather than throws for every answer, including the ones that are failures: *could not
 * ask* is a state a page shows, not an exception it swallows. A caller that gets `unknown` has a
 * sentence to put in front of somebody.
 */
export async function askWaveriderSupport(
  options: AskSupportOptions,
): Promise<WaveriderSupport> {
  const { transport, ids } = options;
  const timeoutMs = options.timeoutMs ?? 10_000;

  let roots: string[];
  try {
    roots = await listRoots(transport, ids, timeoutMs);
  } catch (error) {
    /*
     * **The primary signal failed, so nothing else is asked.** A read of `/modinfo/0` here could
     * only produce a second failure, and two failures are not a finding.
     */
    return {
      state: "unknown",
      why:
        `the root listing could not be read, so whether this instrument has the wavetable store ` +
        `is not known: ${reason(error)}`,
    };
  }

  if (!roots.includes(ROOT.store)) {
    let corroboration: string;
    try {
      await readRecord(transport, ids, timeoutMs);
      /*
       * The listing has no `waverider` and `/modinfo/0` reads. Nothing should be able to produce
       * that, and resolving it either way would be a guess about which answer to believe.
       */
      return {
        state: "unknown",
        roots,
        why:
          `the root listing does not offer ${ROOT.store} and ${MODINFO_PATH} reads anyway, which ` +
          `nothing should produce. DNX will not pick one of the two answers.`,
      };
    } catch (error) {
      /*
       * **Any failure is corroboration, and a failure to corroborate changes nothing.** The
       * listing answered, parsed, and did not offer the root; a timeout on the second question is
       * a reason to say the sentence was not stock's, not a reason to doubt the first answer.
       */
      corroboration = reason(error);
    }

    const corroborated = corroboration.toLowerCase().includes(STOCK_REFUSAL);
    return {
      state: "unsupported",
      roots,
      corroboration,
      corroborated,
      why:
        `the root listing offers ${roots.join(", ")} and not ${ROOT.store}, so this image has no ` +
        `wavetable store` +
        (corroborated ? ", and the instrument answered as stock firmware does" : ""),
    };
  }

  if (!roots.includes(ROOT.info)) {
    /*
     * Older than the record, and the listing says so plainly rather than by a failure. Every
     * unknown now resolves through the rule, which is `featuresFrom`.
     */
    return {
      state: "supported",
      roots,
      features: featuresFrom(roots),
      why:
        `the root listing offers ${ROOT.store}, so the store is there, and no ${ROOT.info}, so ` +
        `this build predates the capability record. Features DNX cannot confirm are off and the ` +
        `warnings stay on.`,
    };
  }

  try {
    const info = await readRecord(transport, ids, timeoutMs);
    return {
      state: "supported",
      roots,
      info,
      features: featuresFrom(roots, info),
      why:
        `${MODINFO_PATH} reports capabilities 0x${info.capabilities.toString(16)} on image ` +
        `0x${info.imageId.toString(16).padStart(8, "0")}` +
        (info.unknown === 0
          ? ""
          : `, including 0x${info.unknown.toString(16)} this DNX does not know, which it ignores`),
    };
  } catch (error) {
    /*
     * A refused read, a timeout and a malformed record all land here and all mean *could not ask*.
     * **Anything else is rethrown**, because a fault in DNX's own codec reported as a property of
     * the instrument is how a bug becomes a firmware mystery.
     */
    if (!(error instanceof ListingError) && !(error instanceof WaveriderError)) throw error;
    return {
      state: "unknown",
      roots,
      why:
        `the root listing offers both ${ROOT.store} and ${ROOT.info}, and the record could not be ` +
        `read: ${reason(error)}. The two answers disagree, so DNX does not resolve them.`,
    };
  }
}
