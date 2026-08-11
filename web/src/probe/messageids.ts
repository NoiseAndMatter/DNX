/**
 * Which block of message ids the next long read gets.
 *
 * ## The constraint, and what breaks without it
 *
 * A single file read can consume thousands of ids — one per chunk — and **`msgId` is a u16**. A
 * counter that simply advanced would leave range in three presses and `encodeMessage` would start
 * throwing, mid-read, with a handle open on the device.
 *
 * So the space is divided into bands wide enough for a whole read, and this cycles through them.
 *
 * ## Cycling is not reusing
 *
 * By the time a band comes round again, several complete reads have finished and closed. What the
 * bands rule out is the collision actually observed: two sessions both numbering from 1, each
 * answering the other's requests.
 *
 * The bands start at 8,192 to stay clear of **Elektron Transfer**, which numbers from the low
 * hundreds. Sharing a port with Transfer is normal on this desk, and an id it also uses is an
 * answer that could belong to either of us.
 *
 * ## Why this is a class rather than a module-level counter
 *
 * It was the counter, and the invariant that keeps it inside a u16 was three named constants and a
 * modulo spread across a 2,000-line file — with nothing anywhere asserting that the arithmetic
 * actually stays in range. It does, and now something says so.
 */

/** The first band. Below this is Elektron Transfer's range. */
export const READ_ID_BASE = 8_192;

/** How many ids one read may consume. One per chunk, and a large file is thousands. */
export const READ_ID_SPAN = 8_192;

/** `8,192 … 49,152` — every band, and the top of the last one, inside a u16. */
export const READ_ID_BANDS = 6;

/** The largest value a `msgId` may take. Exceeding it is a throw, not a wrap. */
export const MAX_MESSAGE_ID = 0xffff;

export class MessageIdBands {
  #band = 0;

  /** The first id of the current band. */
  base(): number {
    return READ_ID_BASE + (this.#band % READ_ID_BANDS) * READ_ID_SPAN;
  }

  /**
   * Move to the next band.
   *
   * Called in a `finally`, so a read that threw still advances — the ids it already spent are gone
   * whether or not it finished, and coming round onto them is the collision this exists to avoid.
   */
  advance(): void {
    this.#band++;
  }

  /** Which band is current, 0-based and wrapped. Exposed for reporting, not for arithmetic. */
  get band(): number {
    return this.#band % READ_ID_BANDS;
  }
}
