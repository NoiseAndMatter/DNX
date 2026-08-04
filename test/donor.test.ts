/**
 * The donor a device read borrows its missing bytes from.
 *
 * ## What is actually being guarded here
 *
 * The manager's Open Device refused with *"No template available"* while the local server was
 * sitting there serving `EMPTY.dn2prj` and a device-authored blank was compiled into the page. Two
 * separate faults produced that one sentence, and both are pinned below:
 *
 * 1. **A refusal for want of something the code already has.** Three of the four donor paths gave
 *    up rather than fall back to the embedded blank. `loadDonor` cannot return nothing.
 * 2. **A template that is present but unreadable, reported as absent.** `fetchServedTemplate`
 *    wrapped its parse in the same `catch` as its `fetch`, so a broken donor and no donor were the
 *    same answer — and the message sent the user looking for a file that was already there.
 *
 * These run without a browser: `fetch` is a global here too, so the server can be stood up as a
 * stub and every branch exercised. **The served project is deliberately named something the
 * built-in one never is**, because a test that cannot tell the two donors apart would pass whether
 * the fallback fired or not.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { blankDn2ProjectFile } from "../src/librarian/blankproject.js";
import { deviceFor } from "../src/librarian/device.js";
import { BUILT_IN_BLANK_FIRMWARE, describeDonor, loadDonor, type Donor } from "../web/src/donor.js";
import { fetchServedTemplate, readProjectFile } from "../web/src/project.js";

/** The name only the served path can produce, so "served" and "built-in" are never confusable. */
const SERVED_NAME = "SERVED-BY-THE-STUB.dn2prj";

/**
 * Run one body with `fetch` replaced, and put the real one back afterwards.
 *
 * Restored in a `finally`: a leaked stub would make every later test in this process talk to a
 * server that answers whatever the last case wanted.
 */
async function withFetch(stub: typeof globalThis.fetch, body: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
}

const noServer: typeof globalThis.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
const notFound: typeof globalThis.fetch = () => Promise.resolve(new Response("no template found", { status: 404 }));

const serving = (bytes: Uint8Array): typeof globalThis.fetch => {
  return () =>
    Promise.resolve(
      new Response(bytes.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: { "x-template-name": SERVED_NAME },
      }),
    );
};

test("with no server at all, the donor is the blank built into the code", async () => {
  await withFetch(noServer, async () => {
    const donor = await loadDonor();
    assert.equal(donor.origin, "built-in");
    assert.equal(deviceFor(donor.project.image).kind, "dn2", "the built-in donor must be a Digitone II project");
  });
});

test("a 404 from the local server is not a failure, it is no template", async () => {
  await withFetch(notFound, async () => {
    assert.equal((await loadDonor()).origin, "built-in");
  });
});

test("a served template is preferred over the built-in blank", async () => {
  await withFetch(serving(blankDn2ProjectFile()), async () => {
    const donor = await loadDonor();
    assert.equal(donor.origin, "served");
    // The name is the proof. The bytes are the same file either way, which is exactly why
    // asserting on them would prove nothing.
    assert.equal(donor.project.fileName, SERVED_NAME);
  });
});

test("a picked project wins over anything the server offers", async () => {
  await withFetch(serving(blankDn2ProjectFile()), async () => {
    const picked = await readProjectFile("MINE.dn2prj", blankDn2ProjectFile());
    const donor = await loadDonor({ picked });
    assert.equal(donor.origin, "picked");
    assert.equal(donor.project.fileName, "MINE.dn2prj");
  });
});

test("a template that is present but unreadable is said so, and stepped over", async () => {
  const rubbish = new Uint8Array(64).fill(0x41);
  await withFetch(serving(rubbish), async () => {
    const problems: string[] = [];
    const donor = await loadDonor({ onProblem: (message) => problems.push(message) });

    assert.equal(donor.origin, "built-in", "a broken template must not leave the page with nothing");
    assert.equal(problems.length, 1, "the user has to be told the template is broken, not ignored");
    // The regression in one line: this must never read as an absence.
    assert.match(problems[0]!, /could not be read/);
    assert.doesNotMatch(problems[0]!, /no template|not available/i);
  });
});

test("fetchServedTemplate throws for a broken template rather than reporting none", async () => {
  await withFetch(serving(new Uint8Array(64).fill(0x41)), async () => {
    await assert.rejects(
      () => fetchServedTemplate(),
      (error: Error) => {
        // Named, so the message can say which file is the broken one.
        assert.match(error.message, new RegExp(SERVED_NAME.replace(/\./g, "\\.")));
        return true;
      },
    );
  });
});

test("fetchServedTemplate still answers undefined when there is genuinely no server", async () => {
  await withFetch(noServer, async () => {
    assert.equal(await fetchServedTemplate(), undefined);
  });
});

test("only the built-in donor names its firmware, because only it is unverified against your device", async () => {
  const builtIn: Donor = { origin: "built-in", project: await readProjectFile("blank.dn2prj", blankDn2ProjectFile()) };
  assert.match(describeDonor(builtIn), new RegExp(BUILT_IN_BLANK_FIRMWARE));

  const served: Donor = { origin: "served", project: await readProjectFile("EMPTY.dn2prj", blankDn2ProjectFile()) };
  assert.equal(describeDonor(served), "EMPTY.dn2prj");
});
