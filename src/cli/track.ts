/**
 * Move tracks *inside* one pattern. Dry run by default.
 *
 *   npm run track -- --project <a.dn2prj> --pattern A1
 *   npm run track -- --project <a.dn2prj> --pattern A1 --swap T1 T5
 *   npm run track -- --project <a.dn2prj> --pattern A1 --move T1 T2 --to T9
 *   npm run track -- --project <a.dn2prj> --pattern A1 --copy T3 --to T11 --scope preset
 *   npm run track -- --project <a.dn2prj> --pattern A1 --clear T4 --apply --out <new.dn2prj>
 *
 * Deliberately the same flags as `rearrange`, one level down. Someone who has moved patterns
 * already knows this command; the only additions are `--pattern`, which says where to work,
 * and `--scope`.
 *
 * ## --scope, which comes from the device
 *
 * The DN2 has no whole-track operation. It has **TRACK SEQUENCE** copy/paste/clear
 * (`[FUNC]` + `[REC]`/`[STOP]`/`[PLAY]`) and **PRESET** copy/paste/clear (`[TRK]` + the same),
 * and they are separate commands on separate keys. So:
 *
 *   --scope sequence   the trigs, conditions, lengths and parameter locks
 *   --scope preset     the sound: machine, filter, envelopes, MIDI record
 *   --scope both       (default) our composite, which the hardware does not offer
 *
 * `both` also carries the track LEVEL, which the other two do not — the manual puts LEVEL in
 * the kit but not in the preset, so the device's own PRESET paste leaves it behind and so does
 * ours. See `docs/ROADMAP.md` §3c-i.
 *
 * Without `--apply` nothing is written. With `--apply`, `--out` is required: this tool never
 * overwrites its input, because for most people the +Drive is the only copy of that work.
 */

import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { buildProjectFile } from "../project/projectfile.js";
import { patternIndex, patternName } from "../sheet/naming.js";
import { OpenError, openProject } from "../librarian/open.js";
import { type Shuffle, clear, copyMany, moveMany, sourceOf, swap } from "../librarian/shuffle.js";
import {
  type TrackSummary,
  summariseTracks,
  trackIndex,
  trackName,
} from "../librarian/tracksummary.js";
import {
  DN2_TRACK_COUNT,
  type TrackScope,
  applyTrackMove,
  planTrackMove,
  verifyTrackMove,
} from "../librarian/trackmove.js";

const SCOPES: readonly TrackScope[] = ["both", "sequence", "preset"];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function resolveTrack(token: string): number {
  const index = trackIndex(token);
  if (index === undefined) {
    fail(`Not a track: "${token}". Use T1..T${DN2_TRACK_COUNT}, or 1..${DN2_TRACK_COUNT}.`);
  }
  return index;
}

/** What each track holds, so a move can be aimed without opening the device. */
function printTracks(image: Uint8Array, pattern: number): void {
  console.log(`\n  ${patternName(pattern)}\n`);
  console.log("      preset             machine     trigs  locks  level");
  for (const t of summariseTracks(image, pattern)) {
    const machine = t.midi ? "MIDI" : (t.machine ?? "?");
    console.log(
      `  ${t.label.padEnd(4)}` +
        `${(t.presetName || "—").padEnd(19)}` +
        `${machine.padEnd(12)}` +
        `${String(t.trigCount).padStart(5)}` +
        `${String(t.lockCount).padStart(7)}` +
        `${String(t.level).padStart(7)}` +
        (t.empty ? "   (empty)" : ""),
    );
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const projectPath = arg("project");
  const patternArg = arg("pattern");
  const apply = argv.includes("--apply");
  const confirm = argv.includes("--confirm");
  const outPath = arg("out");

  if (!projectPath) {
    fail(
      "usage: npm run track -- --project <file> --pattern A1 [--swap T1 T5]\n" +
        "       [--scope sequence|preset|both] [--apply --out <file>]",
    );
  }
  if (apply && !outPath) fail("--apply requires --out. This tool never overwrites its input.");

  const scope = (arg("scope") ?? "both") as TrackScope;
  if (!SCOPES.includes(scope)) {
    fail(`Not a scope: "${scope}". Use ${SCOPES.join(", ")}.`);
  }

  let project;
  try {
    project = openProject(projectPath, {
      asDn2: argv.includes("--as-dn2"),
      expand: argv.includes("--expand"),
      compact: argv.includes("--compact"),
      aggregateByName: argv.includes("--aggregate"),
      ...(arg("template") === undefined ? {} : { template: arg("template")! }),
    });
  } catch (e) {
    if (e instanceof OpenError) fail(`\n${e.message}\n`);
    throw e;
  }
  const device = project.device;

  if (device.kind !== "dn2") {
    fail(
      `\nTrack operations are Digitone II only. ${basename(projectPath)} is a ${device.name}` +
        `\nproject, whose tracks are laid out differently and split into synth and MIDI.` +
        `\nOpen it as a Digitone II project with --as-dn2 if that is what you meant.\n`,
    );
  }

  if (patternArg === undefined) {
    fail("--pattern is required. Which pattern's tracks? e.g. --pattern A1");
  }
  const pattern = patternIndex(patternArg.toUpperCase()) ?? Number(patternArg);
  if (!Number.isInteger(pattern) || pattern < 0 || pattern >= device.patternCount) {
    fail(`Not a pattern slot: "${patternArg}". Use A1..H16, or 0..${device.patternCount - 1}.`);
  }

  for (const w of project.provenance.warnings.slice(0, 5)) console.log(`  warning: ${w}`);

  const swapAt = argv.indexOf("--swap");
  const moveAt = argv.indexOf("--move");
  const copyAt = argv.indexOf("--copy");
  const clearAt = argv.indexOf("--clear");

  if (swapAt === -1 && moveAt === -1 && copyAt === -1 && clearAt === -1) {
    printTracks(project.image, pattern);
    console.log(
      "\n  --swap <a> <b>       exchange two tracks" +
        "\n  --move <a>... --to <b>   move, leaving the source(s) empty" +
        "\n  --copy <a>... --to <b>   copy, leaving the source(s) as they were" +
        "\n  --clear <a>...       empty a track" +
        "\n" +
        "\n  --scope sequence     trigs, conditions, lengths and parameter locks" +
        "\n  --scope preset       the sound: machine, filter, envelopes, MIDI record" +
        "\n  --scope both         (default) both halves, and the track level",
    );
    return;
  }

  /** Every token after a flag, up to the next flag. */
  const tokensAfter = (at: number): string[] => {
    const out: string[] = [];
    for (let i = at + 1; i < argv.length && !argv[i]!.startsWith("--"); i++) out.push(argv[i]!);
    return out;
  };

  /** `--move T1 T2 --to T9`, or the two-token form `--move T1 T9`. Same rule as `rearrange`. */
  const batch = (at: number, verb: string): { froms: number[]; to: number } => {
    const toArg = arg("to");
    const tokens = tokensAfter(at);
    if (toArg === undefined) {
      if (tokens.length === 2) {
        return { froms: [resolveTrack(tokens[0]!)], to: resolveTrack(tokens[1]!) };
      }
      fail(`--${verb} with more than one source needs --to <track>`);
    }
    if (tokens.length === 0) fail(`--${verb} needs at least one source track`);
    return { froms: tokens.map(resolveTrack), to: resolveTrack(toArg) };
  };

  let shuffle;
  let headline: string;
  if (swapAt !== -1) {
    const tokens = tokensAfter(swapAt);
    if (tokens.length !== 2) fail("--swap takes exactly two tracks");
    const [a, b] = [resolveTrack(tokens[0]!), resolveTrack(tokens[1]!)];
    shuffle = swap(a, b);
    headline = `swap ${trackName(a)} <-> ${trackName(b)}`;
  } else if (moveAt !== -1) {
    const { froms, to } = batch(moveAt, "move");
    shuffle = moveMany(froms, to);
    headline = `move ${froms.map(trackName).join(", ")} -> from ${trackName(to)}, leaving the source(s) empty`;
  } else if (copyAt !== -1) {
    const { froms, to } = batch(copyAt, "copy");
    shuffle = copyMany(froms, to);
    headline = `copy ${froms.map(trackName).join(", ")} -> from ${trackName(to)}, leaving the source(s) in place`;
  } else {
    const tracks = tokensAfter(clearAt).map(resolveTrack);
    if (tracks.length === 0) fail("--clear needs at least one track");
    shuffle = clear(...tracks);
    headline = `clear ${tracks.map(trackName).join(", ")}`;
  }

  const plan = planTrackMove(project.image, device, pattern, shuffle, scope);
  const before = summariseTracks(project.image, pattern);

  console.log(
    `\n${basename(projectPath)}  ${device.name}  "${device.projectName(project.image)}"  ` +
      `${patternName(pattern)}`,
  );
  console.log(`\n  ${headline}`);
  console.log(`  scope: ${scope}${scope === "both" ? " (sequence, preset and level)" : ""}`);

  for (const track of plan.changed) {
    console.log(
      `    ${trackName(track)}`.padEnd(8) +
        `${describe(before[track]!).padEnd(34)} -> ${describe(projected(before, shuffle, track, scope))}`,
    );
  }

  if (plan.destructive.length > 0) {
    const total = plan.destructive.reduce((n, d) => n + d.trigCount, 0);
    console.log(`\n  DESTRUCTIVE — ${plan.destructive.length} track(s), ${total} trigs:`);
    for (const d of plan.destructive) {
      console.log(`    ${trackName(d.track)} "${before[d.track]!.presetName}" (${d.trigCount} trigs)`);
    }
  }

  for (const finding of plan.findings) {
    console.log(`\n  ${finding.severity === "blocker" ? "BLOCKED" : "WARNING"}: ${finding.message}`);
  }

  if (!plan.ok) {
    console.log("\n  Nothing written.");
    process.exit(1);
  }

  if (!apply) {
    console.log("\n  dry run — nothing written. Add --apply --out <file> to commit.");
    return;
  }

  if (plan.destructive.length > 0 && !confirm) {
    fail(
      "\n  Refusing to destroy the tracks listed above without --confirm." +
        "\n  Re-run with --confirm once you have read them.",
    );
  }

  const { image } = applyTrackMove(project.image, device, pattern, shuffle, {
    confirmOverwrite: confirm,
    scope,
  });
  const verification = verifyTrackMove(project.image, image, pattern, shuffle, scope);
  if (!verification.ok) {
    console.error(`\n  VERIFICATION FAILED, nothing written:`);
    for (const problem of verification.problems) console.error(`    - ${problem}`);
    process.exit(1);
  }

  writeFileSync(outPath!, buildProjectFile(project.manifest, project.payload.raw, image));
  console.log(`\n  verified and written: ${outPath}`);
  printTracks(image, pattern);
}

/** What a track holds, for the before and after columns. */
interface TrackLine {
  presetName: string;
  machine: string | undefined;
  midi: boolean;
  trigCount: number;
  /**
   * True when the preset half comes from the captured blank rather than from a source track.
   *
   * Worth a distinct marker: `?` already means "a machine value no capture has ever seen", so
   * reusing it for a deliberately emptied track would report a mystery where there is none.
   */
  blankPreset?: boolean;
}

function describe(t: TrackLine): string {
  const machine = t.blankPreset ? "blank" : t.midi ? "MIDI" : (t.machine ?? "?");
  const name = t.blankPreset ? "—" : t.presetName || "—";
  return `${name} (${machine}, ${t.trigCount} trigs)`;
}

/**
 * What a track will hold afterwards, taking the scope into account.
 *
 * Printing the source's whole summary was wrong and *looked* right: under `--scope sequence`
 * the preset does not move, so a preview claiming the destination now runs the source's sound
 * would describe an operation the tool does not perform. The halves are previewed separately
 * for the same reason they are moved separately.
 */
function projected(
  before: TrackSummary[],
  shuffle: Shuffle,
  track: number,
  scope: TrackScope,
): TrackLine {
  const source = sourceOf(shuffle, track);
  // A cleared track keeps neither half; the captured blank supplies whichever halves this
  // scope touches.
  const from = source === undefined ? undefined : before[source]!;
  const sequence = scope === "preset" ? before[track]! : (from ?? { trigCount: 0 });
  const keepsOwnPreset = scope === "sequence";
  const preset = keepsOwnPreset ? before[track]! : from;

  return {
    presetName: preset?.presetName ?? "",
    machine: preset?.machine,
    midi: preset?.midi ?? false,
    trigCount: sequence.trigCount,
    ...(preset === undefined ? { blankPreset: true } : {}),
  };
}

main();
