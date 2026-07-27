/**
 * Resolving a URL path to a file inside one directory, and refusing anything outside it.
 *
 * Extracted from `serve.ts` because it was wrong on Windows for months and nothing could
 * catch it. The root came from `new URL(...).pathname`, which yields forward slashes
 * (`C:/…/web/`), while `path.join` yields the platform separator (`C:\…\web\index.html`).
 * The containment check was `target.startsWith(root)`, so on Windows it was **always false**
 * and every request 404ed — including `/`, with the file sitting right there.
 *
 * Two lessons kept here rather than in a commit message:
 *
 * - **Never mix URL paths and filesystem paths.** `fileURLToPath` exists for this and also
 *   handles percent-decoding, which the hand-rolled drive-letter regex did not — so a
 *   checkout in a folder with a space in its name would have failed too, differently.
 * - **A containment check must compare on a separator boundary.** `startsWith(root)` alone
 *   would accept `/web-secrets` for a root of `/web`.
 */

import { sep } from "node:path";
import { join, normalize, resolve } from "node:path";

export interface Resolution {
  /** Absolute filesystem path, when the request stays inside the root. */
  path?: string;
  /** Why it was refused, when it was. */
  refused?: "escapes-root";
}

/**
 * Map a URL path onto a file beneath `root`.
 *
 * `root` must already be a filesystem path — see `fileURLToPath` at the call site. The
 * returned path is not checked for existence; that is the caller's job, because "outside the
 * root" and "not there" deserve different answers.
 */
export function resolveStaticPath(root: string, urlPath: string): Resolution {
  const base = resolve(root);
  const requested = urlPath === "/" || urlPath === "" ? "index.html" : urlPath;

  // join() normalises, so any ".." collapses before the containment check sees it.
  const target = join(base, normalize(requested));

  if (target !== base && !target.startsWith(base.endsWith(sep) ? base : base + sep)) {
    return { refused: "escapes-root" };
  }
  return { path: target };
}

/**
 * The `.html` a bare path probably meant.
 *
 * `/manager` is what anyone types, and a literal static server answers 404 because there is no
 * file by that name. Returns the candidate to try *after* the literal path misses, so an
 * extensionless file that genuinely exists still wins.
 *
 * Only for paths with no extension at all: `/style.css` missing is a real 404 and must not
 * quietly become `/style.css.html`.
 */
export function htmlFallback(path: string): string | undefined {
  const last = path.slice(path.lastIndexOf(sep) + 1);
  if (last === "" || last.includes(".")) return undefined;
  return `${path}.html`;
}
