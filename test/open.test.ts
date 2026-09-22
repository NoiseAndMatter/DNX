import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeProjectImage } from "@noiseandmatter/dnx-core/project/dn2codec.js";
import { parseProject } from "../src/node/projectfile.js";
import {
  PROJECT_ID_OFFSET,
  mintProjectId,
  projectId,
  writeProjectId,
} from "@noiseandmatter/dnx-core/project/dn2image.js";
import { OpenError, findTemplate, openProject, templateSearchPaths } from "../src/node/open.js";
import { CORPUS, NO_CORPUS, SKIP_REASON } from "./corpus.js";

const skip = NO_CORPUS && SKIP_REASON;

const DN1 = `${CORPUS}01_DN1/01_Projects/002 MORNING_JAM.dnprj`;
const DN2 = `${CORPUS}02_DN2/01_Projects/EMPTY.dn2prj`;

function image(path: string): Uint8Array {
  return decodeProjectImage(parseProject(new Uint8Array(readFileSync(path))).payload.raw).image;
}

// --- the identity token ------------------------------------------------------------------

test("project id round-trips at the offset the format documents", () => {
  const img = new Uint8Array(64);
  writeProjectId(img, 0xdeadbeef);
  assert.equal(projectId(img), 0xdeadbeef);
  assert.equal(img[PROJECT_ID_OFFSET], 0xde, "big-endian, matching every corpus value");
  assert.equal(img[PROJECT_ID_OFFSET + 3], 0xef);
});

test("a minted id is a full 32-bit value and does not repeat", () => {
  const seen = new Set<number>();
  for (let i = 0; i < 500; i++) {
    const id = mintProjectId();
    assert.ok(Number.isInteger(id) && id >= 0 && id <= 0xffffffff, `out of range: ${id}`);
    seen.add(id);
  }
  // 500 draws from 2^32 colliding at all would be a one-in-35-million event, so any repeat
  // here means the generator is not using the range it claims.
  assert.equal(seen.size, 500, "minted ids collided, so the range is smaller than it looks");

  // Both halves must vary: a bug scaling one Math.random() call tends to freeze the low bits.
  const lowBits = new Set([...seen].map((id) => id & 0xffff));
  assert.ok(lowBits.size > 400, "the low half barely varies");
  const highBits = new Set([...seen].map((id) => id >>> 16));
  assert.ok(highBits.size > 400, "the high half barely varies");
});

// --- opening -----------------------------------------------------------------------------

test("a Digitone II project opens as itself, untouched", { skip }, () => {
  const opened = openProject(DN2);
  assert.equal(opened.device.kind, "dn2");
  assert.equal(opened.provenance.converted, false);
  assert.deepEqual(opened.provenance.warnings, []);
  // Opening is not authoring: the identity it already had must survive.
  assert.equal(projectId(opened.image), projectId(image(DN2)));
});

test("a Digitone 1 project opens as a DN1 project by default", { skip }, () => {
  // Converting silently would take away DN1-to-DN1 rearranging, which is a real workflow —
  // someone tidying their Digitone has no use for a DN2 file.
  const opened = openProject(DN1);
  assert.equal(opened.device.kind, "dn1");
  assert.equal(opened.provenance.converted, false);
});

test("--as-dn2 converts a Digitone 1 project on the way in", { skip }, () => {
  const opened = openProject(DN1, { asDn2: true, template: DN2 });
  assert.equal(opened.device.kind, "dn2");
  assert.equal(opened.provenance.converted, true);
  assert.equal(opened.provenance.templatePath, DN2);
  assert.equal(opened.provenance.sourceName, "MORNING_JAM");
  // The output must be writable as a DN2 file, so it carries the template's container.
  assert.equal(opened.manifest.FileType, "Project");
});

test("expansion is reported, so the caller never has to re-derive it", { skip }, () => {
  const plain = openProject(DN1, { asDn2: true, template: DN2 });
  assert.equal(plain.provenance.expansion, undefined);

  const expanded = openProject(DN1, { asDn2: true, template: DN2, expand: true });
  const e = expanded.provenance.expansion;
  assert.ok(e, "expansion should be reported");
  assert.ok(e.soundsPromoted > 0, "this project has sounds to promote");
  assert.ok(e.trigsPromoted > 0);
  assert.ok(e.tracksUsed.length > 0);
  assert.deepEqual(
    e.tracksUsed,
    [...e.tracksUsed].sort((a, b) => a - b),
    "tracks should be reported in order",
  );
});

test("a converted project gets its own identity, not the template's", { skip }, () => {
  // The bug this closes: everything built from EMPTY.dn2prj claimed to be EMPTY. The nine
  // DN1 projects the device upgraded all carry distinct values, so duplicating one is wrong.
  const templateId = projectId(image(DN2));

  const first = openProject(DN1, { asDn2: true, template: DN2 });
  const second = openProject(DN1, { asDn2: true, template: DN2 });

  assert.notEqual(projectId(first.image), templateId, "inherited the template's identity");
  assert.notEqual(projectId(second.image), templateId);
  assert.notEqual(
    projectId(first.image),
    projectId(second.image),
    "two conversions of one source must not claim to be the same project",
  );
  assert.equal(first.provenance.projectId, projectId(first.image));
});

test("asking for a DN2 project as a DN2 project is a no-op, not an error", { skip }, () => {
  const opened = openProject(DN2, { asDn2: true });
  assert.equal(opened.provenance.converted, false);
  assert.equal(projectId(opened.image), projectId(image(DN2)));
});

// --- the template ------------------------------------------------------------------------

test("a template that is not a Digitone II project is refused", { skip }, () => {
  assert.throws(
    () => openProject(DN1, { asDn2: true, template: DN1 }),
    (e: unknown) => e instanceof OpenError && /not a Digitone II project/.test((e as Error).message),
  );
});

test("the template search says where it looked", () => {
  const paths = templateSearchPaths();
  assert.ok(paths.length > 0);
  assert.ok(
    paths.every((p) => p.endsWith(".dn2prj")),
    "every candidate should be a DN2 project",
  );
  // Being told "not found" is useless; the error lists these, which is actionable.
  assert.ok(paths.some((p) => p.includes("EMPTY")));
});

test("a corpus present means a template is discoverable without being named", { skip }, () => {
  // The friction this removes: --template on every invocation of the main workflow.
  assert.ok(findTemplate(), "no template found even though the corpus is present");
});

test("an explicit DN_CORPUS is authoritative, matching test/corpus.ts", () => {
  // Falling back to a sibling folder when DN_CORPUS is set but wrong would hide a
  // configuration error behind a file the user never chose — and a wrong *template* silently
  // supplies 12.9 MB of someone else's project to everything we write.
  const before = { t: process.env["DN_TEMPLATE"], c: process.env["DN_CORPUS"] };
  delete process.env["DN_TEMPLATE"];
  process.env["DN_CORPUS"] = "Z:/nowhere";
  try {
    const paths = templateSearchPaths();
    assert.equal(paths.length, 1, "a set DN_CORPUS must not be supplemented by the sibling");
    assert.ok(paths[0]!.includes("nowhere"));
    assert.equal(findTemplate(), undefined, "a wrong DN_CORPUS must fail loudly, not silently");
  } finally {
    if (before.t === undefined) delete process.env["DN_TEMPLATE"];
    else process.env["DN_TEMPLATE"] = before.t;
    if (before.c === undefined) delete process.env["DN_CORPUS"];
    else process.env["DN_CORPUS"] = before.c;
  }
});

test("DN_TEMPLATE ends the search rather than heading a list", () => {
  const before = process.env["DN_TEMPLATE"];
  process.env["DN_TEMPLATE"] = "Z:/explicit/choice.dn2prj";
  try {
    assert.deepEqual(templateSearchPaths(), ["Z:/explicit/choice.dn2prj"]);
  } finally {
    if (before === undefined) delete process.env["DN_TEMPLATE"];
    else process.env["DN_TEMPLATE"] = before;
  }
});
