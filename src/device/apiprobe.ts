/**
 * Asking a device about itself through the **API**, one information code at a time.
 *
 * ## Why this exists
 *
 * `probecodes.ts` can build any `0x60`–`0x6f` *dump* request. Nothing could build an arbitrary
 * **API** request, so `0x03` and `0x09` — the two codes most likely to answer *"which project is
 * loaded?"* — were unreachable from the probe while we considered fingerprinting project content
 * to infer it.
 *
 * That inference would have been a hack twice over: it guesses at something the instrument knows,
 * and it breaks the moment a project has unsaved edits. **Prefer the device's own answer.** This
 * is the control that lets us ask for one.
 *
 * ## Read-only by construction, not by care
 *
 * The API's codes are grouped by nibble: `0x0n` device information, `0x1n` directories, `0x2n` file
 * management, `0x3n` reading, `0x4n` writing — and on a Digitone, `0x5n` is the storage API, whose
 * `0x5a`–`0x5c` **mutate** and whose `0x54` froze an instrument three times.
 *
 * So this does not take a number. It takes one of a **fixed list of information codes**, and the
 * list is the safety property: a control that accepted `0x5a` would eventually be given `0x5a`.
 *
 * `docs/device-probing.md` rule 0 is the reason that is not negotiable — the taxonomy there had no
 * category for *hangs the instrument* until one did.
 */

import { type ApiFrame, Code, encodeMessage, readDeviceResponse, readVersionResponse } from "./api.js";

/** A code this module is willing to send, and what is known about it. */
export interface InformationCode {
  code: number;
  name: string;
  /** What a reply is expected to contain, or what makes the code interesting when it is unknown. */
  note: string;
  /** True when the request takes a NUL-terminated key rather than an empty body. */
  takesKey?: boolean;
}

/**
 * Every API code safe to send blind, with why it is worth sending.
 *
 * **Deliberately not "every code below 0x50".** `0x2n` is file management and `0x4n` is writing;
 * neither has ever been sent to a Digitone and neither belongs behind a button whose whole purpose
 * is trying things. What is listed here either answers a question or is a known no-op.
 */
export const INFORMATION_CODES: readonly InformationCode[] = [
  { code: Code.Device, name: "Device", note: "product id, supported messages, device name" },
  { code: Code.Version, name: "Version", note: "firmware build and version strings" },
  {
    code: 0x03,
    name: "unnamed",
    // The reason this control was built. It appears in no public source, elk-herd included.
    note:
      "Transfer polls this continuously and got the same 4 bytes 1,991 times — but every one of " +
      "those samples was taken while it sat idle, so a value that tracks the loaded project would " +
      "have looked identical. Ask, load another project, ask again.",
  },
  {
    code: Code.DirList,
    name: "DirList",
    note:
      "elk-herd's directory listing. Timed out once, while Elektron Transfer held the port — so " +
      "it is untested rather than absent, and it has never been retried with a proven link.",
  },
];

/**
 * **`Query` is deliberately not here.** The probe already has a control for it, and that one knows
 * more than this module would: `capabilities.ts`'s `QUERY_KEYS` records that the namespace shape is
 * `<noun>_file.<prop>`, and that `project.`, `pattern.`, `kit.`, `sound.` and `device.` prefixes all
 * answered `none` — so those namespaces are wrong rather than those properties.
 *
 * Two controls sending the same message, one of them with worse guesses, is how a page ends up
 * disagreeing with itself about what has been tried.
 */

export class ApiProbeError extends Error {}

/**
 * Build a request for one information code.
 *
 * Refuses anything not on the list — by identity, not by range, so widening it is an edit somebody
 * makes on purpose rather than an arithmetic accident.
 */
export function informationRequest(msgId: number, code: number, key = ""): Uint8Array {
  const known = INFORMATION_CODES.find((c) => c.code === code);
  if (!known) {
    throw new ApiProbeError(
      `0x${code.toString(16)} is not an information code. This control sends only ` +
        `${INFORMATION_CODES.map((c) => `0x${c.code.toString(16)}`).join(", ")} — the API's other ` +
        `codes write, delete, or open handles, and one of them froze a Digitone 1 three times.`,
    );
  }
  if (!known.takesKey) return encodeMessage(msgId, code);
  if (key.length === 0) throw new ApiProbeError(`${known.name} needs a key`);
  return encodeMessage(msgId, code, keyBytes(key));
}

/**
 * Say what came back, decoding the two codes whose format is known and describing the rest.
 *
 * An unknown code gets its bytes and nothing else. Naming fields we have not established is how
 * `invalid project id` came to be read as the device declaring its argument type, which cost two
 * power cycles.
 */
export function describeApiReply(frame: ApiFrame): string {
  const request = frame.code & 0x7f;
  try {
    if (request === Code.Device) {
      const d = readDeviceResponse(frame.body);
      return `${d.deviceName}, product ${d.productId}, ${d.supportedMessages.length} messages advertised`;
    }
    if (request === Code.Version) {
      const v = readVersionResponse(frame.body);
      return `build ${v.build}, version ${v.version}`;
    }
  } catch (error) {
    return `${frame.body.length} bytes that did not decode: ${String(error)}`;
  }
  return `${frame.body.length} bytes, undecoded — ${hexBody(frame.body)}`;
}

/**
 * Hex, with the text alongside when it looks like text, because half these replies are strings.
 *
 * Named for its subject rather than its output: `capabilities.ts` also exported a `hex`, taking a
 * number instead of bytes, and the probe page imported both — aliasing this one at the import to
 * tell them apart. Two exported functions with one name is the defect; the alias was the symptom.
 */
export function hexBody(body: Uint8Array, limit = 32): string {
  const shown = body.subarray(0, limit);
  const bytes = [...shown].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const text = new TextDecoder("windows-1252").decode(shown).replace(/[^\x20-\x7e]/g, ".");
  return `${bytes}${body.length > limit ? " …" : ""}   "${text}"`;
}

/** NUL-terminated, the way every argument in this API is encoded. */
function keyBytes(key: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of key) {
    const code = ch.codePointAt(0)!;
    if (code > 0xff) throw new ApiProbeError(`"${ch}" is not encodable as a key`);
    bytes.push(code);
  }
  bytes.push(0);
  return Uint8Array.from(bytes);
}
