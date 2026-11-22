/**
 * What git knows that the source does not: which files a review covers, and how often each file
 * changes.
 *
 * **Changed** is everything that differs from the base, working tree included, so a branch can be
 * reviewed before it is committed. **Churn** is the number of commits that touched a file in the
 * last `days` days. Merge commits are left out, because a merge touches every file of its branch a
 * second time.
 */

import { execFileSync } from "node:child_process";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Files that differ between `base` and the working tree, as repository paths. Renames give the new path. */
export function changedFiles(root: string, base: string): Set<string> {
  const mergeBase = git(root, ["merge-base", base, "HEAD"]).trim();
  const tracked = git(root, ["diff", "--name-only", "--no-renames", mergeBase]).split("\n");
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n");
  return new Set([...tracked, ...untracked].map((line) => line.trim()).filter(Boolean));
}

/** Commits per file in the last `days` days, merges left out. */
export function churn(root: string, days: number): Map<string, number> {
  const out = git(root, ["log", `--since=${days} days ago`, "--no-merges", "--name-only", "--format="]);
  const counts = new Map<string, number>();
  for (const line of out.split("\n")) {
    const path = line.trim();
    if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return counts;
}
