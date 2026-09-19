/**
 * Differential analysis of decoded SysEx payloads — the workhorse for format discovery.
 *
 * The method: capture a series of dumps from the hardware where each file differs from
 * the previous one by exactly one user action (add a trig at step N, change a note, ...).
 * Diffing consecutive files then localises the field that encodes that action.
 *
 *   npm run diff -- a.syx b.syx                  diff two files
 *   npm run diff -- --chain captures/Trigger/    diff each file against the previous
 *   npm run diff -- --base b.syx captures/       diff every file against one base
 *   npm run diff -- --stride --chain dir/        also report the offset delta between
 *                                                consecutive diffs, which reveals record size
 *   npm run diff -- --project p.dn2prj A1 A2 A3  diff patterns inside one project against the
 *                                                first named, which is how a capture built as
 *                                                several patterns of one saved project is read
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFile } from "../sysex/container.js";
import { PATTERN_PAYLOAD_SIZE, describeOffset } from "../project/locate.js";
import { parseProject } from "../node/projectfile.js";
import { decodeProjectImage } from "../project/dn2codec.js";
import { patternAsSysexPayload } from "../project/dn2image.js";
import { patternIndex, patternName } from "../project/naming.js";

interface Change {
  offset: number;
  from: number;
  to: number;
}

interface Run {
  start: number;
  from: Uint8Array;
  to: Uint8Array;
}

function decodedPayload(path: string): Uint8Array {
  const messages = parseFile(new Uint8Array(readFileSync(path)));
  if (messages.length === 0) throw new Error(`${path} contains no SysEx messages`);
  if (messages.length > 1) {
    // Concatenating keeps multi-message project dumps diffable, at the cost of
    // shifting every offset if an earlier message changes size.
    const total = messages.reduce((n, m) => n + m.payload.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const m of messages) {
      out.set(m.payload, at);
      at += m.payload.length;
    }
    return out;
  }
  return messages[0]!.payload;
}

function changes(a: Uint8Array, b: Uint8Array): Change[] {
  const result: Change[] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) result.push({ offset: i, from: a[i]!, to: b[i]! });
  }
  return result;
}

/** Collapse adjacent changed bytes into runs so multi-byte fields read as one entry. */
function toRuns(list: Change[], gapTolerance: number): Run[] {
  const runs: Run[] = [];
  let current: { start: number; from: number[]; to: number[]; last: number } | null = null;

  for (const c of list) {
    if (current && c.offset - current.last <= gapTolerance) {
      // Fill any tolerated gap with the unchanged bytes so the run stays contiguous.
      for (let g = current.last + 1; g < c.offset; g++) {
        current.from.push(-1);
        current.to.push(-1);
      }
      current.from.push(c.from);
      current.to.push(c.to);
      current.last = c.offset;
    } else {
      if (current) {
        runs.push({
          start: current.start,
          from: Uint8Array.from(current.from.map((v) => (v < 0 ? 0 : v))),
          to: Uint8Array.from(current.to.map((v) => (v < 0 ? 0 : v))),
        });
      }
      current = { start: c.offset, from: [c.from], to: [c.to], last: c.offset };
    }
  }
  if (current) {
    runs.push({
      start: current.start,
      from: Uint8Array.from(current.from.map((v) => (v < 0 ? 0 : v))),
      to: Uint8Array.from(current.to.map((v) => (v < 0 ? 0 : v))),
    });
  }
  return runs;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

function reportPair(labelA: string, labelB: string, a: Uint8Array, b: Uint8Array, gap: number): Run[] {
  const list = changes(a, b);
  const runs = toRuns(list, gap);

  const sizeNote = a.length !== b.length ? `  (decoded sizes differ: ${a.length} vs ${b.length})` : "";
  console.log(`\n${labelA}  ->  ${labelB}`);
  console.log(`  ${list.length} byte(s) changed in ${runs.length} run(s)${sizeNote}`);

  // A payload of exactly this size is a DN2 pattern dump, so every offset can be named.
  // Reading "track 3 settings +0x0d track length" instead of "0x4f8d" is the whole point of a
  // differential capture, and doing that lookup by hand is where the time goes.
  const nameable = a.length === PATTERN_PAYLOAD_SIZE;

  for (const run of runs) {
    const at = `0x${run.start.toString(16).padStart(4, "0")}`;
    const where = nameable ? `   ${describeOffset(run.start)}` : "";
    console.log(`    ${at} (${run.from.length}B)  ${hex(run.from)}  ->  ${hex(run.to)}${where}`);
  }
  return runs;
}

function syxFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".syx"))
    .sort((a, b) => {
      // Natural sort so 2_Step2 comes before 10_Step10.
      const na = Number(a.match(/^\d+/)?.[0] ?? NaN);
      const nb = Number(b.match(/^\d+/)?.[0] ?? NaN);
      if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
      return a.localeCompare(b);
    })
    .map((f) => join(dir, f));
}

function expand(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) out.push(...syxFilesIn(p));
    else out.push(p);
  }
  return out;
}

function reportStride(allRuns: Run[][]): void {
  // When each capture appends one record, the first run of each diff advances by the
  // record size. Reporting that delta directly reveals the stride.
  const starts = allRuns.map((runs) => runs.at(-1)?.start).filter((s): s is number => s !== undefined);
  if (starts.length < 2) return;

  const deltas: number[] = [];
  for (let i = 1; i < starts.length; i++) deltas.push(starts[i]! - starts[i - 1]!);
  const unique = [...new Set(deltas)];

  console.log(`\nstride of last changed run across ${starts.length} diffs:`);
  console.log(`  offsets: ${starts.map((s) => `0x${s.toString(16)}`).join(", ")}`);
  console.log(`  deltas:  ${deltas.join(", ")}`);
  if (unique.length === 1) {
    console.log(`  => constant stride of ${unique[0]} bytes: a fixed-size record array`);
  }
}

/**
 * Diff patterns inside one saved project, each against the first named.
 *
 * A capture built as several patterns of a single project is easier to make and cleaner to
 * read than a set of SysEx dumps: every pattern went through the same save, so whatever
 * saving rewrites it rewrites identically, and nothing has to be transferred over MIDI.
 */
function reportProject(path: string, names: readonly string[], gap: number): void {
  const { payload } = parseProject(new Uint8Array(readFileSync(path)));
  const { image } = decodeProjectImage(payload.raw);

  const indices = names.map((name) => {
    const index = patternIndex(name);
    if (index === undefined) {
      console.error(`"${name}" is not a pattern name — expected something like A1 or B12`);
      process.exit(1);
    }
    return index;
  });

  const [baseIndex, ...rest] = indices as [number, ...number[]];
  const base = patternAsSysexPayload(image, baseIndex);

  for (const index of rest) {
    reportPair(
      patternName(baseIndex),
      patternName(index),
      base,
      patternAsSysexPayload(image, index),
      gap,
    );
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  let mode: "pair" | "chain" | "base" | "project" = "pair";
  let basePath: string | undefined;
  let projectPath: string | undefined;
  let gap = 0;
  let showStride = false;
  const paths: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--chain") mode = "chain";
    else if (arg === "--base") {
      mode = "base";
      basePath = argv[++i];
    } else if (arg === "--project") {
      mode = "project";
      projectPath = argv[++i];
    } else if (arg === "--gap") gap = Number(argv[++i] ?? 0);
    else if (arg === "--stride") showStride = true;
    else paths.push(arg);
  }

  if (mode === "project") {
    if (!projectPath || paths.length < 2) {
      console.error("usage: npm run diff -- --project <file.dn2prj> <baseline> <pattern...>");
      process.exit(1);
    }
    reportProject(projectPath, paths, gap);
    return;
  }

  const files = expand(paths);
  if (files.length === 0 || (mode === "pair" && files.length !== 2)) {
    console.error(
      "usage:\n" +
        "  npm run diff -- <a.syx> <b.syx>\n" +
        "  npm run diff -- --chain [--stride] <dir|files...>\n" +
        "  npm run diff -- --base <base.syx> <dir|files...>\n" +
        "  options: --gap N (merge runs separated by up to N unchanged bytes)",
    );
    process.exit(1);
  }

  const allRuns: Run[][] = [];

  if (mode === "pair") {
    reportPair(
      basename(files[0]!),
      basename(files[1]!),
      decodedPayload(files[0]!),
      decodedPayload(files[1]!),
      gap,
    );
  } else if (mode === "chain") {
    let prev = decodedPayload(files[0]!);
    for (let i = 1; i < files.length; i++) {
      const next = decodedPayload(files[i]!);
      allRuns.push(reportPair(basename(files[i - 1]!), basename(files[i]!), prev, next, gap));
      prev = next;
    }
  } else {
    const base = decodedPayload(basePath!);
    for (const file of files) {
      allRuns.push(reportPair(basename(basePath!), basename(file), base, decodedPayload(file), gap));
    }
  }

  if (showStride) reportStride(allRuns);
}

main();
