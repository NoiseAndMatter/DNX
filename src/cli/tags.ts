/**
 * Explore the tags in a project or across a library, so placement rules can be written
 * against what is actually there rather than against what the tag table says exists.
 *
 *   npm run tags -- <project.dnprj>              tags on the sounds this project uses
 *   npm run tags -- --sounds <project.dnprj>     per-sound listing
 *   npm run tags -- --library <dir>              aggregate across every project in a folder
 *   npm run tags -- --locked <project.dnprj>     only sounds used as sound locks
 *                                                (the ones the expander will place)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseProject } from "../project/projectfile.js";
import { decodeProjectImage } from "../project/dn2codec.js";
import { readKit, readProjectName, readSoundPool, type Dn1Sound } from "../project/dn1.js";
import { TAG_NAMES, decodeTags, soundCharacter, type TagName } from "../project/tags.js";
import { collectSoundUsage } from "../expand/plan.js";

function load(path: string): Uint8Array {
  const { payload } = parseProject(new Uint8Array(readFileSync(path)));
  return decodeProjectImage(payload.raw).image;
}

interface Entry {
  sound: Dn1Sound;
  /** How many trigs sound-lock this sound. Zero for home sounds. */
  trigCount: number;
  locked: boolean;
}

/** Every distinct sound a project actually uses, home sounds and sound locks alike. */
function usedSounds(image: Uint8Array, lockedOnly: boolean): Entry[] {
  const pool = readSoundPool(image);
  const byName = new Map<string, Entry>();

  for (const u of collectSoundUsage(image).usage.values()) {
    const sound = pool[u.poolSlot];
    if (!sound?.name) continue;
    const existing = byName.get(sound.name);
    if (existing) existing.trigCount += u.trigCount;
    else byName.set(sound.name, { sound, trigCount: u.trigCount, locked: true });
  }

  if (!lockedOnly) {
    for (let k = 0; k < 128; k++) {
      for (const sound of readKit(image, k).sounds) {
        if (!sound.name || byName.has(sound.name)) continue;
        byName.set(sound.name, { sound, trigCount: 0, locked: false });
      }
    }
  }
  return [...byName.values()];
}

function histogram(entries: Entry[]): void {
  const counts = new Map<TagName, number>();
  for (const e of entries) {
    for (const t of decodeTags(e.sound.tagBits)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    console.log("  no tags set on any sound");
    return;
  }

  const width = Math.max(...sorted.map(([, n]) => n));
  for (const [tag, n] of sorted) {
    const bar = "#".repeat(Math.max(1, Math.round((n / width) * 28)));
    console.log(`  ${tag.padEnd(11)} ${String(n).padStart(4)}  ${bar}`);
  }

  const character = { percussive: 0, melodic: 0, mixed: 0, untagged: 0 };
  for (const e of entries) character[soundCharacter(e.sound.tagBits)]++;
  console.log(
    `\n  character: ${character.percussive} percussive, ${character.melodic} melodic, ` +
      `${character.mixed} mixed, ${character.untagged} untagged`,
  );
  if (character.mixed > 0) {
    console.log(
      `  ${character.mixed} sound(s) carry both percussive and melodic tags — a placement ` +
        `rule needs a tie-break, and any of them may be a deliberate creative choice.`,
    );
  }
}

function perSound(entries: Entry[]): void {
  const sorted = [...entries].sort((a, b) => b.trigCount - a.trigCount);
  for (const e of sorted) {
    const tags = decodeTags(e.sound.tagBits);
    console.log(
      `  ${e.sound.name.padEnd(18)} ${e.locked ? String(e.trigCount).padStart(4) + " trigs" : "  home  "}  ` +
        `${soundCharacter(e.sound.tagBits).padEnd(11)} [${tags.join(" ")}]`,
    );
  }
}

function projectsIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".dnprj"))
    .map((f) => join(dir, f));
}

function main(): void {
  const argv = process.argv.slice(2);
  const showSounds = argv.includes("--sounds");
  const lockedOnly = argv.includes("--locked");
  const library = argv.includes("--library");
  const paths = argv.filter((a) => !a.startsWith("--"));

  if (paths.length === 0) {
    console.error(
      "usage: npm run tags -- [--sounds] [--locked] <project.dnprj>\n" +
        "       npm run tags -- --library <dir>",
    );
    process.exit(1);
  }

  if (library) {
    const files = paths.flatMap((p) => (statSync(p).isDirectory() ? projectsIn(p) : [p]));
    const all: Entry[] = [];
    const seen = new Set<string>();
    for (const f of files) {
      for (const e of usedSounds(load(f), lockedOnly)) {
        if (seen.has(e.sound.name)) continue;
        seen.add(e.sound.name);
        all.push(e);
      }
    }
    console.log(`\n${files.length} projects, ${all.length} distinct sounds${lockedOnly ? " used as sound locks" : ""}\n`);
    histogram(all);
    if (showSounds) {
      console.log();
      perSound(all);
    }
    return;
  }

  for (const path of paths) {
    const image = load(path);
    const entries = usedSounds(image, lockedOnly);
    console.log(
      `\n${basename(path)} "${readProjectName(image)}" — ${entries.length} distinct sound(s)` +
        `${lockedOnly ? " used as sound locks" : ""}\n`,
    );
    histogram(entries);
    if (showSounds) {
      console.log();
      perSound(entries);
    }
  }

  const unseen = TAG_NAMES.filter(
    (t) => !paths.some((p) => usedSounds(load(p), lockedOnly).some((e) => decodeTags(e.sound.tagBits).includes(t))),
  );
  if (paths.length === 1 && unseen.length) {
    console.log(`\n  tags not present here: ${unseen.join(" ")}`);
  }
}

main();
