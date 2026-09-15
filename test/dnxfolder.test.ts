/**
 * The DNX folder: where saved files land, what happens when the folder cannot take one, and the two
 * agreements that rot quietly (every save goes through it, and the help describes its layout).
 *
 * The picker and Chrome's permission prompt were checked in a browser with an instrument connected.
 * What runs here is everything after the handle, against a folder made of maps.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FOLDER_LAYOUT,
  type DirectoryLike,
  type FileLike,
  type FolderHandle,
  freeName,
  saveFileWith,
  savedTone,
  whereSaved,
} from "../web/src/dnxfolder.js";
import { HELP_PAGES } from "../web/src/helppages.js";

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "src");

const notFound = (name: string): DOMException => new DOMException(`${name} is not there`, "NotFoundError");

class FakeDir implements DirectoryLike {
  readonly dirs = new Map<string, FakeDir>();
  readonly files = new Map<string, Uint8Array>();
  failWrites = false;
  constructor(readonly name: string) {}

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<FakeDir> {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!options.create) throw notFound(name);
      dir = new FakeDir(name);
      dir.failWrites = this.failWrites;
      this.dirs.set(name, dir);
    }
    return dir;
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<FileLike> {
    if (!this.files.has(name)) {
      if (!options.create) throw notFound(name);
      if (this.failWrites) throw new DOMException("The disk is full", "QuotaExceededError");
      this.files.set(name, new Uint8Array());
    }
    return {
      createWritable: async () => {
        const parts: Blob[] = [];
        return {
          write: async (data: Blob) => { parts.push(data); },
          close: async () => { this.files.set(name, new Uint8Array(await new Blob(parts).arrayBuffer())); },
        };
      },
    };
  }
}

class FakeRoot extends FakeDir implements FolderHandle {
  constructor(
    name: string,
    public permission: "granted" | "denied" | "prompt" = "granted",
    private readonly onRequest: () => "granted" | "denied" | "prompt" = () => {
      throw new DOMException("User activation is required", "SecurityError");
    },
  ) {
    super(name);
  }
  async queryPermission(): Promise<"granted" | "denied" | "prompt"> { return this.permission; }
  async requestPermission(): Promise<"granted" | "denied" | "prompt"> { return (this.permission = this.onRequest()); }
}

function environment(folder: () => Promise<FolderHandle | undefined>) {
  const downloads: string[] = [];
  return { downloads, env: { folder, download: (_blob: Blob, name: string) => { downloads.push(name); } } };
}

const bytes = (text: string): Blob => new Blob([new TextEncoder().encode(text)]);

test("each kind of file lands in its own subfolder, and a taken name is never replaced", async () => {
  const root = new FakeRoot("DNX files");
  const { downloads, env } = environment(async () => root);

  const first = await saveFileWith(bytes("one"), "SKETCHPAD.dn2prj", "exports", env);
  const second = await saveFileWith(bytes("two"), "SKETCHPAD.dn2prj", "exports", env);
  const backup = await saveFileWith(bytes("zip"), "Digitone 2026-09-15.dnx", "backups", env);

  assert.deepEqual(first, { where: "folder", folder: "DNX files", path: "Exports/SKETCHPAD.dn2prj" });
  assert.deepEqual(second, { where: "folder", folder: "DNX files", path: "Exports/SKETCHPAD (1).dn2prj" });
  assert.equal(whereSaved(backup), "DNX files/Backups/Digitone 2026-09-15.dnx");
  assert.equal(new TextDecoder().decode(root.dirs.get("Exports")!.files.get("SKETCHPAD.dn2prj")), "one");
  assert.equal(new TextDecoder().decode(root.dirs.get("Exports")!.files.get("SKETCHPAD (1).dn2prj")), "two");
  assert.deepEqual(downloads, []);
  assert.equal(savedTone(first), "ok");
});

test("with no folder chosen a file is downloaded, and that is not a warning", async () => {
  const { downloads, env } = environment(async () => undefined);
  const saved = await saveFileWith(bytes("x"), "A.dn2snd", "copies", env);
  assert.deepEqual(saved, { where: "download", name: "A.dn2snd" });
  assert.deepEqual(downloads, ["A.dn2snd"]);
  assert.equal(savedTone(saved), "ok");
});

test("a folder whose permission lapsed is downloaded instead, and says how to fix it", async () => {
  /*
   * **The case a backup meets.** Chrome can drop the permission after a restart, and asking again
   * needs a fresh click, which a save a minute after its click does not have.
   */
  const root = new FakeRoot("DNX files", "prompt");
  const { downloads, env } = environment(async () => root);
  const saved = await saveFileWith(bytes("x"), "B.dnx", "backups", env);
  assert.equal(saved.where, "download");
  assert.match(whereSaved(saved), /B\.dnx in your downloads \(DNX may not write to DNX files until you press Allow in Settings\)/);
  assert.deepEqual(downloads, ["B.dnx"]);
  assert.equal(savedTone(saved), "warn");
  assert.equal(root.dirs.size, 0, "nothing was created in a folder DNX may not write to");
});

test("a permission granted on asking is used straight away", async () => {
  const root = new FakeRoot("DNX files", "prompt", () => "granted");
  const { downloads, env } = environment(async () => root);
  const saved = await saveFileWith(bytes("x"), "C.bin", "probe", env);
  assert.deepEqual(saved, { where: "folder", folder: "DNX files", path: "Probe/C.bin" });
  assert.deepEqual(downloads, []);
});

test("a write that fails still delivers the file, as a download", async () => {
  const root = new FakeRoot("DNX files");
  root.failWrites = true;
  const { downloads, env } = environment(async () => root);
  const saved = await saveFileWith(bytes("x"), "D.dn2prj", "copies", env);
  assert.equal(saved.where, "download");
  assert.match(whereSaved(saved), /writing to DNX files failed: The disk is full/);
  assert.deepEqual(downloads, ["D.dn2prj"]);
});

test("storage that refuses to answer is treated as no folder", async () => {
  const { downloads, env } = environment(async () => { throw new DOMException("denied", "SecurityError"); });
  const saved = await saveFileWith(bytes("x"), "E.dnx", "backups", env);
  assert.deepEqual(saved, { where: "download", name: "E.dnx" });
  assert.deepEqual(downloads, ["E.dnx"]);
});

test("names a folder refuses are made safe, and numbering keeps the extension", async () => {
  const root = new FakeRoot("DNX files");
  const { env } = environment(async () => root);
  const saved = await saveFileWith(bytes("x"), "A/B:C.dn2prj", "exports", env);
  assert.deepEqual(saved, { where: "folder", folder: "DNX files", path: "Exports/A_B_C.dn2prj" });

  const dir = new FakeDir("plain");
  await dir.getFileHandle("README", { create: true });
  assert.equal(await freeName(dir, "README"), "README (1)");
});

test("every file a page saves goes through the DNX folder", () => {
  /*
   * **A save site that calls the download directly ignores the setting without a sound.** The
   * folder would be chosen, most files would land in it, and one kind would keep turning up in
   * Downloads with nothing to say why.
   */
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && entry.name !== "dom.ts" && entry.name !== "dnxfolder.ts") {
        const source = readFileSync(path, "utf8");
        for (const match of source.matchAll(/^.*\b(?:saveBlob|saveBytes|download)\(.*$/gm)) {
          offenders.push(`${entry.name}: ${match[0].trim()}`);
        }
      }
    }
  };
  walk(WEB_SRC);
  assert.deepEqual(offenders, []);
});

test("the Settings help describes the folder layout DNX actually makes", () => {
  const settings = HELP_PAGES.find((page) => page.key === "settings");
  assert.ok(settings, "the Settings help page moved");
  const text = [settings.intro, ...settings.sections.map((section) => section.body)].join("\n");
  for (const subfolder of Object.values(FOLDER_LAYOUT)) {
    assert.ok(text.includes(`${subfolder}/`), `the help does not mention ${subfolder}/`);
  }
});

test("clearing stored preferences forgets the folder", () => {
  const settings = readFileSync(join(WEB_SRC, "settings.ts"), "utf8");
  const clear = settings.slice(settings.indexOf('action("Clear"'));
  assert.match(clear.slice(0, 600), /forgetFolder\(\)/);
});
