// DNX's digikit samples back end against digikit's DN2 emulator.
//
// Runs DNX's code path (packages/core/src/sample/digikitstore.ts over the vendored digikit client) on the
// emulator's USB, through digikit's EmuUsbTransport. The caller owns the emulator: it passes `call`, the
// control RPC of a running runtime daemon (digikit's `@digi/control-client`). A test may pass `transport` instead.
//
// Needs `npm run build:web` first: it imports the compiled JavaScript from web/dist, so plain Node runs it.
//
//   import { run } from "/mnt/d/01_Code/Z_Personal/DNX/scripts/digikit-emu-store.mjs";
//   await run({ call: (method, params) => client.call(method, params), wavs: [{ path: "/path/to/a.wav", name: "A" }, ...] });
//
// It prints one JSON line per step and returns the summary. Steps: INFO (runtime, FOLDERS), free space,
// MKDIR samples/<folder>, each WAV converted, uploaded, verified and listed, then a small scratch file
// uploaded and deleted to prove DELETE frees its space. The three test files stay on the card.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const dist = new URL("../web/dist/packages/core/src/", import.meta.url);
const store = await import(new URL("sample/digikitstore.js", dist).href);
const { EmuUsbTransport } = await import(new URL("vendor/digikit/emu-usb-transport.js", dist).href);
const { hasCap } = await import(new URL("vendor/digikit/dkupload-core.js", dist).href);
const WASM = fileURLToPath(new URL("../web/vendor/dksample.wasm", import.meta.url));

/** A 48 kHz mono 16-bit WAV of a tenth of a second, for the delete check. */
function scratchWav() {
  const frames = 4800, data = frames * 2, b = new Uint8Array(44 + data), v = new DataView(b.buffer);
  const ascii = (s, at) => b.set([...s].map((c) => c.charCodeAt(0)), at);
  ascii("RIFF", 0); v.setUint32(4, 36 + data, true); ascii("WAVEfmt ", 8);
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 48000, true); v.setUint32(28, 96000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii("data", 36); v.setUint32(40, data, true);
  return b;
}

export async function run({ call, transport, wavs, folder = "test", log = (o) => console.log(JSON.stringify(o)) }) {
  const step = (name, fields) => log({ step: name, ...fields });
  const converter = await store.loadConverter(readFileSync(WASM));
  const dk = store.openDigikitStore(transport ?? new EmuUsbTransport(call));

  const info = await dk.session.info();
  const folders = hasCap(info, "FOLDERS");
  step("info", { runtime: info.runtime_version, port: info.port, folders, safe_mode: info.safe_mode });
  if (!folders) throw new Error("the runtime has no FOLDERS capability: MKDIR and LIST by prefix are missing");

  const before = await dk.samples.space();
  step("space", { free: before.free, total: before.total });
  await dk.samples.mkdir(folder);
  step("mkdir", { folder: `samples/${folder}`, listed: (await dk.samples.list("")).map((e) => `${e.kind}:${e.name}`) });

  const records = [];
  // An entry is a path, or { path, name } to store it under another name (no extension).
  for (const wav of wavs) {
    const { path, name } = typeof wav === "string" ? { path: wav, name: undefined } : wav;
    const file = store.prepareWav(converter, name ? `${name}.wav` : basename(path), readFileSync(path));
    const t0 = Date.now();
    let last = 0;
    const record = await store.putAndVerify(dk, folder, file, (sent, total) => {
      if (sent - last >= 1 << 20 || sent === total) { last = sent; step("progress", { name: file.name, sent, total }); }
    });
    records.push({ ...record, frames: file.info.frames, channels: file.info.channels, seconds: (Date.now() - t0) / 1000 });
    step("stored", records.at(-1));
  }

  const scratch = store.prepareWav(converter, "scratch.wav", scratchWav());
  await store.putAndVerify(dk, folder, scratch);
  const withScratch = await dk.samples.space();
  await dk.samples.remove(folder, "scratch");
  const after = await dk.samples.space();
  const gone = !(await dk.samples.list(folder)).some((e) => e.name === "scratch");
  step("delete", { gone, freed: after.free - withScratch.free });
  if (!gone || after.free <= withScratch.free) throw new Error("DELETE did not remove the file or free its space");

  const listing = await dk.session.list(`samples/${folder}/`);
  step("list", { entries: listing });
  const summary = { ok: true, records, firstSector: "not given: LIST returns path, size and sha256 only" };
  step("summary", summary);
  return summary;
}
