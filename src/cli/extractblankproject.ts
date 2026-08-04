/**
 * Regenerate `src/librarian/blankproject.ts` from a device-initialised Digitone II project.
 *
 *   npm run extract-blank-project -- --project EMPTY.dn2prj
 *
 * ## Why a whole project, when `blankdata.ts` already exists
 *
 * That one holds blank **patternKits** — what a delete or a move needs to fill an emptied slot.
 * A whole project needs two things it does not have: the 512-byte header and the 109,572-byte tail
 * (sound pool, settings, song table, slot array).
 *
 * Without them there is nothing to be blank *from*, so a fresh clone with no corpus could not offer
 * "start from a blank project" at all — the tool needed a file the repository refuses to carry.
 *
 * ## Why this is safe to commit, and checked rather than assumed
 *
 * A device's initialised project contains no music and nothing personal. **This refuses to embed
 * one that is not actually blank**: every pattern must be unoccupied and every pool slot empty. A
 * generator that quietly shipped somebody's project would be a far worse bug than a missing
 * feature, so it is a refusal rather than a warning.
 *
 * The project identity at `0x18` travels with it and is meaningless — everything authored by DNX
 * re-mints its own (`mintProjectId`), so an embedded one can never reach an output file.
 *
 * ## Captured, never synthesised
 *
 * The same rule the converter and `blankdata.ts` follow. A project holds regions whose meaning we
 * have not established, and inventing their contents is the one thing this project never does.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { DN2_DEVICE } from "../librarian/device.js";
import { decodeProjectImage } from "../project/dn2codec.js";
import { parseProject } from "../node/projectfile.js";
import { DN2_LAYOUT } from "../project/dn2image.js";
import {
  DN2_POOL_OFFSET,
  DN2_SOUND_SIZE,
  SOUND_NAME_OFFSET,
  SOUND_NAME_SIZE,
} from "../project/soundmap.js";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const source = arg("project");
const out = arg("out") ?? "src/librarian/blankproject.ts";
if (!source) {
  console.error("usage: npm run extract-blank-project -- --project EMPTY.dn2prj [--out path]");
  process.exit(2);
}

const file = new Uint8Array(readFileSync(source));
const image = decodeProjectImage(parseProject(file).payload.raw).image;

// --- refuse anything that is not blank ------------------------------------------------------------

const occupied: string[] = [];
for (let slot = 0; slot < DN2_LAYOUT.patternCount; slot++) {
  if (DN2_DEVICE.summarise(image, slot).occupied) occupied.push(String(slot));
}

const named: string[] = [];
for (let slot = 0; slot < 128; slot++) {
  const at = DN2_LAYOUT.tailBase + DN2_POOL_OFFSET + slot * DN2_SOUND_SIZE + SOUND_NAME_OFFSET;
  const name = image.subarray(at, at + SOUND_NAME_SIZE);
  if (!name.every((b) => b === 0 || b === 0xff)) named.push(String(slot));
}

if (occupied.length > 0 || named.length > 0) {
  console.error(
    `refusing to embed ${source}: it is not blank.\n` +
      (occupied.length > 0 ? `  ${occupied.length} pattern(s) hold trigs: ${occupied.slice(0, 8).join(", ")}\n` : "") +
      (named.length > 0 ? `  ${named.length} pool slot(s) hold a sound: ${named.slice(0, 8).join(", ")}\n` : "") +
      `\nUse a project the device initialised and nothing has been written to. Embedding somebody's ` +
      `work in a public repository is a worse bug than a missing feature.`,
  );
  process.exit(1);
}

// --- emit -----------------------------------------------------------------------------------------

const base64 = Buffer.from(file).toString("base64");
const lines: string[] = [];
for (let at = 0; at < base64.length; at += 96) lines.push(`  "${base64.slice(at, at + 96)}",`);

writeFileSync(
  out,
  `/**
 * A blank Digitone II project, captured from an initialised device.
 *
 * **Generated — do not edit by hand.** Regenerate with:
 *
 *     npm run extract-blank-project -- --project EMPTY.dn2prj
 *
 * The whole \`.dn2prj\` file, base64. ${file.length.toLocaleString()} bytes, which is small because a
 * project file is a ZIP around an LZ4 payload and an empty project compresses to almost nothing.
 *
 * ## Why the file rather than the image
 *
 * The image is 12,889,604 bytes and would have to be re-wrapped to be written out. The file carries
 * its own \`manifest.json\`, which is exactly what \`buildProjectFile\` needs — so this one artefact
 * serves as **the blank destination, the donor for a device read, and the manifest for an export**.
 *
 * ## Why it is safe to have here
 *
 * It contains no music: the generator refuses to emit a project with a single occupied pattern or a
 * single named pool slot. The project identity at \`0x18\` travels with it and is inert, because
 * everything DNX authors re-mints its own.
 */

/** The blank project file, base64, split for readability. */
const CHUNKS: readonly string[] = [
${lines.join("\n")}
];

/**
 * The blank project as bytes.
 *
 * Decoded here rather than with \`atob\` or \`Buffer\`, because \`src/\` is platform-free — the same
 * bytes have to be available to the CLI and to a browser page with no bundler.
 */
export function blankDn2ProjectFile(): Uint8Array {
  return decodeBase64(CHUNKS.join(""));
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array((clean.length * 3) >> 2);
  let bits = 0;
  let held = 0;
  let at = 0;
  for (const ch of clean) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) throw new Error(\`"\${ch}" is not base64\`);
    held = (held << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (held >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}
`,
  "utf8",
);

console.log(`${out}: ${file.length.toLocaleString()} bytes, ${base64.length.toLocaleString()} base64`);
console.log(`verified blank: 0 occupied patterns, 0 named pool slots`);
