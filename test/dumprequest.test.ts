import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMessage } from "../src/sysex/container.js";
import { ProductId } from "../src/sysex/devices.js";
import {
  REQUEST_OPTIONS,
  RequestCode,
  dumpProductFor,
  dumpRequest,
  responseFor,
} from "../src/device/dumprequest.js";
import { describeMessages, safeToSend } from "../src/device/capabilities.js";

test("a request carries no payload, which is why it cannot write", () => {
  // The entire safety argument in one assertion. elk-herd builds these with `Builder.empty` and
  // parses them by asserting the message ends immediately; a message with nothing in it has
  // nothing to store.
  for (const code of Object.values(RequestCode)) {
    const m = parseMessage(dumpRequest(ProductId.DN2, { code }));
    assert.equal(m.payload.length, 0, `0x${code.toString(16)} should carry an empty body`);
  }
});

test("a request is addressed to a product and a dump type", () => {
  const m = parseMessage(dumpRequest(ProductId.DN1, { code: RequestCode.Kit, objNr: 7 }));
  assert.equal(m.productId, ProductId.DN1);
  assert.equal(m.dumpType, RequestCode.Kit);
  assert.equal(m.objNr, 7);
});

test("every request pairs with the response it should produce", () => {
  // The convention this whole feature rests on: request = response + 0x10.
  assert.equal(responseFor(RequestCode.PatternKit), 0x50);
  assert.equal(responseFor(RequestCode.Pattern), 0x51);
  assert.equal(responseFor(RequestCode.Kit), 0x52);
  assert.equal(responseFor(RequestCode.Sound), 0x53);
  assert.equal(responseFor(RequestCode.ProjectSettings), 0x54);
});

test("an object number that will not fit is refused rather than truncated", () => {
  // The field is one 7-bit byte — the same limit that makes a long bank dump saturate at 128.
  // Sending 200 would silently become something else and fetch the wrong object.
  assert.throws(() => dumpRequest(ProductId.DN2, { code: RequestCode.Sound, objNr: 200 }), /7-bit/);
  assert.throws(() => dumpRequest(ProductId.DN2, { code: RequestCode.Sound, objNr: -1 }), /7-bit/);
  assert.doesNotThrow(() => dumpRequest(ProductId.DN2, { code: RequestCode.Sound, objNr: 127 }));
});

test("a code we do not recognise is refused", () => {
  // Including 0x6f WholeProject, deliberately: asking a device for 14.6 MB is not the experiment
  // that tells you whether requests work.
  assert.throws(() => dumpRequest(ProductId.DN2, { code: 0x6f as RequestCode }), /not a request code/);
  assert.throws(() => dumpRequest(ProductId.DN2, { code: 0x50 as RequestCode }), /not a request code/);
});

test("requests are classified read, and dumps still are not", () => {
  // The one place the allowlist bends, and it must bend only here. A 0x50 sent to a device is
  // "store this pattern"; a 0x60 asks for one.
  for (const code of Object.values(RequestCode)) {
    assert.equal(safeToSend(code), true, `0x${code.toString(16)} should be sendable`);
    assert.equal(describeMessages([code])[0]!.safety, "read");
  }
  for (const dump of [0x50, 0x51, 0x52, 0x53, 0x54]) {
    assert.equal(safeToSend(dump), false, `0x${dump.toString(16)} must stay refused`);
  }
  assert.equal(safeToSend(0x6f), false, "WholeProject is not implemented and not sendable");
});

test("the smallest object is offered first", () => {
  // ProjectSettings: one object, no index to get wrong, and the least data back. If the
  // convention holds it answers at once; if it does not, nothing happened.
  assert.equal(REQUEST_OPTIONS[0]!.code, RequestCode.ProjectSettings);
  assert.equal(REQUEST_OPTIONS[0]!.indexed, false);
});

test("every offered request is one we can build", () => {
  for (const option of REQUEST_OPTIONS) {
    assert.doesNotThrow(() => dumpRequest(ProductId.DN2, { code: option.code, objNr: 0 }));
    assert.ok(option.approximateBytes(ProductId.DN2) > 0, `${option.label} needs a size estimate`);
    assert.ok(option.approximateBytes(ProductId.DN1) > 0, `${option.label} needs a DN1 estimate`);
  }
});

test("the API product id is converted, never copied", () => {
  // The two protocols number products differently: the Device response says 20 and 43, the dump
  // framing wants 0x0D and 0x15. The first request built went out addressed to 43 — a product
  // that does not exist in the dump space — and the device rightly ignored it.
  assert.equal(dumpProductFor(20), ProductId.DN1);
  assert.equal(dumpProductFor(43), ProductId.DN2);
});

test("an unknown product yields no id rather than a plausible one", () => {
  // Better to refuse than to address a message to a guess. A Digitakt on the same port would
  // report an API id we have no dump-space mapping for.
  assert.equal(dumpProductFor(12), undefined);
  assert.equal(dumpProductFor(42), undefined);
  assert.equal(dumpProductFor(0), undefined);
});

test("a request is addressed with the dump-space id, and it is on the wire", () => {
  // Byte 4 is the product. Checked as a byte rather than through our own parser, because the
  // failure being guarded is precisely a well-formed message with the wrong number in it.
  const bytes = dumpRequest(dumpProductFor(43)!, { code: RequestCode.ProjectSettings });
  assert.equal(bytes[4], 0x15, `byte 4 should be 0x15, got 0x${bytes[4]!.toString(16)}`);
  assert.notEqual(bytes[4], 43, "the API id must never reach the wire");
});
