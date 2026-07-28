/**
 * Ask a device to send a dump.
 *
 * **The first thing in this project that transmits to an instrument**, so the reasoning is worth
 * writing down rather than assuming.
 *
 * ## What a request is
 *
 * The dump protocol pairs every response with a request at the same code plus `0x10`, and
 * elk-herd's `SysEx/Dump.elm` implements all five for the Digitakt family:
 *
 * | Response | Request | Object |
 * |---|---|---|
 * | `0x50` | `0x60` | PatternKit |
 * | `0x51` | `0x61` | Pattern |
 * | `0x52` | `0x62` | Kit |
 * | `0x53` | `0x63` | Sound |
 * | `0x54` | `0x64` | ProjectSettings |
 * |  | `0x6f` | WholeProject |
 *
 * A **response carries a decoded struct; a request carries nothing.** elk-herd builds them as
 * `msgBuilder 0x60 index Builder.empty`, and parses them with `parseRequest`, which asserts the
 * message ends immediately. An empty body is the reason to believe a request cannot write: there
 * is nothing in it to write.
 *
 * ## Why that is still an inference
 *
 * Nothing above was observed on a **Digitone**. The evidence is a working implementation for a
 * sibling device, and this project has already been wrong once about exactly that kind of
 * generalisation — the +Drive file API is real on a Digitakt II and absent on both Digitones
 * (ROADMAP §3c-iv). Two machines shared a storage format and not a protocol surface.
 *
 * Neither Digitone advertises `0x60`–`0x6f` in `supportedMessages` either. That list carries the
 * `0x5n` *response* codes, so a request code being absent may mean "not supported" or may mean
 * "requests are not the kind of thing that list enumerates". We cannot tell.
 *
 * So these are classified `read` deliberately and on stated grounds, not because the gate was
 * inconvenient — and `docs/device-probing.md` records the reasoning alongside the regime it bends.
 *
 * ## Start with the smallest thing
 *
 * `0x64` ProjectSettings is the first one to try: one object, 512 bytes on a Digitone II, and no
 * index to get wrong. If the convention holds it answers immediately; if it does not, nothing
 * happened. `0x6f` WholeProject is deliberately **not** offered — asking a device for 14.6 MB is
 * not the experiment that tells you whether requests work.
 */

import { buildMessage } from "../sysex/container.js";
import { ProductId } from "../sysex/devices.js";

/** Request codes, each the matching response code plus `0x10`. */
export const RequestCode = {
  PatternKit: 0x60,
  Pattern: 0x61,
  Kit: 0x62,
  Sound: 0x63,
  ProjectSettings: 0x64,
} as const;

export type RequestCode = (typeof RequestCode)[keyof typeof RequestCode];

/** The response a request should produce: the same code with `0x10` cleared. */
export function responseFor(request: number): number {
  return request - 0x10;
}

export interface DumpRequest {
  /** What to ask for. */
  code: RequestCode;
  /** Which object. Ignored by `ProjectSettings`, which has only one. */
  objNr?: number;
}

/**
 * Build a dump request for a device.
 *
 * The **dump** framing, not the API's: `F0 00 20 3C <productId> <devId> <code> <ver> <objNr> F7`
 * with an empty payload. A different protocol from `src/device/api.ts` despite arriving on the
 * same wire, and mixing the two is how an afternoon disappears.
 */
export function dumpRequest(productId: number, request: DumpRequest): Uint8Array {
  if (!Object.values(RequestCode).includes(request.code)) {
    throw new Error(`0x${request.code.toString(16)} is not a request code we recognise`);
  }
  const objNr = request.objNr ?? 0;
  if (!Number.isInteger(objNr) || objNr < 0 || objNr > 127) {
    // The field is one 7-bit byte — the same limit that makes object numbers saturate at 128 in
    // a long bank dump. Sending 200 would silently become something else.
    throw new Error(`object number ${objNr} does not fit in the 7-bit field`);
  }

  return buildMessage({
    productId,
    dumpType: request.code,
    objNr,
    payload: new Uint8Array(),
  });
}

/** Every request this module will build, for a UI that lists them. */
export interface RequestOption {
  code: RequestCode;
  label: string;
  /** True when the request takes an object number. */
  indexed: boolean;
  /** Roughly what comes back, so a caller can warn before asking for something enormous. */
  approximateBytes: (product: number) => number;
}

export const REQUEST_OPTIONS: readonly RequestOption[] = [
  {
    code: RequestCode.ProjectSettings,
    label: "Project settings",
    indexed: false,
    // The smallest object either machine holds, which is why it is the one to try first.
    approximateBytes: (p) => (p === ProductId.DN2 ? 601 : 13_474),
  },
  {
    code: RequestCode.Sound,
    label: "Sound",
    indexed: true,
    approximateBytes: (p) => (p === ProductId.DN2 ? 426 : 361),
  },
  {
    code: RequestCode.Kit,
    label: "Kit",
    indexed: true,
    approximateBytes: (p) => (p === ProductId.DN2 ? 12_303 : 3_000),
  },
  {
    code: RequestCode.Pattern,
    label: "Pattern",
    indexed: true,
    approximateBytes: (p) => (p === ProductId.DN2 ? 114_118 : 24_006),
  },
  {
    code: RequestCode.PatternKit,
    label: "Pattern + kit",
    indexed: true,
    approximateBytes: (p) => (p === ProductId.DN2 ? 114_118 : 24_006),
  },
];
