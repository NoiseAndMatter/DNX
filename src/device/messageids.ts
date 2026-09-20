/**
 * Message ids for every conversation a host has with an instrument — **one allocator, shared**.
 *
 * ## The bug this exists to make impossible
 *
 * `msgId` is how a reply is matched to its request. `DeviceLink` attaches a listener per call and
 * matches on it, so two conversations can run at once *provided their ids differ* — that is the
 * whole design. What it cannot survive is two callers choosing the same numbers.
 *
 * And they did, because every reader in `src/device/` defaults to `msgId ?? 1`. Two conversations
 * that both took the default both numbered from 1, and each answered the other's requests. It has
 * cost this project twice:
 *
 * - the **probe**, August: *"two presses produced two sessions numbering their messages from 1, on
 *   a transport with a single reply slot, so each stole the other's answers"*
 * - the **library**, 2026-08-14: a bank listing issued during a tag read was handed that read's
 *   reply — `expected 0xd3 to a listing and got 0xd4`, a directory request answered by a file open.
 *
 * Both were fixed locally, by not overlapping. **Neither fix stopped the next caller doing it**, and
 * the second was written a fortnight after the first by someone who had read the first.
 *
 * ## Reserve what you need, not a fixed band
 *
 * This replaces two separate fixed-band schemes — `MessageIdBands` in the probe and `nextDriveId`
 * in `devicesource.ts`, the same idea implemented twice and shared with nothing. Both handed out
 * 8,192 ids whatever the caller was doing.
 *
 * That is the wrong shape, because the conversations differ by four orders of magnitude:
 *
 * | | ids |
 * |---|---|
 * | a directory listing | **1** |
 * | reading one preset | 2 |
 * | a bank's tags, 256 slots | ~512 |
 * | a 12.9 MB project | **~6,300** |
 *
 * Fixed bands spent 8,192 on a one-message listing, so six listings exhausted the space and the
 * seventh reused a band a running project read still owned. Reserving by size means the same space
 * holds far more live conversations, and a listing costs a listing.
 *
 * ## Wrapping, and why it is safe
 *
 * `msgId` is a u16, so the space is finite and reuse is eventually unavoidable. This wraps only
 * after **57,344** ids have been handed out — dozens of project reads, thousands of listings. A
 * conversation still alive after that much traffic is not one any scheme could have saved.
 *
 * ## Below 8,192 is not ours
 *
 * **Elektron Transfer numbers from the low hundreds**, and sharing a port with it is normal on this
 * desk. An id Transfer also uses is a reply that could belong to either of us, so the allocator
 * never goes there.
 *
 * **Measured, 2026-09-16.** With Transfer browsing a Digitone II's library, a passive listen saw
 * its polling loop use ids **126 to 149** — Device, Version and an idle poll, repeating and
 * numbering sequentially. The claim above had been an assumption since the file was written; it
 * is now a measurement. `othertraffic.ts` reads this floor the other way round, to notice that
 * another application is on the port.
 */

/** The first id an allocator will ever hand out. Below it is Elektron Transfer's range. */
export const FIRST_MESSAGE_ID = 8_192;

/** The largest value a `msgId` may take — it is a u16. */
export const MAX_MESSAGE_ID = 0xffff;

/** How many ids there are to work with, once Transfer's range is left alone. */
export const MESSAGE_ID_SPAN = MAX_MESSAGE_ID - FIRST_MESSAGE_ID + 1;

/**
 * One numbering space, owned by whoever holds it.
 *
 * **An instance rather than a module-level counter**, because core may hold no mutable state of
 * its own: a second host in one process would otherwise share this one's numbering by accident,
 * and a test could not start from a known point without reaching into the module. The browser
 * keeps exactly one of these and hands it to everything, which is the property the whole file
 * exists to guarantee.
 */
export class MessageIds {
  private next = FIRST_MESSAGE_ID;

  /**
   * Reserve a run of ids no other conversation will use.
   *
   * `count` is how many requests the conversation will send — **one per chunk** for a file read,
   * so be generous rather than exact. Over-reserving costs only space that wraps around anyway;
   * under-reserving means running past the reservation into somebody else's, which is the bug.
   *
   * Returns the first id. The caller numbers upward from it.
   */
  reserve(count: number): number {
    if (!Number.isInteger(count) || count < 1) {
      throw new RangeError(`a reservation is at least one id, not ${count}`);
    }
    if (count > MESSAGE_ID_SPAN) {
      throw new RangeError(
        `${count} ids is more than the ${MESSAGE_ID_SPAN} a u16 leaves once Transfer's range is ` +
          `avoided — a conversation this long cannot be numbered safely`,
      );
    }

    // Wrapped whole rather than split across the top: a reservation straddling the end would hand
    // back a base whose run leaves the u16, and `encodeMessage` would throw mid-conversation with a
    // handle open on the device.
    if (this.next + count > MAX_MESSAGE_ID) this.next = FIRST_MESSAGE_ID;

    const base = this.next;
    this.next += count;
    return base;
  }

  /** Start again from the floor. **Tests only** — a host has one conversation space for its life. */
  reset(): void {
    this.next = FIRST_MESSAGE_ID;
  }
}

/**
 * How many ids one conversation of each kind needs.
 *
 * Named so a call site reads as intent rather than as arithmetic, and generous by design — see the
 * note on `count` above. These are ceilings, not measurements.
 */
export const IDS_FOR = {
  /** A directory listing, a device query — anything that is one request and one reply. */
  oneMessage: 4,
  /** Reading a single stored object: open, a few chunks, close. A kit is 10,795 bytes. */
  oneObject: 32,
  /** Reading every occupied slot in a bank of 256. */
  wholeBank: 8_192,
  /** A whole project — 12.9 MB at 2,048 bytes a chunk is about 6,300 requests. */
  wholeProject: 8_192,
} as const;
