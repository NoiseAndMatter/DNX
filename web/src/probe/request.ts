/**
 * Asking the device for something, over the dump framing.
 *
 * Two controls, both of which transmit and neither of which changes anything on the instrument.
 *
 * **Request** asks for an object the protocol has a name for. The reply is an ordinary dump, so it
 * lands in the capture through the same listener the front-panel sends use and needs no correlation
 * logic of its own.
 *
 * **Try code** asks about a dump type nobody has identified, one at a time. The question behind it:
 * Transfer writes projects into chosen slots on a Digitone, so some mechanism exists, and a flat
 * indexed list is exactly the shape the dump protocol already addresses. There is no sweep-all
 * button, deliberately — a scratch project, one code per press, and a look at the device in between.
 *
 * Both require Listen, for the same reason: a request whose answer nobody is collecting is a
 * transmission for no reason.
 */

import { status } from "./chrome.js";
import { tryCode, UNKNOWN_TIMEOUT_MS } from "./dumpio.js";
import { KNOWN_RECORD_SIZES } from "./format.js";
import { linkIsAlive, linkTo } from "./link.js";
import { capture } from "./listen.js";
import { readyDump } from "./ready.js";
import { verdictAfterSilence } from "./silence.js";
import { showVerdict, verdictCard } from "./verdicts.js";
import { hex } from "@noiseandmatter/dnx-core/device/capabilities.js";
import { dumpRequest, REQUEST_OPTIONS } from "@noiseandmatter/dnx-core/device/dumprequest.js";
import { codesUnderTest, describeReply } from "../../../src/research/probecodes.js";
import { askConfirm } from "../dialog.js";
import { $, escapeHtml } from "../dom.js";

/**
 * Ask the device to send something.
 *
 * **The only thing on this page that transmits.** It goes out over the *dump* framing rather than
 * the API's, and the reply is an ordinary dump — so it lands in the capture through the same
 * listener the front-panel sends use, and needs no correlation logic of its own.
 *
 * Requires Listen to be running, deliberately: a request whose answer nobody is collecting is a
 * transmission for no reason, and this is the one control where "for no reason" is worth avoiding.
 */
function fillRequestOptions(): void {
  const select = $<HTMLSelectElement>("reqWhat");
  select.innerHTML = REQUEST_OPTIONS.map(
    (o) => `<option value="${o.code}">${escapeHtml(o.label)}</option>`,
  ).join("");
}

function requestOption(): (typeof REQUEST_OPTIONS)[number] {
  const code = Number($<HTMLSelectElement>("reqWhat").value);
  return REQUEST_OPTIONS.find((o) => o.code === code) ?? REQUEST_OPTIONS[0]!;
}

$("request").addEventListener("click", () => {
  const ready = readyDump("reply");
  if (!ready) return;
  const { output, productId: product } = ready;

  const option = requestOption();
  const objNr = option.indexed ? Number($<HTMLInputElement>("reqObj").value) : 0;

  try {
    output.send([...dumpRequest(product, { code: option.code, objNr })]);
    status(
      `Asked for ${option.label.toLowerCase()}${option.indexed ? ` ${objNr}` : ""} — ` +
        `expecting roughly ${option.approximateBytes(product).toLocaleString()} bytes back.`,
    );
  } catch (error) {
    status(`Could not send the request: ${error}`, "error");
  }
});

fillRequestOptions();

// --- trying an unidentified request code ---------------------------------------------------------

/**
 * Ask the device about a dump type nobody has identified, one at a time.
 *
 * The question behind it: **Transfer writes projects into chosen slots on a Digitone, so some
 * mechanism exists.** It is probably not the SysEx file API — project storage on both machines is
 * a flat indexed list rather than a filesystem, which is exactly the shape the *dump* protocol
 * already addresses. Nine or ten dump types are unidentified, and that is where a project object
 * would sit.
 *
 * Everything sent here is a `0x6n` request with an empty body — same shape and same argument as
 * the five already proven. That argument is inference rather than certainty, so the discipline is
 * the safeguard: **a scratch project, one code per press, a look at the device in between.** There
 * is no sweep-all button, deliberately.
 */
export function fillProbeCodes(advertised: readonly number[]): void {
  const select = $<HTMLSelectElement>("probeCode");
  select.innerHTML = codesUnderTest(advertised)
    .map((c) => {
      const label = c.known
        ? `${hex(c.code)} → ${hex(c.response)}  ${c.known} (control)`
        : `${hex(c.code)} → ${hex(c.response)}  unknown${c.advertised ? ", advertised" : ""}`;
      return `<option value="${c.code}">${escapeHtml(label)}</option>`;
    })
    .join("");
  const usable = advertised.length > 0;
  select.disabled = !usable;
  $<HTMLInputElement>("probeObj").disabled = !usable;
  $<HTMLButtonElement>("probeSend").disabled = !usable;
}

$("probeSend").addEventListener("click", () => {
  tryUnknownCode().catch((error: unknown) => {
    status(`Could not try that code: ${String(error)}`, "error");
  });
});

async function tryUnknownCode(): Promise<void> {
  const ready = readyDump("reply");
  if (!ready) return;
  const { output, productId } = ready;

  const code = Number($<HTMLSelectElement>("probeCode").value);
  const objNr = Number($<HTMLInputElement>("probeObj").value);
  const info = codesUnderTest([]).find((c) => c.code === code)!;

  if (
    !info.known &&
    !(await askConfirm({
      title: `Send ${hex(code)}, an unidentified request, object ${objNr}?`,
      body: [
        "It carries an empty body, like every request already proven on both machines — so by " +
          "that convention it asks rather than stores. That is an inference, not a certainty.",
        "Load a scratch project first, and check the device after this returns.",
      ],
      confirmLabel: `Send ${hex(code)}`,
      danger: true,
    }))
  ) {
    return;
  }

  const log: [string, string][] = [
    ["Sent", `${hex(code)} object ${objNr}, empty body`],
    ["Expecting", `${hex(code - 0x10)} by the +0x10 convention, if it answers at all`],
    ["Known as", info.known ?? "nothing — no source names this code"],
  ];
  verdictCard("Trying a code", log);

  // Anything at all counts, not only the predicted response: an unknown request answering with an
  // unexpected code would be the most interesting outcome available, and matching strictly on the
  // convention would throw it away.
  const reply = await tryCode(linkTo(output), productId, code, objNr, (error) =>
    log.push(["Send failed", String(error)]),
  );

  if (!reply) {
    // **This is the check whose absence voided a whole afternoon.** A run of silences was recorded
    // as "not implemented" while Elektron Transfer held the output port, so those requests may
    // never have been sent at all. The control makes a negative worth something.
    showVerdict(
      verdictAfterSilence({
        what: hex(code),
        alive: await linkIsAlive(output),
        outcome: `nothing within ${UNKNOWN_TIMEOUT_MS}ms`,
        log,
        means:
          "the link is proven, so this is a real negative: the code is not implemented, or it " +
          "wants an argument we did not send. Worth recording.",
      }),
    );
    return;
  }

  const described = describeReply(
    code,
    reply.dumpType,
    reply.objNr,
    reply.payload.length,
    reply.storedChecksum === reply.computedChecksum,
    KNOWN_RECORD_SIZES,
  );

  verdictCard(`${hex(code)} ANSWERED with ${hex(described.dumpType)}`, [
    ...log,
    [
      "Answered",
      `${hex(described.dumpType)}${described.asExpected ? " — as the convention predicts" : " — NOT the predicted code"}`,
    ],
    ["Object", String(described.objNr)],
    ["Payload", `${described.payloadBytes.toLocaleString()} bytes`],
    ["Resembles", described.resembles ?? "no record size we know — this is something new"],
    ["Checksum", described.checksumOk ? "good" : "BAD"],
    ["Next", "Save the capture and check the device screen before trying another code."],
  ]);
  status(
    `${hex(code)} answered ${hex(described.dumpType)}, ${described.payloadBytes.toLocaleString()} bytes.`,
    "ok",
  );
}
