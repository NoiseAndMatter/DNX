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
 * ## VERIFIED on a Digitone II, 2026-07-28
 *
 * The inference held. All four implemented requests were sent to a real Digitone II and each
 * answered with its matching response, **payload exactly the size of the record it names**:
 *
 * | Asked | Answered | Payload |
 * |---|---|---|
 * | `0x64` ProjectSettings | `0x54` | **512** |
 * | `0x63` Sound | `0x53` | **359** |
 * | `0x62` Kit | `0x52` | **10,752** |
 * | `0x61` Pattern | `0x51` | **89,088** |
 *
 * Every checksum good. So the `0x6n` convention holds on this family, and **a Digitone II can be
 * asked for any object on demand** — which is what makes a transfer feature possible now that the
 * +Drive file API has turned out not to exist here.
 *
 * Note what the request codes are **not**: neither Digitone lists `0x60`–`0x6f` in
 * `supportedMessages`, and they work anyway. That list enumerates *responses*, so absence from it
 * says nothing about whether a request is honoured — worth remembering before reading any other
 * absence as a refusal.
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

/**
 * The dump protocol's product id for a device that identified itself over the **API**.
 *
 * These are two different numbering spaces for two different protocols, and conflating them is
 * the mistake this function exists to make impossible. The `Device` response reports **20** for a
 * Digitone and **43** for a Digitone II; the dump framing wants **0x0D** and **0x15**.
 *
 * Written after doing exactly that: the first dump request went out addressed to product 43,
 * which is not a product in the dump space, and the device correctly ignored it. The module note
 * warning about the two spaces was already in this file at the time — knowing the trap is not the
 * same as not walking into it, which is why the conversion is a function rather than a caution.
 */
export function dumpProductFor(apiProductId: number): number | undefined {
  return API_TO_DUMP_PRODUCT[apiProductId];
}

const API_TO_DUMP_PRODUCT: Readonly<Record<number, number>> = {
  20: ProductId.DN1,
  43: ProductId.DN2,
};

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
