/**
 * Import one audio file and send it to the Bloom prototype's `/samples` store, **in the emulator**.
 *
 *   npm run sample-send -- <file.wav|file.aif> [--mono] [--highpass <Hz>] [--normalise] [--name <text>]
 *
 * Needs `DNX_BLOOM_FIRMWARE` (a firmware image with the `/samples` route) and the emulator bridge
 * variables, as the emulator tests do. `DNX_DN2_CARD_IMAGE` is optional.
 *
 * **Emulator only, on purpose.** Node has no MIDI here, and every write to the instrument needs the
 * owner's yes each time, which belongs in a page with a dialog. This command proves the route.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { EmulatorBridge } from "../node/emulatorbridge.js";
import { MessageIds } from "@noiseandmatter/dnx-core/device/messageids.js";
import { BloomSampleStore } from "@noiseandmatter/dnx-core/device/samplestore.js";
import { importAudioFile } from "@noiseandmatter/dnx-core/sample/importfile.js";
import { sampleKey } from "@noiseandmatter/dnx-core/sample/identity.js";

const TIMEOUT = 240_000;

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a, i) => !a.startsWith("--") && !["--highpass", "--name"].includes(args[i - 1] ?? ""));
  const firmware = process.env["DNX_BLOOM_FIRMWARE"];
  if (!file) throw new Error("usage: npm run sample-send -- <file> [--mono] [--highpass <Hz>] [--normalise] [--name <text>]");
  if (!firmware) throw new Error("set DNX_BLOOM_FIRMWARE to a firmware image with the /samples route");

  const highpass = option(args, "--highpass");
  const imported = importAudioFile(readFileSync(file), {
    ...(args.includes("--mono") ? { channels: "mono" as const } : {}),
    ...(highpass === undefined ? {} : { highpassHz: Number(highpass) }),
    ...(args.includes("--normalise") ? { normalise: true } : {}),
  });
  const name = option(args, "--name") ?? basename(file).replace(/\.[^.]+$/, "");
  const { sample, id, report } = imported;
  console.log(
    `${name}: ${sample.channels === 1 ? "mono" : "stereo"}, ${sample.frames} frames, ${id.size} bytes, ` +
      `${sampleKey(id)}${report.resampled ? `, resampled from ${report.sourceRate} Hz` : ""}`,
  );

  const card = process.env["DNX_DN2_CARD_IMAGE"];
  const bridge = await EmulatorBridge.start({ firmware, ...(card === undefined ? {} : { cardImage: card }), startupMs: TIMEOUT });
  try {
    const store = new BloomSampleStore({
      transport: bridge,
      host: { ids: new MessageIds(), gate: () => {}, confirm: async () => true },
      nameFor: () => name,
      confirmDelete: async () => false,
      onStatus: (m) => console.log(m),
      timeoutMs: TIMEOUT,
    });
    await store.put(id, sample, (sent, total) => process.stdout.write(`\r${sent}/${total} bytes`));
    const index = await store.readIndex();
    const entry = index.entries.find((e) => e.identityHash === id.hash);
    console.log(`\nstored as /samples/${entry?.n}: start sector 0x${entry?.startSector.toString(16)}, extent ${entry?.extentSectors}`);
  } finally {
    bridge.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
