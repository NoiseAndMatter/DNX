/**
 * The one relaxation of "never overwrite": a project may be written back over the slot it came out
 * of.
 *
 * ## The rule, and why it is not "the slot is full"
 *
 * `refuseUnlessEmpty` stops every write to an occupied +Drive slot. Exactly one thing lifts it:
 * **this is the project that was in it.** Occupancy is not the permission and never was — a slot
 * being full is the reason to refuse, not a reason to allow.
 *
 * That claim used to be a slot number alone. It is now a slot number *and the instrument it is on*,
 * because the manager works with either Digitone and with two of the same one. Opening slot 47 off
 * instrument A, switching to instrument B and pressing save offered to "replace" B's slot 47 on the
 * authority of a project that came off A. The destination was still copied first and the
 * confirmation still named what was really there, so nothing was lost — but the permission was
 * granted on false grounds, and a permission granted on false grounds is the whole subject of this
 * file.
 *
 * ## What identity can and cannot prove
 *
 * A Digitone answers its product id, its name and its firmware, and **nothing unique**. Asked on a
 * Digitone II, 2026-09-08: `0x01` gives `Digitone II, product 43, 22 messages advertised` and
 * `0x02` gives `build 0050, version 1.10E`. There is no serial number in either.
 *
 * So this can tell a Digitone 1 from a Digitone II, and it **cannot tell two Digitone IIs apart**.
 * Anyone with a second identical instrument can defeat the check by plugging in the other one. That
 * is stated here rather than papered over, and it is why identity is the *second* line of defence:
 * the first is that every overwrite copies the destination to your machine before it starts, and
 * the confirmation names what is at the path according to a listing taken seconds earlier.
 *
 * **A serial number may exist, and it is not on this road either way.** Digitone II OS 1.10E holds
 * the strings `#READ_SERIAL`, `%.14s`, `SERIAL NUMBER CRC ERROR` and `NO SERIAL NUMBER` near each
 * other in its string pool — sibling `dn_firmware` project, 2026-09-08.
 *
 * **That is four strings, and the chain from them is one link long.** A string existing shows a
 * string exists. No code path for `#READ_SERIAL` has been disassembled, nothing shows where a
 * serial would be stored or that any unit has one programmed — `NO SERIAL NUMBER` is among the
 * replies — and `%.14s` is tied to the serial by *adjacency in a string pool*, which is the order a
 * compiler emitted literals in, not a binding. Nothing has been sent to any instrument by anyone.
 *
 * So the sentence above is exact as scoped — *nothing unique in what the dump and file protocols
 * answer* — and it is not the same as "a Digitone has no serial". If that interface is ever
 * understood and shown to be safe to ask, this comparison has an obvious upgrade and the test
 * below is written to fail when somebody makes it.
 *
 * ## Two numbering systems, never compared
 *
 * `productId` here is the **dump-protocol** id — 13 for a Digitone 1, 21 for a Digitone II — which
 * is what `ConnectedDevice` carries and what a backup manifest records. The file API reports a
 * different number for the same instrument (43 for a Digitone II). Comparing across the two would
 * refuse every legitimate claim, so both sides of every comparison here come from the same source.
 */

/** As much of an instrument as anything can establish. */
export interface DeviceIdentity {
  name: string;
  /** Dump-protocol product id. Never the file API's. */
  productId: number;
}

/** Where a project came from, and therefore the one slot it may be written back over. */
export interface SlotOrigin {
  slot: number;
  /** The project's name in that slot when it was read, for the confirmation to quote. */
  name: string;
  device: DeviceIdentity;
}

export type OriginClaim =
  | { allowed: true }
  | { allowed: false; reason: string };

const ALLOWED: OriginClaim = { allowed: true };

/**
 * May this project be written over `slot` on `connected`?
 *
 * Every refusal carries a sentence, because the caller shows it to somebody who is about to
 * conclude the feature is broken.
 */
export function mayReplaceSlot(
  origin: SlotOrigin | undefined,
  connected: DeviceIdentity,
  slot: number,
): OriginClaim {
  if (!origin) {
    return {
      allowed: false,
      reason: "This project did not come out of a +Drive slot, so there is no slot it may replace.",
    };
  }

  if (origin.slot !== slot) {
    return {
      allowed: false,
      reason: `This project came out of slot ${origin.slot}, not slot ${slot}. ` +
        "A project may only be written back over the slot it came from.",
    };
  }

  if (origin.device.productId !== connected.productId) {
    return {
      allowed: false,
      reason: `This project came off a ${origin.device.name} and the connected instrument is a ` +
        `${connected.name}. Slot ${slot} on this instrument is a different slot.`,
    };
  }

  if (origin.device.name !== connected.name) {
    // Same product id and a different name is not a case anybody has seen. It is refused rather
    // than reasoned about, because the cost of being wrong is somebody's project.
    return {
      allowed: false,
      reason: `This project came off "${origin.device.name}" and the connected instrument calls ` +
        `itself "${connected.name}".`,
    };
  }

  return ALLOWED;
}

/**
 * The instrument a backup was taken from, as an identity.
 *
 * A backup manifest records exactly what `ConnectedDevice` carried at the time, so an entry read
 * out of one can claim its slot back on the instrument it came off.
 */
export function identityOf(device: { name: string; productId: number }): DeviceIdentity {
  return { name: device.name, productId: device.productId };
}
