/**
 * Ask a device about a dump type nobody has identified, one code at a time.
 *
 * A Digitone II advertises `0x50`–`0x5e` and a Digitone 1 `0x50`–`0x5d`; we can name five on
 * either. **Nine or ten dump types are unidentified per machine**, and the reason to care is a
 * specific question: **where does Elektron's Transfer put a project?**
 *
 * ## Try the Digitone 1 first
 *
 * Not because it is more likely to answer — because its answer is worth more. The DN1 is the
 * machine we are actually blocked on: **its sound pool cannot be requested**, so a DN1 project can
 * only be read completely with a front-panel dump the user has to perform by hand.
 *
 * If a project-level object exists and carries a whole project, on a DN1 it would very likely
 * carry the pool with it — removing the one manual step in the whole expander flow. On a DN2 the
 * same finding is merely convenient, because `0x63` already reaches its pool.
 *
 * Both are worth testing. The DN1 is worth testing first.
 *
 * ## Why this is the right place to look
 *
 * The assumption was that whole projects move over the SysEx **file API** — `DirList`,
 * `FileWriteOpen`, paths — because that is what elk-herd does on a Digitakt. Neither Digitone
 * advertises those codes and `DirList` timed out, which was read as "the file API does not exist
 * here". That reading was then used to conclude a project slot cannot be addressed at all.
 *
 * **Two things say otherwise.**
 *
 * 1. **Transfer demonstrably writes projects into chosen slots on a Digitone.** Whatever the
 *    mechanism is, one exists.
 * 2. **Project storage on both machines is a flat indexed list, not a filesystem** — no folders,
 *    the same shape as sound storage. So `DirList` may have been the wrong question rather than an
 *    unimplemented one: a Digitone has no sampler, therefore no files to manage, therefore no
 *    filesystem. elk-herd's file API is a *Digitakt* feature because a Digitakt has samples.
 *
 * A flat list addressed by index is exactly what the **dump protocol** already does — `0x50` plus
 * an `objNr`, and `objNr` is a slot rather than a counter (proven on the DN1 pool: delete slots 14
 * and 26 and those two numbers simply go missing from the dump). A project object addressed by
 * slot would sit naturally in the unnamed part of that band.
 *
 * ## Why sending these is defensible, and where the reasoning stops
 *
 * Every code here is a `0x6n` **request with an empty body**. That is the same message shape, and
 * the same argument, as the five requests already verified on two machines and two firmware
 * generations: elk-herd builds them with `Builder.empty`, and a message with nothing in it has
 * nothing to store.
 *
 * **The argument is inference, not certainty**, and `docs/device-probing.md` rule 5 is explicit
 * that an empty payload is not the same as safe — the reasoning has to come from the message's
 * meaning. Here the meaning is extrapolated from a convention, so the discipline around it is what
 * makes it acceptable: a scratch project, **one code per run**, and a look at the device in
 * between. There is deliberately no "sweep all" here, for exactly that reason.
 *
 * ### Two ways that argument is weaker than it first appeared — 2026-07-30
 *
 * 1. **An empty body does not rule out deletion.** `delete object N` needs a code and an index and
 *    nothing else — structurally identical to a read request. Elektron's Transfer deletes sounds
 *    and projects, so destructive no-body commands demonstrably exist on this protocol. The
 *    empty-body argument only ever excluded writes that *carry data*.
 * 2. **Nor does it rule out changing the instrument's state.** A code could put a device into a
 *    mode. That is neither a read nor a write and had no place in the safety model at all.
 *
 * And the risk surface is **device memory, not the loaded project**: a command may address a sound
 * in the +Drive library or a project that is not open. "Load a scratch project" is therefore *not*
 * sufficient isolation — there is no scratch +Drive, and nothing here can verify afterwards that
 * unloaded data survived.
 *
 * The one thing enforced rather than trusted: **this will only ever build `0x60`–`0x6f`.** A
 * `0x5n` is a *write*, and the difference between asking a device a question and telling it to
 * store something is one bit in one byte.
 */

import { buildMessage } from "@noiseandmatter/dnx-core/sysex/container.js";
import { DUMP_MESSAGES, REQUEST_MESSAGES } from "@noiseandmatter/dnx-core/device/capabilities.js";

export class NotARequest extends Error {}

/** The request band. Below it are dumps, which write. */
export const REQUEST_LOW = 0x60;
export const REQUEST_HIGH = 0x6f;

export function isRequestCode(code: number): boolean {
  return Number.isInteger(code) && code >= REQUEST_LOW && code <= REQUEST_HIGH;
}

export interface CodeUnderTest {
  /** The request to send. */
  code: number;
  /** The response it would pair with, by the `+0x10` convention. */
  response: number;
  /** What we already know, if anything. */
  known: string | undefined;
  /** Whether a Digitone advertises the paired response at all. */
  advertised: boolean;
  /** Why this one might be interesting. */
  note: string;
}

/**
 * Every request code, with what is known about it.
 *
 * The identified five are included rather than filtered out, so a run can start with a **control**:
 * send `0x64` first, confirm the transport works and the device answers, and only then try
 * something unknown. A silent unknown code means nothing if you have not shown that a known one
 * would have spoken.
 */
export function codesUnderTest(advertisedResponses: readonly number[]): CodeUnderTest[] {
  const advertised = new Set(advertisedResponses);
  const out: CodeUnderTest[] = [];

  for (let code = REQUEST_LOW; code <= REQUEST_HIGH; code++) {
    const response = code - 0x10;
    const known = REQUEST_MESSAGES[code] ?? DUMP_MESSAGES[response];
    out.push({
      code,
      response,
      known,
      advertised: advertised.has(response),
      note: noteFor(code, response, known !== undefined, advertised.has(response)),
    });
  }
  return out;
}

function noteFor(code: number, response: number, known: boolean, advertised: boolean): string {
  if (known) return "known — use as a control that the transport is working";
  if (code === 0x6f) {
    return "elk-herd's WholeProject request on a Digitakt. Never sent to a Digitone; its response " +
      "would be 0x5f, one past the band either machine advertises.";
  }
  if (advertised) {
    return `the device advertises 0x${response.toString(16)} and no source names it — the most ` +
      `likely place for a project object`;
  }
  return "neither named nor advertised; least likely, and worth trying last";
}

export interface ProbeRequest {
  code: number;
  /** Which object. A flat project list would be addressed the same way a pool slot is. */
  objNr?: number;
}

/**
 * Build one request for an unidentified code.
 *
 * The gate is the whole function: **only `0x60`–`0x6f`, only an empty body.** Everything else this
 * module says is reasoning; this is the part that cannot be reasoned around.
 */
export function probeRequest(productId: number, request: ProbeRequest): Uint8Array {
  if (!isRequestCode(request.code)) {
    throw new NotARequest(
      `0x${request.code.toString(16)} is not in the request band 0x60–0x6f. A 0x5n sent to a ` +
        `device means "store this" — this builder will not address one.`,
    );
  }

  const objNr = request.objNr ?? 0;
  if (!Number.isInteger(objNr) || objNr < 0 || objNr > 127) {
    throw new NotARequest(`object number ${objNr} does not fit in the 7-bit field`);
  }

  return buildMessage({ productId, dumpType: request.code, objNr, payload: new Uint8Array() });
}

/** What came back, described so an unfamiliar reply is still readable. */
export interface ProbeReply {
  dumpType: number;
  objNr: number;
  payloadBytes: number;
  checksumOk: boolean;
  /** True when the reply is the code we would have predicted. */
  asExpected: boolean;
  /** A guess at what the payload is, by size, against records we know. */
  resembles: string | undefined;
}

/**
 * Describe a reply to an unidentified request.
 *
 * Size is the most informative thing about an unknown record, because every record we *have*
 * identified was recognised by its size first — 99,840 as pattern + kit, 359 as a sound, 512 as
 * DN2 settings. So a reply is measured against those before anything is assumed about it.
 */
export function describeReply(
  sent: number,
  dumpType: number,
  objNr: number,
  payloadBytes: number,
  checksumOk: boolean,
  knownSizes: Readonly<Record<string, number>>,
): ProbeReply {
  const match = Object.entries(knownSizes).find(([, size]) => size === payloadBytes);
  return {
    dumpType,
    objNr,
    payloadBytes,
    checksumOk,
    asExpected: dumpType === sent - 0x10,
    resembles: match?.[0],
  };
}
