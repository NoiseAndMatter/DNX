/**
 * The settings sheet, and the two things about it that rot quietly.
 *
 * The sheet's behaviour was checked in a browser: it opens from the tool row, closes on Escape and
 * on the scrim, and returns focus to the link that opened it. What is checked here is the pair of
 * agreements it has with code it cannot see, both of which break without any test failing.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SOURCE_URL } from "../web/src/settings.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "web");

test("the motion control offers exactly what arrival.js honours", () => {
  /*
   * **Two files have to agree and neither imports the other.** `arrival.js` is a classic script so
   * it can run before paint, which means it cannot `import` and the key and its values are written
   * out twice. A control offering a fourth value would store something `arrival.js` treats as
   * unset, and the setting would appear to do nothing at all.
   */
  const arrival = readFileSync(join(WEB, "arrival.js"), "utf8");
  const settings = readFileSync(join(WEB, "src", "settings.ts"), "utf8");

  const key = /MOTION_KEY\s*=\s*"([^"]+)"/.exec(arrival)?.[1];
  assert.equal(key, "dnx-motion", "arrival.js changed the key it reads");
  assert.match(settings, new RegExp(`MOTION_KEY\\s*=\\s*"${key}"`),
    "the sheet writes a different key from the one arrival.js reads");

  const offered = /const MOTIONS: readonly Motion\[\] = \[([^\]]+)\]/.exec(settings)?.[1] ?? "";
  const values = [...offered.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);
  assert.deepEqual(values.sort(), ["always", "never", "system"]);
  for (const value of values) {
    assert.ok(arrival.includes(`"${value}"`), `arrival.js does not handle "${value}"`);
  }
});

test("clearing preferences covers every key this application stores", () => {
  /*
   * **A "clear everything" that misses a key is worse than no button at all**: somebody clears,
   * believes they are back to defaults, and carries a setting they cannot see into the next
   * session. Adding a preference is exactly when nobody thinks about this list.
   *
   * The scan reads storage calls out of the source rather than trusting a list to be maintained.
   * It deliberately does not scan `dist/`, which is this same source compiled.
   */
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "dist" || entry.name === "mockups") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) files.push(path);
    }
  };
  walk(WEB);

  const used = new Set<string>();
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    // Both the literal form and the `KEY = "..."` constants the storage calls are given.
    for (const m of src.matchAll(/(?:local|session)Storage\.(?:get|set|remove)Item\(\s*"([^"]+)"/g)) {
      used.add(m[1]!);
    }
    for (const m of src.matchAll(/^\s*(?:var|const)\s+\w*KEY\w*\s*=\s*"(dnx[.\-][^"]*)"/gm)) {
      used.add(m[1]!);
    }
  }
  assert.ok(used.size >= 3, `only ${used.size} storage keys found; the scan stopped matching`);

  const settings = readFileSync(join(WEB, "src", "settings.ts"), "utf8");
  const stored = /const STORED = \{([\s\S]*?)\n\};/.exec(settings)?.[1] ?? "";
  assert.ok(stored, "STORED is where the clear list lives; it was not found");
  /*
   * STORED names one key through a constant, because `arrival.js` owns it and the two files have
   * to agree. Reading only the string literals would report that key as uncleared, which is a test
   * failing on how the list is spelled rather than on what it covers.
   */
  const constants = new Map(
    [...settings.matchAll(/^const (\w+) = "([^"]+)";/gm)].map((m) => [m[1]!, m[2]!]),
  );
  const listed = [
    ...[...stored.matchAll(/"([^"]+)"/g)].map((m) => m[1]!),
    ...[...stored.matchAll(/[A-Z][A-Z0-9_]+/g)]
      .map((m) => constants.get(m[0]))
      .filter((v): v is string => v !== undefined),
  ];
  const prefixes = listed.filter((k) => k.endsWith("-") || k.endsWith("."));

  const missed = [...used].filter(
    (key) => !listed.includes(key) && !prefixes.some((p) => key.startsWith(p)),
  );
  assert.deepEqual(missed.sort(), [],
    "these keys are written but never cleared, so Clear leaves them behind");
});

test("every page can reach the settings sheet, and the licence link with it", () => {
  // Both are rendered into the tool row, which every page mounts, so no page can be missing one.
  const toolnav = readFileSync(join(WEB, "src", "toolnav.ts"), "utf8");
  assert.match(toolnav, /renderSettingsLink\(nav\)/);
  assert.match(toolnav, /nav\.append\(sourceLink\(\)\)/);

  // The tool row needs the sheet; the sheet must not need the tool row. A cycle here compiles and
  // then fails at run time depending on which module the bundler happens to evaluate first.
  const settings = readFileSync(join(WEB, "src", "settings.ts"), "utf8");
  assert.doesNotMatch(settings, /from "\.\/toolnav\.js"/,
    "settings.ts must not import the tool row that imports it");

  assert.match(SOURCE_URL, /^https:\/\/github\.com\/\S+$/);
});

test("the source link points at the repository this package declares", () => {
  /*
   * **AGPL-3.0 section 13 is the reason this link exists**, and a link is only an offer of source
   * while it resolves to the source. Moving the repository broke it silently: the old URL stayed in
   * `settings.ts` and every page went on offering an archived, private repository. The shape check
   * above passed throughout, because the shape was never what was wrong.
   *
   * `package.json` is the other place the repository is written down, and it is the one a move
   * updates first. Tying them together means the second half cannot be forgotten.
   */
  const manifest = JSON.parse(readFileSync(join(WEB, "..", "package.json"), "utf8")) as {
    repository?: { url?: string };
  };
  const declared = manifest.repository?.url;
  assert.ok(declared, "package.json must declare the repository");

  // `git+https://github.com/owner/name.git` and `https://github.com/owner/name` are the same place
  // written two ways. Compare what identifies it.
  const place = (url: string): string =>
    url.replace(/^git\+/, "").replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();

  assert.equal(place(SOURCE_URL), place(declared),
    "the source offered in the interface is not the repository this package declares");
});

test("the sheet says what a musician can act on, and nothing about why it was built", () => {
  /*
   * The mockup carried lines like "Asked for on Elektronauts" and "the reason a person can afford
   * to say yes to everything else here". Those are the case for building a setting, addressed to
   * whoever was deciding. A person changing a preference cannot act on either.
   *
   * The rationale belongs in the module comment, which is why this only checks the strings the
   * sheet renders.
   */
  const settings = readFileSync(join(WEB, "src", "settings.ts"), "utf8");
  const body = settings.slice(settings.indexOf("function build()"));
  const banned = ["Elektronauts", "asked for", "we added", "the reason a person", "developers"];
  const found = banned.filter((phrase) => new RegExp(phrase, "i").test(body));
  assert.deepEqual(found, [], "this reads as a note to the author rather than help for the reader");
});
