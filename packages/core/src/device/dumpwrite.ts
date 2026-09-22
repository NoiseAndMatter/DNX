/**
 * Send a record **to** an instrument.
 *
 * The first thing in DNX that can destroy someone's work. A `0x5n` addressed to a device means
 * *store this*: no dry run on the wire, no undo, and no confirmation from the device — it takes
 * the bytes and keeps them. elk-herd writes a project exactly this way, which is the direct
 * evidence for what these messages do in this direction.
 *
 * `docs/device-probing.md` carries the regime and was written before this file. The parts that
 * belong in code rather than in prose are here, because a rule that lives only in a document is a
 * rule that holds until somebody is in a hurry.
 *
 * ## Writing is only worth doing because reading works
 *
 * Until a device could be read by request, "did that write land correctly?" could be answered only
 * by looking at the instrument's screen. Now it is exact: **write a record, request it back,
 * compare the bytes** — the same round trip that caught `G11`'s corruption.
 *
 * So `verifyWrite` is not an optional extra here. **A write is not finished until it has been read
 * back and compared**, because the failure mode of a bad write is silence: the device does not
 * complain, it just holds different bytes than you think.
 *
 * ## Every guard, and what it is actually for
 *
 * 1. **Payload size must equal the record's size for that family.** A short payload is not a
 *    partial write to tolerate; it is a message that means something else.
 * 2. **The object number is range-checked.** One byte stands between the intended slot and
 *    somebody's work.
 * 3. **Storage version must match a record read from the same device.** A record captured under
 *    one firmware and written to another is precisely the corruption this project has spent its
 *    whole life avoiding — see `dn2-format.md` §8a, where the Digitakt II's own tables show the
 *    version bumping between OS releases. The check is against a **witness**: a record actually
 *    read from the target in this session. Comparing against a table would only test our belief
 *    about the firmware; comparing against the device's own bytes tests the device.
 * 4. **`0x54` ProjectSettings and a Digitone 1's `0x53` are refused by default.** Settings is
 *    global state rather than one slot. And a DN1's `0x53` is ambiguous in the *read* direction —
 *    kit sound or pool sound, established 2026-07-29 — so its write direction is unproven, and an
 *    unproven write is not the place to find out.
 */

import { buildMessage, parseMessage } from "../sysex/container.js";
import { ProductId } from "../sysex/devices.js";
import { DN1_LAYOUT, DN2_LAYOUT } from "../project/dn2image.js";
import { RESPONSE_SIZES } from "./readplan.js";

export class WriteRefused extends Error {}

/** Dump types that can be sent to a device, and what each one overwrites. */
export const WriteCode = {
  PatternKit: 0x50,
  Pattern: 0x51,
  Kit: 0x52,
  Sound: 0x53,
  ProjectSettings: 0x54,
} as const;

export type WriteCode = (typeof WriteCode)[keyof typeof WriteCode];

/**
 * Codes that need an explicit reason before they will be sent.
 *
 * Not a blanket ban — a caller that knows what it is doing can pass `allow` — but the default for
 * "this changes more than one slot" and "we do not know what this addresses" is no.
 */
export function needsJustification(productId: number, code: number): string | undefined {
  if (code === WriteCode.ProjectSettings) {
    return "ProjectSettings is global state, not one slot: it carries the slot array, the CC map " +
      "and, on a Digitone 1, everything up to the song table";
  }
  if (code === WriteCode.Sound && productId === ProductId.DN1) {
    return "a Digitone 1's 0x53 is ambiguous even when reading — kit track sound or pool slot — " +
      "so where a written one lands is unproven";
  }
  return undefined;
}

/** The payload size a family's record must have, or undefined for a code we cannot size. */
export function recordSize(productId: number, code: number): number | undefined {
  const sizes = RESPONSE_SIZES[productId];
  const layout = productId === ProductId.DN1 ? DN1_LAYOUT : productId === ProductId.DN2 ? DN2_LAYOUT : undefined;
  if (!sizes || !layout) return undefined;
  switch (code) {
    case WriteCode.PatternKit: return sizes.patternKit;
    case WriteCode.Pattern: return layout.patternSize;
    case WriteCode.Kit: return layout.kitSize;
    case WriteCode.Sound: return sizes.sound;
    case WriteCode.ProjectSettings: return sizes.settings;
    default: return undefined;
  }
}

/**
 * The storage version a record declares, when we know where it keeps one.
 *
 * Elektron objects open with `BEEFBACE` and a big-endian u32 version — `dn2image.ts` records the
 * layout and elk-herd's `Instrument.elm` maps versions to OS releases. A record with no magic at
 * its head returns undefined rather than a guess: an unknown version must not read as a match.
 */
export function storageVersion(payload: Uint8Array): number | undefined {
  const magic = [0xbe, 0xef, 0xba, 0xce];
  if (payload.length < 8 || !magic.every((b, i) => payload[i] === b)) return undefined;
  return (
    ((payload[4]! << 24) | (payload[5]! << 16) | (payload[6]! << 8) | payload[7]!) >>> 0
  );
}

/**
 * Where a record of a given code keeps its version, and whether an object magic precedes it.
 *
 * **Written after the guard turned out to be inert for the record we write most.** A PatternKit is
 * `pattern ++ kit`, and on a Digitone II only the kit half opens with `BEEFBACE`. Reading the
 * version from byte 0 returned `undefined` for every patternKit, both sides of the comparison
 * matched as unknown, and the version check silently passed on everything.
 *
 * A guard that cannot fail is not a guard. Found by a test that expected a refusal and got a
 * successful write.
 *
 * `magic` exists because the second half of that lesson arrived with OS 1.43. A **Digitone 1**
 * kit record carries a bare u32be version and no magic at all (`dn1.ts`, `DN1_KIT`), so requiring
 * `BEEFBACE` left the guard inert on that family too, on every code. 1.43 is the first firmware
 * to move a Digitone 1 record version (pattern and kit, 10 to 11), which is when an inert guard
 * stops being harmless: a version-10 record written onto a 1.43 instrument is a record the
 * instrument will not migrate, because migration runs on load against the whole project's
 * version rather than the record's.
 */
export function versionField(
  productId: number,
  code: number,
): { at: number; magic: boolean } | undefined {
  const layout = productId === ProductId.DN1 ? DN1_LAYOUT : productId === ProductId.DN2 ? DN2_LAYOUT : undefined;
  if (!layout) return undefined;
  const dn1 = productId === ProductId.DN1;
  switch (code) {
    // On a Digitone 1 both halves carry the same bare version, so byte 0 serves and needs no
    // arithmetic. On a Digitone II the pattern half has none and the kit half is magic-headed.
    case WriteCode.PatternKit:
      return dn1 ? { at: 0, magic: false } : { at: layout.patternSize, magic: true };
    case WriteCode.Pattern:
      // Bare u32be at byte 0 on a Digitone 1. A Digitone II pattern record's version lives in the
      // same place, but `asVersion3` already owns reading it and nothing here has needed it.
      return dn1 ? { at: 0, magic: false } : undefined;
    case WriteCode.Kit:
      return { at: 0, magic: !dn1 };
    case WriteCode.Sound:
      // A sound object is a real Elektron object on both families.
      return { at: 0, magic: true };
    // A settings record carries no version this module has established on either family.
    // Returning undefined says so; it does not guess at zero.
    default:
      return undefined;
  }
}

/** The storage version a record of this code declares, or undefined when it declares none. */
export function versionOf(productId: number, code: number, payload: Uint8Array): number | undefined {
  const field = versionField(productId, code);
  if (field === undefined) return undefined;
  const at = payload.subarray(field.at);
  return field.magic ? storageVersion(at) : bareVersion(at);
}

/** A u32be version with no object magic in front of it, as both Digitone 1 records carry. */
function bareVersion(payload: Uint8Array): number | undefined {
  if (payload.length < 4) return undefined;
  return (
    ((payload[0]! << 24) | (payload[1]! << 16) | (payload[2]! << 8) | payload[3]!) >>> 0
  );
}

export interface WriteRequest {
  code: WriteCode;
  /** The slot to overwrite. */
  objNr: number;
  payload: Uint8Array;
  /**
   * A record of the same code **read from the target device in this session**.
   *
   * Required, and it is the guard that cannot be faked by getting our own tables wrong: it proves
   * the device speaks this record's version, because the device produced it.
   */
  witness: Uint8Array;
  /** Why a refused code is being sent anyway. Only consulted for `needsJustification` codes. */
  allow?: string;
}

/**
 * Build a message that overwrites one object on a device.
 *
 * Refuses rather than warns, everywhere. Every refusal here is a case where sending anyway would
 * change an instrument in a way nobody could see from the outside.
 */
export function dumpWrite(productId: number, request: WriteRequest): Uint8Array {
  const size = recordSize(productId, request.code);
  if (size === undefined) {
    throw new WriteRefused(
      `no record size recorded for 0x${request.code.toString(16)} on product ` +
        `0x${productId.toString(16)} — writing a record whose length we cannot check is not a ` +
        `thing to do to an instrument`,
    );
  }

  const justification = needsJustification(productId, request.code);
  if (justification !== undefined && !request.allow) {
    throw new WriteRefused(`refused: ${justification}`);
  }

  if (request.payload.length !== size) {
    throw new WriteRefused(
      `payload is ${request.payload.length} bytes and this record is ${size} — a short payload is ` +
        `not a partial write, it is a different message`,
    );
  }

  if (!Number.isInteger(request.objNr) || request.objNr < 0 || request.objNr > 127) {
    throw new WriteRefused(`object number ${request.objNr} does not fit in the 7-bit field`);
  }

  if (request.witness.length !== size) {
    throw new WriteRefused(
      `the witness record is ${request.witness.length} bytes, not ${size} — it has to be a record ` +
        `of the same kind, read from the device being written to`,
    );
  }

  // Read from where this record actually keeps its version. See `versionField`: reading byte 0
  // made the check pass on every patternKit ever written, and requiring an object magic made it
  // pass on every Digitone 1 record.
  const target = versionOf(productId, request.code, request.witness);
  const ours = versionOf(productId, request.code, request.payload);
  if (target !== undefined && ours !== target) {
    throw new WriteRefused(
      `this record is storage version ${ours ?? "unknown"} and the device answered with version ` +
        `${target}. Writing across versions is how a project becomes unreadable by the machine ` +
        `that has to load it.`,
    );
  }

  return buildMessage({
    productId,
    dumpType: request.code,
    objNr: request.objNr,
    payload: request.payload,
  });
}

/**
 * How long to leave a device alone after sending it a dump, before asking it anything.
 *
 * **Found on hardware.** A 114 KB pattern was written to an occupied slot and landed correctly —
 * the user confirmed it on the device — but the read-back request that followed **got no reply at
 * all**. The request went out with zero delay behind 114 KB of SysEx, and the device, still
 * ingesting, dropped it.
 *
 * elk-herd has always done this and it is the one part of its send path we had not copied:
 * `SysEx.elm`'s `sendDump` sleeps `size / bytesPerMs + 20` before doing anything else, at 200 B/ms
 * for a Digitakt and 800 for a Digitakt II. Same figures, same purpose, adapted with attribution.
 *
 * Note what the symptom looked like: a write that worked and a UI that hung waiting. Nothing about
 * it pointed at pacing, which is why the fix belongs in code that every write path shares rather
 * than in whichever caller noticed.
 */
export function settleMsAfter(wireBytes: number, productId: number): number {
  const rate = productId === ProductId.DN1 ? 200 : 800;
  // A larger floor than elk-herd's 20 ms: it is pacing a stream of sends it controls, while this
  // is followed immediately by a request whose loss is silent and looks like a dead device.
  return Math.max(250, Math.ceil(wireBytes / rate) + 200);
}

export interface WriteVerdict {
  ok: boolean;
  /** First differing byte, when they differ. */
  at?: number;
  reason?: string;
}

/**
 * Compare what was sent against what the device gives back when asked for it again.
 *
 * **The only proof a write worked.** A device that stored the bytes and a device that ignored the
 * message look identical from the sending end, and a device that stored them in the wrong slot
 * looks identical to both.
 */
export function verifyWrite(sent: Uint8Array, readBack: Uint8Array): WriteVerdict {
  if (sent.length !== readBack.length) {
    return {
      ok: false,
      reason: `the device returned ${readBack.length} bytes for a ${sent.length}-byte record`,
    };
  }
  for (let i = 0; i < sent.length; i++) {
    if (sent[i] !== readBack[i]) {
      return { ok: false, at: i, reason: `byte ${i}: sent 0x${sent[i]!.toString(16)}, device holds 0x${readBack[i]!.toString(16)}` };
    }
  }
  return { ok: true };
}

/** How far a slot has moved since it was captured. */
export interface RecordDrift {
  same: boolean;
  /** How many bytes differ. When the lengths differ this is the larger length, not a count. */
  differingBytes: number;
  /** First differing byte, when both are the same length. */
  at?: number;
  /** A sentence for a confirmation to quote. Absent when nothing has moved. */
  reason?: string;
}

/**
 * Has the slot changed since the capture was taken?
 *
 * **The question a null round trip has to ask before it can call itself null.** Sending a captured
 * record back to its own slot is the safest write there is only while the slot still holds those
 * bytes. Turn a knob between the read and the write and it is an ordinary overwrite of an ordinary
 * edit, made under a confirmation promising nothing would change.
 *
 * Separate from `verifyWrite`, which answers a different question with the same comparison: that
 * one asks whether a write landed and stops at the first difference, because one wrong byte is
 * already the whole answer. This one is read by somebody deciding whether to write at all, and
 * "three bytes differ" and "half the record differs" are not the same decision.
 */
export function driftSince(captured: Uint8Array, onDevice: Uint8Array): RecordDrift {
  if (captured.length !== onDevice.length) {
    return {
      same: false,
      differingBytes: Math.max(captured.length, onDevice.length),
      reason: `the slot holds ${onDevice.length.toLocaleString()} bytes and the capture is ` +
        `${captured.length.toLocaleString()}`,
    };
  }

  let differing = 0;
  let at: number | undefined;
  for (let i = 0; i < captured.length; i++) {
    if (captured[i] === onDevice[i]) continue;
    differing++;
    at ??= i;
  }

  if (differing === 0) return { same: true, differingBytes: 0 };
  return {
    same: false,
    differingBytes: differing,
    at: at!,
    reason: `${differing.toLocaleString()} of ${captured.length.toLocaleString()} bytes differ, ` +
      `the first at ${at}`,
  };
}

/**
 * The safest possible first write: a record sent back to the slot it came from.
 *
 * Identical bytes to the same place. If the write path works, nothing changed; if it is broken,
 * nothing changed either; and if the bytes land somewhere else, reading back shows it while the
 * original is still in the capture. There is no cheaper way to find out whether writing works at
 * all, which is why this is a named function rather than a comment on a general one.
 */
/**
 * Whether a captured patternKit is an untouched slot.
 *
 * Used to decide whether a write **destroys** something or merely fills a hole. It compares
 * against the captured blank rather than counting trigs, because the blank is itself a device
 * artefact — `librarian/blank.ts` extracted it from a device-initialised project — so this asks
 * "is this what the device puts in an empty slot?" rather than "does this look empty to us?".
 *
 * The slot-index byte and the kit name are excluded: a blank in slot 5 legitimately differs from a
 * blank in slot 0 at exactly those places, and treating that as content would call every empty
 * slot occupied.
 */
export function looksBlank(
  patternKit: Uint8Array,
  blank: { pattern: Uint8Array; kit: Uint8Array },
  slotIndexOffset: number,
  kitNameOffset: number,
  kitNameSize: number,
): { blank: boolean; differingBytes: number } {
  const patternSize = blank.pattern.length;
  if (patternKit.length !== patternSize + blank.kit.length) {
    return { blank: false, differingBytes: patternKit.length };
  }

  let differing = 0;
  for (let i = 0; i < patternSize; i++) {
    if (i === slotIndexOffset) continue;
    if (patternKit[i] !== blank.pattern[i]) differing++;
  }
  for (let i = 0; i < blank.kit.length; i++) {
    if (i >= kitNameOffset && i < kitNameOffset + kitNameSize) continue;
    if (patternKit[patternSize + i] !== blank.kit[i]) differing++;
  }
  return { blank: differing === 0, differingBytes: differing };
}

export function nullRoundTrip(productId: number, captured: Uint8Array): Uint8Array {
  const message = parseMessage(captured);
  return dumpWrite(productId, {
    code: message.dumpType as WriteCode,
    objNr: message.objNr,
    payload: message.payload,
    witness: message.payload,
  });
}

/**
 * Send a captured record to a **different** slot.
 *
 * The first write that actually changes something, and the reason the null round trip came first:
 * this one cannot be undone by the fact that the bytes were already there.
 *
 * The record carries the slot it believes it occupies — `librarian/blank.ts` sets that byte when
 * it mints a blank, and `shuffle`/`rearrange` maintain it when moving patterns inside a file. A
 * record written to a slot it does not claim is a record the device may file under its own idea of
 * where it belongs, so the byte is restamped here rather than hoped about.
 */
export function writeToSlot(
  productId: number,
  captured: Uint8Array,
  destination: number,
  slotIndexOffset: number,
): Uint8Array {
  const message = parseMessage(captured);
  const payload = Uint8Array.from(message.payload);
  payload[slotIndexOffset] = destination;

  return dumpWrite(productId, {
    code: message.dumpType as WriteCode,
    objNr: destination,
    payload,
    // The source record came off this device, so it is its own proof of version.
    witness: message.payload,
  });
}
