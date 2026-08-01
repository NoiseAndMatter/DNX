/**
 * Choosing which two MIDI ports are the instrument.
 *
 * ## The problem this owns
 *
 * A device is an input and an output that happen to have similar names, and **nothing in Web MIDI
 * says which belong together** — an interface with four ports gives no hint at all. So the pairing
 * is a guess by name, and the guess has to be beaten by the user the moment they disagree.
 *
 * That is the whole subject of this module: guess, then remember. It holds no protocol knowledge
 * and sends nothing.
 *
 * ## Why remembering matters more than it sounds
 *
 * Sending to a port opens it, opening it fires `statechange`, and `statechange` re-renders the
 * lists. Without a remembered choice the guess ran again on every probe and snapped the selects
 * back to whichever device it liked best — reported while probing a Digitone and a Digitone II side
 * by side, which is exactly when it is most annoying and least obvious.
 *
 * The remembered id is checked against the **live port map** rather than against the select's own
 * value, because a stale id would leave the control showing something no longer plugged in.
 */

import { escapeHtml } from "../../../src/sheet/html.js";
import { sharedPrefix } from "../devicelink.js";

/** How many ports of each kind were offered, so the caller can enable its own controls. */
export interface PortCounts {
  inputs: number;
  outputs: number;
}

export class PortPicker {
  /** What the user last chose, so a re-render does not undo it. */
  private chosen: { input?: string; output?: string } = {};

  constructor(
    private readonly inSelect: HTMLSelectElement,
    private readonly outSelect: HTMLSelectElement,
  ) {}

  /** Record a deliberate choice. It outranks the guess for as long as that port exists. */
  remember(which: "input" | "output", id: string): void {
    this.chosen[which] = id;
  }

  /** Drop both choices, so the next render guesses again. For a rescan. */
  forget(): void {
    this.chosen = {};
  }

  /** Fill both selects, guess the pair, then restore anything the user chose. */
  render(access: MIDIAccess): PortCounts {
    const inputs = [...access.inputs.values()];
    const outputs = [...access.outputs.values()];

    this.inSelect.innerHTML = options(inputs);
    this.outSelect.innerHTML = options(outputs);

    const guess = guessPair(inputs, outputs);
    if (guess) {
      this.outSelect.value = guess.output.id;
      this.inSelect.value = guess.input.id;
    }

    if (this.chosen.output !== undefined && access.outputs.has(this.chosen.output)) {
      this.outSelect.value = this.chosen.output;
    }
    if (this.chosen.input !== undefined && access.inputs.has(this.chosen.input)) {
      this.inSelect.value = this.chosen.input;
    }

    return { inputs: inputs.length, outputs: outputs.length };
  }

  /** The selected input, or `undefined` if it has been unplugged since. */
  input(access: MIDIAccess): MIDIInput | undefined {
    return access.inputs.get(this.inSelect.value);
  }

  /** The selected output, or `undefined` if it has been unplugged since. */
  output(access: MIDIAccess): MIDIOutput | undefined {
    return access.outputs.get(this.outSelect.value);
  }
}

function options(ports: (MIDIInput | MIDIOutput)[]): string {
  return ports
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name ?? p.id)}</option>`)
    .join("");
}

/**
 * The pair whose names agree the most, or `undefined` when none of them agree at all.
 *
 * **No shared prefix means no guess.** Picking the first of each would be a guess dressed as a
 * decision, and on an interface with four identical-looking ports it would be wrong three times in
 * four while looking exactly as confident as a right answer.
 */
function guessPair(
  inputs: MIDIInput[],
  outputs: MIDIOutput[],
): { input: MIDIInput; output: MIDIOutput } | undefined {
  let best: { input: MIDIInput; output: MIDIOutput; score: number } | undefined;
  for (const output of outputs) {
    for (const input of inputs) {
      const score = sharedPrefix(input.name ?? "", output.name ?? "");
      if (score > 0 && (!best || score > best.score)) best = { input, output, score };
    }
  }
  return best && { input: best.input, output: best.output };
}
