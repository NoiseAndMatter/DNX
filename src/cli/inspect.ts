/**
 * Inspect a .syx file: message inventory, header fields, checksum/length validation.
 *
 *   npm run inspect -- <file.syx> [...]
 *   npm run inspect -- --verbose <file.syx>      list every message, not a summary
 *   npm run inspect -- --hex 64 <file.syx>       show N decoded bytes per message
 */

import { readFileSync } from "node:fs";
import {
  isChecksumValid,
  isLengthValid,
  parseFile,
  rebuildMessage,
  type SysExMessage,
} from "@noiseandmatter/dnx-core/sysex/container.js";
import { describeDumpType, describeProduct, isConfirmedCombination } from "@noiseandmatter/dnx-core/sysex/devices.js";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function describeMessage(msg: SysExMessage): string {
  const flags: string[] = [];
  if (!isChecksumValid(msg)) {
    flags.push(`BAD CHECKSUM (stored ${msg.storedChecksum}, computed ${msg.computedChecksum})`);
  }
  if (!isLengthValid(msg)) {
    flags.push(`BAD LENGTH (stored ${msg.storedLength}, computed ${msg.computedLength})`);
  }
  return (
    `  [${String(msg.index).padStart(3)}] ${describeProduct(msg.productId)} ` +
    `${describeDumpType(msg.dumpType)} obj=${msg.objNr} ` +
    `wire=${msg.byteLength} decoded=${msg.payload.length}` +
    (flags.length ? `  ${flags.join("; ")}` : "")
  );
}

function inspect(path: string, opts: { verbose: boolean; hexBytes: number }): void {
  const data = new Uint8Array(readFileSync(path));
  const messages = parseFile(data);

  console.log(`\n${path}`);
  console.log(`  ${data.length} bytes, ${messages.length} message(s)`);

  if (messages.length === 0) return;

  // Group identical message shapes so a 256-sound bank prints as one line.
  const shapes = new Map<string, { count: number; sample: SysExMessage }>();
  for (const msg of messages) {
    const key = `${msg.productId}:${msg.dumpType}:${msg.version.join(".")}:${msg.byteLength}`;
    const existing = shapes.get(key);
    if (existing) existing.count++;
    else shapes.set(key, { count: 1, sample: msg });
  }

  for (const { count, sample } of shapes.values()) {
    const confirmed = isConfirmedCombination(sample.productId, sample.dumpType);
    console.log(
      `  ${count} x ${describeProduct(sample.productId)} / ${describeDumpType(sample.dumpType)} ` +
        `v${sample.version.join(".")}  wire=${sample.byteLength} decoded=${sample.payload.length}` +
        (confirmed ? "" : "   <- unconfirmed product/type combination"),
    );
  }

  const badChecksum = messages.filter((m) => !isChecksumValid(m));
  const badLength = messages.filter((m) => !isLengthValid(m));
  const badRoundTrip = messages.filter((m, i) => {
    const original = data.subarray(m.fileOffset, m.fileOffset + m.byteLength);
    return !bytesEqual(rebuildMessage(messages[i]!), original);
  });

  console.log(
    `  checksum ${messages.length - badChecksum.length}/${messages.length} ok, ` +
      `length ${messages.length - badLength.length}/${messages.length} ok, ` +
      `round-trip ${messages.length - badRoundTrip.length}/${messages.length} identical`,
  );

  if (opts.verbose) {
    for (const msg of messages) console.log(describeMessage(msg));
  } else {
    for (const msg of [...badChecksum, ...badLength]) console.log(describeMessage(msg));
  }

  if (opts.hexBytes > 0) {
    for (const msg of messages.slice(0, opts.verbose ? messages.length : 1)) {
      console.log(`  [${msg.index}] decoded[0..${opts.hexBytes}]:`);
      const slice = msg.payload.subarray(0, opts.hexBytes);
      for (let off = 0; off < slice.length; off += 16) {
        const row = slice.subarray(off, off + 16);
        const ascii = [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
        console.log(`    ${off.toString(16).padStart(4, "0")}  ${hex(row).padEnd(47)}  ${ascii}`);
      }
    }
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const opts = { verbose: false, hexBytes: 0 };
  const paths: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--verbose" || arg === "-v") opts.verbose = true;
    else if (arg === "--hex") opts.hexBytes = Number(argv[++i] ?? 64);
    else paths.push(arg);
  }

  if (paths.length === 0) {
    console.error("usage: npm run inspect -- [--verbose] [--hex N] <file.syx> [...]");
    process.exit(1);
  }
  for (const path of paths) inspect(path, opts);
}

main();
