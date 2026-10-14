/**
 * Reporting progress for work that knows nothing about the progress module.
 *
 *     npm run job -- --name "tests" -- npm test
 *     npm run job -- --name "web build" --total 3 -- npm run build:web
 *
 * Runs the command, passes its output straight through, keeps the last line as the job's detail
 * and its exit code as the job's state. **The exit code is this process's exit code**, so putting
 * it in front of a command in a script changes what is reported and nothing else.
 *
 * For work with no process to wrap, such as a run inside somebody else's server or a step a
 * person is doing by hand:
 *
 *     npm run job -- begin --name "flash and listen" [--total 4]   # prints the job id
 *     npm run job -- step <id> [--done 2] [--step TEXT]
 *     npm run job -- end <id> [--failed] [--detail TEXT]
 *
 * Those carry pid 0, because nothing can be asked whether they are still going; the pane shows
 * one as lost after an hour of silence rather than running forever.
 *
 * ## Why a wrapper exists at all
 *
 * The useful jobs in this repository are `npm test`, which is minutes once the emulator is
 * configured, and the builds. Neither is going to import a progress module, and editing them to
 * do so would mean the thing being measured and the measurement share a failure. Wrapping is the
 * form that leaves both alone.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Job } from "../node/progress/job.js";
import { type JobRecord, progressDir, writeRecord, now } from "../node/progress/record.js";

/** `12/345` anywhere in a line, which is how most runners report where they are. */
const COUNT = /\b(\d+)\s*\/\s*(\d+)\b/;

function flag(name: string, argv: readonly string[]): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

/** Read one job's file so a later command can change it. */
function load(id: string): JobRecord | undefined {
  try {
    return JSON.parse(readFileSync(join(progressDir(), `${id}.json`), "utf8")) as JobRecord;
  } catch {
    return undefined;
  }
}

function runCommand(name: string, total: number | undefined, argv: string[]): void {
  const job = Job.start(name, {
    ...(total === undefined ? {} : { total }),
    step: argv.join(" ").slice(0, 80),
  });

  /*
   * **One string through the shell, not a command and an args array.**
   *
   * The shell is needed at all because on Windows `npm` is `npm.cmd` and spawning the bare name
   * fails with "the system cannot find the file specified". Node deprecated passing `args`
   * alongside `shell: true`, because it concatenates them without escaping, so the honest form is
   * to do the joining here and quote what needs it.
   *
   * What is being run is whatever the developer typed after `--` in their own terminal. It is not
   * input from a page, a file or a device, so this is not a place where a command can arrive from
   * somewhere it should not; it still quotes, because an unquoted path with a space in it is a
   * bug rather than a risk.
   */
  const command = argv
    .map((part) => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part))
    .join(" ");
  const child = spawn(command, { stdio: ["inherit", "pipe", "pipe"], shell: true });

  let carry = "";
  const consume = (chunk: Buffer, out: NodeJS.WriteStream): void => {
    const text = chunk.toString();
    out.write(text);
    carry += text;
    const lines = carry.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const counted = total === undefined ? COUNT.exec(trimmed) : null;
      if (counted && Number(counted[2]) > 0) {
        job.update({
          done: Number(counted[1]),
          total: Number(counted[2]),
          detail: trimmed.slice(0, 200),
        });
      } else {
        job.update({ detail: trimmed.slice(0, 200) });
      }
    }
  };

  child.stdout.on("data", (chunk: Buffer) => { consume(chunk, process.stdout); });
  child.stderr.on("data", (chunk: Buffer) => { consume(chunk, process.stderr); });

  child.on("close", (code) => {
    job.end({
      ...(code === 0 ? {} : { failed: true }),
      detail: `exit ${code}`,
    });
    process.exit(code ?? 1);
  });
  child.on("error", (error) => {
    job.end({ failed: true, detail: String(error).slice(0, 200) });
    process.exit(1);
  });
}

function main(): void {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf("--");
  const head = separator < 0 ? argv : argv.slice(0, separator);
  const rest = separator < 0 ? [] : argv.slice(separator + 1);
  const name = flag("--name", head) ?? "job";
  const totalText = flag("--total", head);
  const total = totalText === undefined ? undefined : Number(totalText);

  const verb = head[0];

  if (verb === "begin") {
    // pid 0: nothing can be asked whether this is still going.
    const job = Job.start(name, total === undefined ? {} : { total });
    const record = load(job.id);
    if (record) writeRecord({ ...record, pid: 0 });
    process.stdout.write(`${job.id}\n`);
    return;
  }

  if (verb === "step" || verb === "end") {
    const id = head[1];
    if (!id) {
      process.stderr.write(`${verb} needs a job id, as printed by begin\n`);
      process.exit(2);
    }
    const record = load(id);
    if (!record) {
      process.stderr.write(`no job ${id} in ${progressDir()}\n`);
      process.exit(2);
    }
    const doneText = flag("--done", head);
    const stepText = flag("--step", head);
    const detailText = flag("--detail", head);
    writeRecord({
      ...record,
      updated: now(),
      ...(doneText === undefined ? {} : { done: Number(doneText) }),
      ...(stepText === undefined ? {} : { step: stepText }),
      ...(detailText === undefined ? {} : { detail: detailText }),
      ...(verb === "end"
        ? { state: head.includes("--failed") ? ("failed" as const) : ("done" as const), ended: now() }
        : {}),
    });
    return;
  }

  if (rest.length === 0) {
    process.stderr.write(
      "nothing to run. Put the command after --, as in: npm run job -- --name tests -- npm test\n",
    );
    process.exit(2);
  }
  runCommand(name, total, rest);
}

main();
