/**
 * The live progress pane: every running job, redrawn each second.
 *
 *     npm run jobs -- [--keep 10] [--interval 1] [--once]
 *
 * Meant for a terminal split beside Claude Code, as the firmware repositories' panes are:
 *
 *     wt -w 0 split-pane -V --size 0.35 -d D:\01_Code\Z_Personal\DNX npm run jobs
 *
 * Reads `out/progress/` (`src/node/progress/`). Each job gets a bar and its percentage when it knows
 * its total, the time it has run, its current step and its last detail line; a job that another
 * job started sits under it. Finished jobs stay for `--keep` minutes, marked done, failed, or
 * **lost** when the process went away while the file still said running.
 *
 * Keys: `c` collapses to one line a job, `f` shows or hides finished jobs, `p` prunes finished
 * jobs older than a day, `q` quits.
 *
 * **One job: the terminal.** What a frame says is `src/node/progress/render.ts`, which is a pure
 * function with a test. This is the loop, the keys and the escape sequences, which are the parts
 * no test is going to cover, so there is as little of them as possible.
 */

import { readJobs, prune } from "../node/progress/read.js";
import { render, type RenderOptions } from "../node/progress/render.js";
import { now } from "../node/progress/record.js";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const HOME_AND_CLEAR = "\x1b[H\x1b[2J";

function numberFlag(name: string, fallback: number): number {
  const at = process.argv.indexOf(name);
  if (at < 0) return fallback;
  const value = Number(process.argv[at + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function frame(compact: boolean, showFinished: boolean, keepMinutes: number): string {
  const options: RenderOptions = {
    compact,
    showFinished,
    keepMinutes,
    columns: process.stdout.columns ?? 100,
    at: now(),
    time: new Date().toTimeString().slice(0, 8),
  };
  return render(readJobs(), options).join("\n");
}

function main(): void {
  const keep = numberFlag("--keep", 10);
  const interval = numberFlag("--interval", 1);
  let compact = false;
  let showFinished = true;

  if (process.argv.includes("--once")) {
    process.stdout.write(`${frame(compact, showFinished, keep)}\n`);
    return;
  }

  const draw = (): void => {
    process.stdout.write(HOME_AND_CLEAR + frame(compact, showFinished, keep) + "\n");
  };

  /*
   * Raw mode so a key acts at once rather than at the next newline, and only when stdin is a
   * terminal: piped into a file or another process there is no keyboard, and asking for raw mode
   * there throws. The pane is still useful in that state, which is what `--once` is for.
   */
  const interactive = process.stdin.isTTY === true;
  if (interactive) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key: string) => {
      // Ctrl-C does not arrive as SIGINT in raw mode; it is this byte and nothing else sees it.
      if (key === "q" || key === "\u0003") stop();
      else if (key === "c") { compact = !compact; draw(); }
      else if (key === "f") { showFinished = !showFinished; draw(); }
      else if (key === "p") { prune(); draw(); }
    });
  }

  const timer = setInterval(draw, Math.max(100, interval * 1000));

  function stop(): void {
    clearInterval(timer);
    if (interactive) process.stdin.setRawMode(false);
    process.stdout.write(SHOW_CURSOR);
    process.exit(0);
  }

  process.on("SIGINT", stop);
  process.stdout.write(HIDE_CURSOR);
  draw();
}

main();
