/**
 * What to say when a request comes back with nothing.
 *
 * Every device operation on this page ends the same way when it fails: send a message the device
 * always answers, and let the result decide whether the silence belongs to the device or to us.
 * That check is the project's oldest hard-won rule — a run of silences was once recorded as *"not
 * implemented"* while another application held the output port, so those requests may never have
 * left the machine at all. See `storageio.ts`, and `docs/device-probing.md`.
 *
 * The rule was applied six times and written out six times, and the six copies had drifted:
 *
 * - four wordings of the same `Link check` row, one of them the bare word `PASSED`
 * - three different meanings for a failed check — the shared constant, a bespoke freeze warning,
 *   and once the two words `power-cycle it.`
 * - and **the sentence that says not to write the result down appeared on one of the six.**
 *
 * That last one is the whole point of the check. A silence that reached no device is not a weak
 * result, it is *no result*, and recording it is how the afternoon got voided in the first place.
 * A rule that has to be remembered at six call sites is a rule that will be applied at five.
 *
 * So the caller supplies only what it alone knows — what it was doing, and what a *proven* silence
 * would mean for that particular request. Everything that follows from the link check is decided
 * here, once.
 *
 * Pure on purpose: no MIDI, no DOM, no imports. It is the half of these six blocks that can be
 * tested without an instrument, which is why it is worth separating from the half that cannot.
 */

/** Shown when the link check fails, because the cause is almost always the same one. */
export const LINK_DEAD =
  "the device did not answer a message it always answers, so nothing we send is reaching it. " +
  "Another application — Elektron Transfer, Overbridge, a DAW — is most likely holding the output " +
  "port. Close it and try again. Until this passes, a silence proves nothing.";

/**
 * Shown instead when the operation is one that has stopped an instrument dead.
 *
 * The +Drive write froze a Digitone 1 three times on 2026-07-30. For those requests a failed link
 * check is not "something else holds the port" — the port was ours a moment ago — it is the
 * device itself having gone, and the advice is different.
 */
export const DEVICE_FROZEN =
  "the device answered this port moments ago and does not now, so it has most likely stopped " +
  "rather than been taken from us. It froze this way three times on 2026-07-30. Power-cycle it. " +
  "Anything unsaved in the active project is gone.";

/** Appended to every failed check, because a result nobody can trust must not be written down. */
export const RESULT_IS_VOID = "**This result is void — do not record it.**";

export interface Verdict {
  /** The card heading. */
  title: string;
  /** The card body: the caller's own log, then what happened, then what it means. */
  rows: [string, string][];
  /** One line for the status bar. */
  message: string;
  level: "warn" | "error";
}

export interface SilenceInput {
  /**
   * The operation, as it reads at the start of a sentence: `"Listing"`, `"The read"`, `"0x62"`.
   * Used in both the title and the status line, so it is a noun phrase rather than a verb.
   */
  what: string;
  /** Did the device answer a message it always answers, after this request did not? */
  alive: boolean;
  /** What actually happened — a timeout phrase, or the error the request threw. */
  outcome: string;
  /** The label for that row. A timeout is a `Result`; a thrown request is an `Error`. */
  outcomeLabel?: "Result" | "Error";
  /** The rows the caller had already built describing what it sent. Kept at the top, unchanged. */
  log?: readonly [string, string][];
  /**
   * What a *proven* silence means for this request in particular — the one judgement the caller
   * knows and this module cannot. Only ever shown when the link check passed.
   */
  means: string;
  /**
   * True for the operations that have frozen an instrument, which changes what a failed check
   * means and what the user should do about it.
   */
  canFreeze?: boolean;
}

/**
 * Turn a silence into a verdict, having already checked the link.
 *
 * The caller runs the link check itself, because that needs an output port; this decides what the
 * answer is worth.
 */
export function verdictAfterSilence(input: SilenceInput): Verdict {
  const { what, alive, outcome, means, canFreeze = false } = input;
  const rows: [string, string][] = [...(input.log ?? [])];

  rows.push([input.outcomeLabel ?? "Result", outcome]);
  rows.push([
    "Link check",
    alive
      ? "PASSED — the device answered afterwards, so the silence is its own"
      : "FAILED — the device did not answer a message it always answers",
  ]);
  rows.push([
    "Means",
    alive ? means : `${canFreeze ? DEVICE_FROZEN : LINK_DEAD} ${RESULT_IS_VOID}`,
  ]);

  return {
    title: alive
      ? `${what} — no answer, and the link is proven`
      : canFreeze
        ? `${what} — THE DEVICE IS NOT ANSWERING`
        : `${what} — nothing is reaching the device`,
    rows,
    message: alive
      ? `${what}: a genuine silence, and the link is fine.`
      : canFreeze
        ? `${what}: the device stopped answering — power-cycle it.`
        : `${what}: void — nothing is reaching the device.`,
    level: alive ? "warn" : "error",
  };
}
