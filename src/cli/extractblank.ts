/**
 * Regenerate `src/librarian/blankdata.ts` from a device-initialised project.
 *
 *   npm run extract-blank -- --project EMPTY.dn2prj --slot 5 --out src/librarian/blankdata.ts
 *   npm run extract-blank -- --project EMPTY.dn2prj --slot 5 --dn1 "004 GROOVY.dnprj" --dn1-slot 6 \
 *     --out src/librarian/blankdata.ts
 *
 * The blank is **captured, never synthesised** — the same rule the converter follows, and the
 * same choice elk-herd made for its own blank data. A patternKit contains regions we have not
 * identified (160 bytes before the kit's MIDI records, 500 trailing at 10,252), so the only
 * honest empty pattern is one a device wrote.
 *
 * ## What this refuses to do
 *
 * It will not extract from a project whose empty patterns disagree with each other. A blank
 * taken from a converted project is the **importer's** idea of empty, not the device's, and
 * those differ by thousands of bytes. Requiring internal agreement is what makes the output
 * trustworthy without anyone having to remember which files are safe sources.
 *
 * The output contains no user music: the only text in either blank is Elektron's factory
 * defaults — `PRESET 1..16`, `MIDI 1..16`, `SOUND 1..4`, `MACRO0..7`, `UNTITLED`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { decodeProjectImage } from "../project/dn2codec.js";
import { parseProject } from "../project/projectfile.js";
import { type ImageLayout, kitRecord, patternRecord } from "../project/dn2image.js";
import { deviceFor } from "../librarian/device.js";
import { rleEncode, toBase64 } from "../librarian/rle.js";

const KIT_NAME_AT = 8;
const KIT_NAME_SIZE = 16;

function load(path: string): Uint8Array {
  const { payload } = parseProject(new Uint8Array(readFileSync(path)));
  return decodeProjectImage(payload.raw).image;
}

/** The bytes that legitimately vary between two blanks in the same project. */
function normalised(image: Uint8Array, slot: number, layout: ImageLayout): string {
  const device = deviceFor(image);
  const pattern = Uint8Array.from(patternRecord(image, slot, layout));
  const kit = Uint8Array.from(kitRecord(image, slot, layout));
  pattern[device.slotIndexOffset] = 0;
  kit.fill(0, KIT_NAME_AT, KIT_NAME_AT + KIT_NAME_SIZE);
  return `${pattern.join(",")}|${kit.join(",")}`;
}

interface Extracted {
  label: string;
  source: string;
  slot: number;
  emptyCount: number;
  patternSize: number;
  kitSize: number;
  encoded: string;
}

function extract(path: string, slot: number, label: string): Extracted {
  const image = load(path);
  const device = deviceFor(image);
  const layout = device.layout;

  const empties: number[] = [];
  for (let i = 0; i < layout.patternCount; i++) {
    const summary = device.summarise(image, i);
    if (summary.supported && !summary.occupied) empties.push(i);
  }
  if (!empties.includes(slot)) {
    throw new Error(`slot ${slot} of ${basename(path)} is not an empty pattern`);
  }

  const shapes = new Set(empties.map((i) => normalised(image, i, layout)));
  if (shapes.size !== 1) {
    throw new Error(
      `${basename(path)} has ${shapes.size} different "empty" patterns across its ` +
        `${empties.length} empty slots. That means they are not all the device's ` +
        `initialisation default — a converted project's empty patterns are the importer's ` +
        `work, not the device's. Use a project the device initialised.`,
    );
  }

  const pattern = patternRecord(image, slot, layout);
  const kit = kitRecord(image, slot, layout);
  const joined = new Uint8Array(pattern.length + kit.length);
  joined.set(pattern, 0);
  joined.set(kit, pattern.length);

  return {
    label,
    source: basename(path),
    slot,
    emptyCount: empties.length,
    patternSize: pattern.length,
    kitSize: kit.length,
    encoded: toBase64(rleEncode(joined)),
  };
}

function wrap(text: string, width = 96): string {
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += width) lines.push(`  "${text.slice(i, i + width)}"`);
  return lines.join(" +\n");
}

function render(entries: Extracted[]): string {
  const header = `/**
 * Blank patternKits, captured from device-initialised projects.
 *
 * **Generated — do not edit by hand.** Regenerate with \`npm run extract-blank\`.
 *
 * A patternKit is a pattern record concatenated with its kit record, which is also exactly
 * what a SysEx pattern dump carries. These are needed to *delete* or *move* a pattern, since
 * both leave a slot that has to be filled with something, and a patternKit contains regions
 * whose meaning we do not know — inventing their contents is the one thing this project
 * never does.
 *
 * Each was taken from a project whose empty patterns all agree with each other, which is
 * what distinguishes a device's initialisation default from an importer's idea of empty.
 *
 * Two fields legitimately vary per slot and are patched at write time by \`blank.ts\`:
 * the pattern's slot-index byte, and the kit name. Everything else is constant.
 *
 * Contains no user music. The only text in either blank is Elektron's factory defaults.
 */

import { fromBase64, rleDecode } from "./rle.js";

export interface BlankPatternKit {
  /** The project this was captured from, for provenance. */
  source: string;
  slot: number;
  patternSize: number;
  kitSize: number;
  encoded: string;
}
`;

  const consts = entries
    .map(
      (e) => `
/**
 * ${e.label}: captured from slot ${e.slot} of \`${e.source}\`, whose ${e.emptyCount} empty
 * patterns are byte-identical once the slot index and kit name are normalised.
 */
export const ${e.label.toUpperCase()}_BLANK: BlankPatternKit = {
  source: ${JSON.stringify(e.source)},
  slot: ${e.slot},
  patternSize: ${e.patternSize},
  kitSize: ${e.kitSize},
  encoded:
${wrap(e.encoded)},
};`,
    )
    .join("\n");

  const tail = `

/** Decode a blank into its pattern and kit records. */
export function decodeBlank(blank: BlankPatternKit): { pattern: Uint8Array; kit: Uint8Array } {
  const joined = rleDecode(fromBase64(blank.encoded), blank.patternSize + blank.kitSize);
  return {
    pattern: joined.subarray(0, blank.patternSize),
    kit: joined.subarray(blank.patternSize),
  };
}
`;

  return `${header}${consts}${tail}`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const dn2Path = arg("project");
  const dn2Slot = Number(arg("slot") ?? 5);
  const dn1Path = arg("dn1");
  const dn1Slot = Number(arg("dn1-slot") ?? 6);
  const outPath = arg("out");

  if (!dn2Path || !outPath) {
    console.error(
      "usage: npm run extract-blank -- --project <EMPTY.dn2prj> [--slot N] " +
        "[--dn1 <blank.dnprj> --dn1-slot N] --out src/librarian/blankdata.ts",
    );
    process.exit(1);
  }

  const entries: Extracted[] = [extract(dn2Path, dn2Slot, "dn2")];
  if (dn1Path) entries.push(extract(dn1Path, dn1Slot, "dn1"));

  for (const e of entries) {
    const raw = e.patternSize + e.kitSize;
    console.log(
      `  ${e.label}: slot ${e.slot} of ${e.source}, ${e.emptyCount} agreeing empty slots, ` +
        `${raw} bytes -> ${e.encoded.length} base64 chars`,
    );
  }

  writeFileSync(outPath, render(entries));
  console.log(`\n  written: ${outPath}`);
}

main();
