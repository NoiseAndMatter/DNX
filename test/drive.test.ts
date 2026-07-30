/**
 * The +Drive as a project library.
 *
 * The fixture that matters here is **2,781,743 bytes a Digitone 1 actually sent us** — the whole of
 * `/projects/1`, read over SysEx on 2026-07-30. Everything this module claims comes down to one
 * thing: that those bytes are a project payload and the existing reader takes them. A synthetic
 * fixture could not test that, because it would be built by the same understanding it was meant to
 * check.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type ApiFrame, RESPONSE_BIT, decodeMessage } from "../src/device/api.js";
import {
  PROJECTS,
  imageFrom,
  listProjects,
  manifestFor,
  projectFor,
  readDriveProject,
} from "../src/device/drive.js";
import { parsePayload } from "../src/project/container.js";
import { decodeProjectImage } from "../src/project/dn2codec.js";
import { parseProject } from "../src/project/projectfile.js";
import { type ApiTransport } from "../src/device/storagesession.js";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";

const skip = NO_CORPUS && SKIP_REASON;

/** The Digitone 1's own answer to `/projects/1`, saved by the probe. */
function deviceRead(): Uint8Array {
  return new Uint8Array(
    readFileSync(join(CORPUS!, "..", "99_HardwareTest", "projects_1_2781743B.bin")),
  );
}

// --- the claim this module rests on ---------------------------------------------------------------

test("what the +Drive sends is a project payload the existing reader accepts", { skip }, () => {
  // No changes to `parsePayload`, no special case for device bytes. If this ever needs one, the
  // premise of the whole device-first phase is wrong and it should fail loudly here.
  const payload = parsePayload(deviceRead());

  assert.equal(payload.formatVersion, "0097", "a Digitone 1 project");
  assert.equal(payload.kind, 9);
  assert.equal(
    payload.storedLength,
    payload.computedLength,
    "the length the payload declares matches the one measured — the read is complete",
  );
  assert.equal(payload.storedLength, 2_781_700, "the known DN1 image size");
  assert.ok(payload.objects.length > 100, `only ${payload.objects.length} objects parsed`);
});

test("the sound pool is in there, at the size a DN1 sound has always been", { skip }, () => {
  // 302 bytes is the DN1 sound record. Hundreds of them is the pool, which is the half a dump-based
  // read has to ask for separately and a file read gets for free.
  const sounds = parsePayload(deviceRead()).objects.filter((o) => o.data.length === 302);
  assert.ok(sounds.length > 50, `expected a pool, found ${sounds.length} sound-sized objects`);
});

test("a truncated read is refused rather than parsed into a plausible project", { skip }, async () => {
  // The failure this exists to catch is a transfer that stops early and still looks like data. The
  // length check is what notices, and it has to notice **here**, next to the transfer, rather than
  // in an editor three operations later.
  const short = deviceRead().subarray(0, 500_000);
  const io = openThenChunks([short]);

  await assert.rejects(readDriveProject(io, 1), /length|payload/i);
});

test("the image off the +Drive is byte-identical to the image out of the file", { skip }, () => {
  // **The strongest check available anywhere in this project**, and it is available only because
  // the corpus happens to hold `001 PRESETS.dnprj` — the same project the device served as slot 1.
  //
  // Two entirely independent paths off one instrument: Elektron's own export, LZ4-compressed into
  // a ZIP and decoded by our codec; and 1,358 SysEx chunks reassembled by code written this
  // afternoon from a protocol we reverse-engineered. If those agree to the byte, the transport,
  // the sequencing, the chunk assembly and the payload framing are all correct together.
  //
  // Note the fixtures come from opposite directions - neither was produced by the code under test.
  const fromDevice = imageFrom(parsePayload(deviceRead()));
  const fromFile = decodeProjectImage(
    parseProject(new Uint8Array(readFileSync(join(CORPUS!, "01_DN1", "01_Projects", "001 PRESETS.dnprj"))))
      .payload.raw,
  ).image;

  assert.equal(fromDevice.length, fromFile.length);
  assert.equal(fromDevice.length, 2_781_700);

  let differing = 0;
  for (let i = 0; i < fromFile.length; i++) if (fromDevice[i] !== fromFile[i]) differing++;
  assert.equal(differing, 0, `${differing} bytes differ between the device read and the file`);
});

test("a compressed payload is refused rather than sliced into nonsense", { skip }, () => {
  // A `.dnprj` payload is LZ4-compressed - 77,832 bytes that expand to 2,781,700 - so slicing 31
  // bytes off it and calling the rest an image would produce 2.7 MB of plausible garbage. The
  // declared length is what tells the two apart, and it is checked rather than assumed.
  const compressed = parseProject(
    new Uint8Array(readFileSync(join(CORPUS!, "01_DN1", "01_Projects", "001 PRESETS.dnprj"))),
  ).payload;

  assert.throws(() => imageFrom(compressed), /looks compressed/);
});

// --- listing ---------------------------------------------------------------------------------------

test("projects come back in slot order, with the index the device gave them", async () => {
  // Slot order rather than arrival order, because the index is what `/projects/<index>` addresses.
  // A list sorted by anything else invites opening the wrong project, which is the single most
  // expensive mistake this module could make.
  const io = replies([listing([
    { name: "PRESETS", index: 1 },
    { name: "AMBZ", index: 3 },
    { name: "MORNING_JAM", index: 2 },
  ])]);

  const projects = await listProjects(io);

  assert.deepEqual(projects.map((p) => p.index), [1, 2, 3]);
  assert.deepEqual(projects.map((p) => p.name), ["PRESETS", "MORNING_JAM", "AMBZ"]);
  assert.equal(projects[0]!.allocated, 4_194_304, "the slot allocation, not the file size");
});

test("a slot number that could not have come from a listing is refused", async () => {
  const io = replies([]);
  await assert.rejects(readDriveProject(io, 0), /1-based index/);
  await assert.rejects(readDriveProject(io, -1), /1-based index/);
  await assert.rejects(readDriveProject(io, 1.5), /1-based index/);
});

test("the path is the index, never the name", async () => {
  // /projects/PRESETS is answered `invalid project id`; /projects/1 opens. The device turns the
  // last segment into a number, and this is the assertion that keeps it that way.
  const sent: string[] = [];
  const io: ApiTransport = {
    request(request, msgId, timeoutMs) {
      const body = decodeMessage(request).body;
      sent.push(new TextDecoder("windows-1252").decode(body).replace(/\0.*$/s, ""));
      return openThenChunks([deviceReadOrEmpty()]).request(request, msgId, timeoutMs);
    },
  };

  await readDriveProject(io, 7).catch(() => undefined);
  assert.equal(sent[0], `${PROJECTS}/7`);
});

// --- the manifest the +Drive does not send ---------------------------------------------------------

test("a DN1 manifest is rebuilt to match what Elektron's own files carry", { skip }, () => {
  const payload = parsePayload(deviceRead());
  const manifest = manifestFor(payload, "PRESETS", "1.42A");

  // Matched against a real corpus manifest, field for field:
  // {"FormatVersion":"1.0","ProductType":["24","30"],"Payload":"PRESETS","FileType":"Project",
  //  "FirmwareVersion":"1.42A"}
  assert.deepEqual(manifest, {
    FormatVersion: "1.0",
    ProductType: ["24", "30"],
    Payload: "PRESETS",
    FileType: "Project",
    FirmwareVersion: "1.42A",
  });
});

test("a DN2 manifest lists no product types, because Elektron's do not", () => {
  // Nine DN2 files in the corpus carry an empty array. Copying the DN1's would be a guess that
  // reads as a fact once it is written into a file.
  const manifest = manifestFor({ kind: 15 } as never, "GLITCH_EXPLORE", "1.10E");
  assert.deepEqual(manifest.ProductType, []);
  assert.equal(manifest.Payload, "GLITCH_EXPLORE");
});

test("a device read and a file read produce the same shape", { skip }, () => {
  // The point of the manifest reconstruction: everything above this line stops caring whether a
  // project came off a device or off a disk.
  const project = projectFor(
    { bytes: deviceRead(), chunks: 1, closed: true, payload: parsePayload(deviceRead()) },
    "PRESETS",
    "1.42A",
  );

  assert.equal(project.manifest.FileType, "Project");
  assert.equal(project.payload.formatVersion, "0097");
  assert.ok(project.payload.objects.length > 100);
});

// --- transports ------------------------------------------------------------------------------------

function deviceReadOrEmpty(): Uint8Array {
  try {
    return deviceRead();
  } catch {
    return new Uint8Array(0);
  }
}

/** A transport that answers each request from a queue of bodies. */
function replies(bodies: Uint8Array[]): ApiTransport {
  let at = 0;
  return {
    request(request: Uint8Array, msgId: number): Promise<ApiFrame> {
      const code = decodeMessage(request).code;
      const body = bodies[at++];
      if (!body) return Promise.reject(new Error(`no scripted reply for 0x${code.toString(16)}`));
      return Promise.resolve({ msgId, respId: msgId, code: code | RESPONSE_BIT, body, isResponse: true });
    },
  };
}

/** Answer an open, then serve the given files as 2,048-byte chunks, then a close. */
function openThenChunks(files: Uint8Array[]): ApiTransport {
  const data = files[0] ?? new Uint8Array(0);
  let sequence = 0;
  return {
    request(request: Uint8Array, msgId: number): Promise<ApiFrame> {
      const code = decodeMessage(request).code;
      let body: Uint8Array;
      if (code === 0x54) body = Uint8Array.of(1, 0, 0, 0, 1, 0, 0, 0x08, 0, 1);
      else if (code === 0x56) body = Uint8Array.of(1, 0, 0, 0, 1, 0, 0, 0, 0);
      else {
        const start = sequence * 2048;
        const slice = data.subarray(start, start + 2048);
        sequence++;
        body = chunkReply(sequence, slice, start + slice.length >= data.length);
      }
      return Promise.resolve({ msgId, respId: msgId, code: code | RESPONSE_BIT, body, isResponse: true });
    },
  };
}

function chunkReply(sequence: number, data: Uint8Array, last: boolean): Uint8Array {
  const out = new Uint8Array(22 + data.length);
  out[0] = 1;
  writeU32(out, 1, 1);
  writeU32(out, 5, sequence);
  writeU32(out, 9, 1000);
  out[13] = last ? 1 : 0;
  writeU32(out, 18, data.length);
  out.set(data, 22);
  return out;
}

/** A `/projects` listing reply, in the layout `parseListing` reads. */
function listing(entries: { name: string; index: number }[]): Uint8Array {
  const parts: number[] = [1];
  push32(parts, 0);
  push32(parts, entries.length + 1);
  push32(parts, entries.length);
  for (const e of entries) {
    for (const ch of e.name) parts.push(ch.charCodeAt(0));
    parts.push(0, 0x00, 0x02);
    push32(parts, e.index);
    push32(parts, 4_194_304);
    parts.push(0x00, 0x12, 0x01, 0x01);
  }
  return Uint8Array.from(parts);
}

function push32(out: number[], v: number): void {
  out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

function writeU32(out: Uint8Array, at: number, v: number): void {
  out[at] = (v >>> 24) & 0xff;
  out[at + 1] = (v >>> 16) & 0xff;
  out[at + 2] = (v >>> 8) & 0xff;
  out[at + 3] = v & 0xff;
}
