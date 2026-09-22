/**
 * Turn a Wireshark/USBPcap capture into `.syx` — one file per direction.
 *
 * ```
 * npm run usbcap -- capture.pcapng
 * ```
 *
 * Writes `<name>_host.syx` and `<name>_device.syx` beside the input, and summarises both with the
 * same code the probe uses on live traffic.
 *
 * **The host file is the point.** Everything DNX knows about the Digitone's storage API was decoded
 * from the device's replies, because Web MIDI could only ever listen to the input while Elektron
 * Transfer held the ports. `<name>_host.syx` is Transfer's half of the conversation, which nothing
 * we have built has ever seen.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { summariseCapture } from "@noiseandmatter/dnx-core/device/capture.js";
import { parsePcapng, reassembleUsbMidi, toSyx } from "../research/usbcapture.js";

const input = process.argv[2];
if (!input) {
  console.error("usage: npm run usbcap -- <capture.pcapng>");
  process.exit(2);
}

const file = new Uint8Array(readFileSync(input));
const packets = parsePcapng(file);
const traffic = reassembleUsbMidi(packets);

console.log(`${basename(input)}  ${file.length.toLocaleString()} bytes`);
console.log(`  USB packets      ${packets.length.toLocaleString()}`);
console.log(`  host → device    ${traffic.toDevice.length.toLocaleString()} SysEx messages`);
console.log(`  device → host    ${traffic.fromDevice.length.toLocaleString()} SysEx messages`);
console.log(`  other events     ${traffic.otherEvents.toLocaleString()} (clock, notes, padding)`);
if (traffic.danglingBytes > 0) {
  // A capture stopped mid-message, or one direction's stream started part-way through. Said out
  // loud because a truncated request is exactly the kind of thing that would be decoded as a
  // different, shorter request and believed.
  console.log(`  incomplete       ${traffic.danglingBytes} bytes in a SysEx with no F7`);
}

if (packets.length === 0) {
  console.log(
    "\nNothing captured on a USB interface. Capture on the USBPcap interface for the hub the " +
      "instrument is plugged into — its settings dialog lists the devices on each hub.",
  );
  process.exit(1);
}

const base = join(dirname(input), basename(input, extname(input)));
for (const [label, messages] of [
  ["host", traffic.toDevice],
  ["device", traffic.fromDevice],
] as const) {
  if (messages.length === 0) continue;
  const bytes = toSyx(messages);
  const path = `${base}_${label}.syx`;
  writeFileSync(path, bytes);
  console.log(`\n${path}  ${bytes.length.toLocaleString()} bytes`);
  describe(bytes);
}

/** The same summary the probe shows, so a capture reads the way live traffic does. */
function describe(bytes: Uint8Array): void {
  const summary = summariseCapture(bytes);
  for (const group of summary.groups) {
    console.log(`  dump  ${group.product} ${group.name}: ${group.count} × ${group.bytes.toLocaleString()} B`);
  }
  for (const group of summary.api) {
    console.log(
      `  api   0x${group.code.toString(16).padStart(2, "0")} ${group.name}: ${group.count} messages, ` +
        `${group.bytes.toLocaleString()} B`,
    );
  }
  if (summary.foreign > 0) console.log(`  ${summary.foreign} not Elektron`);
  if (summary.unparsed > 0) console.log(`  ${summary.unparsed} unreadable`);
}
