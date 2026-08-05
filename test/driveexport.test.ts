/**
 * Saving a project read off the +Drive as a project file.
 *
 * ## The bug this pins
 *
 * The manager could open any slot on the +Drive, browse it, rename patterns and rearrange them —
 * and its Export button did nothing whatsoever. `state.file` was never set on that path, so
 * `exportProject` returned at its first line while the status bar was actively inviting the press.
 * Every piece needed was already written and tested: `manifestFor` had no production caller at all.
 *
 * ## The trap underneath it
 *
 * **A stored project and a downloaded one are not the same bytes.** A `.dnprj` holds its image
 * LZ4-compressed; the +Drive sends the image *uncompressed*, wrapped in the same header and
 * trailer. So building a file from a +Drive payload means taking its 31-byte container header —
 * device signature, project slot — and compressing the image behind it, and a mistake there
 * produces a file that looks entirely plausible and will not load.
 *
 * That is what the round trip below is for, and it runs on a real capture: 2,781,743 bytes read off
 * the author's Digitone over SysEx, not a payload this code shaped for itself.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";
import { imageFrom, manifestFor } from "../src/device/drive.js";
import { parsePayload } from "../src/project/container.js";
import { buildProjectBlob, readProjectFile } from "../web/src/project.js";
import { readZip } from "../web/src/zip.js";

const skip = NO_CORPUS ? SKIP_REASON : false;

/** Slot 1 of the author's Digitone, exactly as the +Drive sent it. */
function deviceRead(): Uint8Array {
  const bytes = new Uint8Array(readFileSync(join(CORPUS!, "..", "99_HardwareTest", "projects_1_2781743B.bin")));
  // The fixture is named for its length. Asserting it means this test cannot quietly pass against
  // a truncated or replaced file — the failure mode where a test proves nothing by finding nothing.
  assert.equal(bytes.length, 2_781_743, "the capture is not the one this test was written against");
  return bytes;
}

test("a project read off the +Drive exports to a file that decodes back to the same image", { skip }, async () => {
  const payload = parsePayload(deviceRead());
  const image = imageFrom(payload);
  const manifest = manifestFor(payload, "001 PRESETS", "1.42A");

  const blob = await buildProjectBlob({ fileName: "001 PRESETS.dnprj", manifest, payload, image }, image);
  const reopened = await readProjectFile("001 PRESETS.dnprj", new Uint8Array(await blob.arrayBuffer()));

  // The whole point: what the device holds and what the file holds are the same project.
  assert.deepEqual(reopened.image, image, "the exported file does not decode to the image it was built from");
  assert.deepEqual(reopened.manifest, manifest, "the manifest did not survive the ZIP round trip");
});

test("the exported file is compressed, not the raw +Drive bytes passed through", { skip }, async () => {
  const raw = deviceRead();
  const payload = parsePayload(raw);
  const image = imageFrom(payload);

  const blob = await buildProjectBlob(
    { fileName: "x.dnprj", manifest: manifestFor(payload, "x", "1.42A"), payload, image },
    image,
  );

  // A file that merely re-wrapped the uncompressed payload would come out around the raw size and
  // would still round-trip through our own reader — so size is what distinguishes "we built a
  // .dnprj" from "we shipped what the device sent". The corpus file for this project is 77,832
  // payload bytes against 2,781,700 of image.
  assert.ok(
    blob.size < raw.length / 4,
    `expected a compressed file well under ${Math.round(raw.length / 4)} bytes, got ${blob.size}`,
  );
});

test("an image edited after the read is what lands in the exported file", { skip }, async () => {
  const payload = parsePayload(deviceRead());
  const image = imageFrom(payload);

  // Stand in for a rename or a rearrange: the export must carry the *working* image, not re-emit
  // the bytes the device sent. Building from `payload` while writing `image` is exactly the shape
  // that could silently do the latter.
  const edited = Uint8Array.from(image);
  edited[0x20] = edited[0x20]! ^ 0xff;

  const blob = await buildProjectBlob(
    { fileName: "x.dnprj", manifest: manifestFor(payload, "x", "1.42A"), payload, image },
    edited,
  );
  const reopened = await readProjectFile("x.dnprj", new Uint8Array(await blob.arrayBuffer()));

  assert.deepEqual(reopened.image, edited);
  assert.notDeepEqual(reopened.image, image, "the export re-emitted the original instead of the edit");
});

test("the exported file says it is compressed, because it is", { skip }, async () => {
  // **The bug this suite missed.** A payload read off the +Drive carries an uncompressed body and
  // a header byte saying so; `buildPayload` copies that header and then writes an LZ4 chain. The
  // round trip above still passed, because our reader measures the body rather than trusting the
  // flag — and Elektron Transfer does trust it: it stopped at "Calculating Checksum" and crashed.
  //
  // 0x01 is what all 79 corpus project files carry, both families. 0x00 appears only in the
  // uncompressed +Drive stream.
  const raw = deviceRead();
  const payload = parsePayload(raw);
  assert.equal(payload.raw[29], 0x00, "the +Drive stream is the uncompressed one");

  const image = imageFrom(payload);
  const blob = await buildProjectBlob(
    { fileName: "x.dnprj", manifest: manifestFor(payload, "x", "1.42A"), payload, image },
    image,
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const entries = await readZip(bytes);
  const written = entries.get("x")!;
  assert.equal(written[29], 0x01, "an exported project must say compressed, like every real one");
});