/**
 * An `ApiTransport` backed by the firmware running in an emulator, so the +Drive can be exercised
 * without an instrument.
 *
 * ## What this is talking to
 *
 * `sysex_bridge.exe` from the digikit Rust emulator, built by the firmware session. It boots a
 * real Digitone II OS image, injects a SysEx message into the firmware's **own router** from the
 * UI task, and captures what reaches the firmware's **own SysEx sender**. There is no USB model
 * and no MIDI model in the way: everything from the router down is the code the instrument runs.
 *
 * So what gets tested here is not a mock of the device. It is DNX's real request builders and
 * parsers against the firmware's real handlers, and the only thing simulated is the wire.
 *
 * ## Why it matters more than it sounds
 *
 * Every +Drive behaviour DNX knows was learnt by sending something to the author's instrument and
 * looking at what came back, which is slow, needs a person present, and in the case of writing
 * risks the only copy of their music. Three of this project's longest-standing mistakes — the
 * chunk index read as a byte offset, the stored form sent raw, the missing NUL terminator that
 * froze a Digitone 1 three times — were all things a round trip would have shown in seconds.
 *
 * ## What it is not
 *
 * **It is not the instrument.** The emulator's card is blank unless given an image, its state is a
 * snapshot that does not persist between runs, and an agreement here is agreement with the
 * firmware's logic rather than with a real +Drive's contents. A green test here is a reason to try
 * something on hardware with more confidence, never a reason to skip trying it.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { type ApiFrame, decodeMessage } from "@noiseandmatter/dnx-core/device/api.js";
import { type ApiTransport } from "@noiseandmatter/dnx-core/device/storagesession.js";

export class BridgeError extends Error {}

/** One line of the bridge's output, as it documents itself. */
interface BridgeReply {
  request: number;
  replies: string[];
  /** Bytes captured after the last `F7` — what a dropped piece looks like. Never repaired. */
  partial: string | null;
  icount: number;
  error: string | null;
}

export interface BridgeOptions {
  /** `sysex_bridge.exe`. Defaults to `DNX_SYSEX_BRIDGE`. */
  exe?: string;
  /** The OS image the emulator boots. Defaults to `DNX_EMU_FIRMWARE`. */
  firmware?: string;
  /** A saved UI state, which resumes in about a second instead of booting for ten. Defaults to `DNX_EMU_STATE`. */
  state?: string;
  /**
   * Working directory for the process, since the invocation uses relative paths. Defaults to
   * `DNX_EMU_CWD`, then to this process's.
   */
  cwd?: string;
  /** Emulator steps to wait after each call before giving up on a reply. */
  settle?: number;
  /** How long to wait for the process to say it is ready. */
  startupMs?: number;
}

/**
 * Where the bridge is, from the environment, or `undefined` when this machine has no emulator.
 *
 * **Paths are resolved against `cwd`, not against this process's.** The invocation the firmware
 * session documents uses paths relative to the emulator's own repository, and the child is spawned
 * there — so checking them here against wherever the test runner happens to be started reports a
 * missing firmware for a file that is sitting right next to the binary. Found by running it.
 */
export function bridgePaths(options: BridgeOptions = {}): { exe: string; firmware: string } | undefined {
  const exe = options.exe ?? process.env["DNX_SYSEX_BRIDGE"];
  const firmware = options.firmware ?? process.env["DNX_EMU_FIRMWARE"];
  if (!exe || !firmware) return undefined;

  const base = emulatorCwd(options);
  const at = (path: string): string => (isAbsolute(path) ? path : resolve(base, path));
  if (!existsSync(at(exe)) || !existsSync(at(firmware))) return undefined;
  // The child runs in `base`, so relative paths are handed on as given.
  return { exe, firmware };
}

/** Where the child runs. Every other relative path in the invocation is relative to this. */
function emulatorCwd(options: BridgeOptions): string {
  return options.cwd ?? process.env["DNX_EMU_CWD"] ?? process.cwd();
}

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");

function unhex(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "");
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new BridgeError(`the bridge returned something that is not hex: ${text.slice(0, 60)}`);
  }
  return new Uint8Array((clean.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
}

/**
 * A running bridge. One process, one request at a time, replies in order.
 *
 * **Requests are serialised deliberately.** The protocol is a line in and a line out, so two
 * overlapping requests would interleave and the second's reply would be attributed to the first.
 * A queue is one promise chain; getting this wrong is a bug that only appears under concurrency
 * and then looks like the device answering the wrong question.
 */
export class EmulatorBridge implements ApiTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly pending: ((line: BridgeReply | Error) => void)[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private fatal: Error | undefined;
  private closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.lines = createInterface({ input: child.stdout });

    this.lines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const waiting = this.pending.shift();
      if (!waiting) return;
      try {
        waiting(JSON.parse(trimmed) as BridgeReply);
      } catch {
        waiting(new BridgeError(`the bridge wrote a line that is not JSON: ${trimmed.slice(0, 120)}`));
      }
    });

    // **A fatal emulator error exits the process**, and a request waiting on a line that will
    // never come would otherwise hang until the test runner gave up. Failing the waiters with the
    // exit code says what happened.
    child.on("exit", (code) => {
      this.fatal ??= new BridgeError(`the bridge exited with code ${code}`);
      while (this.pending.length > 0) this.pending.shift()!(this.fatal);
    });
  }

  /** Start the bridge and wait for its ready line. */
  static async start(options: BridgeOptions = {}): Promise<EmulatorBridge> {
    const found = bridgePaths(options);
    if (!found) {
      throw new BridgeError(
        "no emulator bridge: set DNX_SYSEX_BRIDGE to sysex_bridge.exe and DNX_EMU_FIRMWARE to an " +
          "OS image, both of which must exist",
      );
    }

    const args = [
      found.firmware,
      ...((options.state ?? process.env["DNX_EMU_STATE"])
        ? ["--state", (options.state ?? process.env["DNX_EMU_STATE"])!]
        : []),
      "--call-at", "0x4002e464",
      "--call-fn", "0x4012166e",
      "--call-args", "2",
      "--capture", "0x401233f2:0:1",
      ...(options.settle === undefined ? [] : ["--settle", String(options.settle)]),
    ];

    const child = spawn(found.exe, args, {
      cwd: emulatorCwd(options),
      stdio: ["pipe", "pipe", "pipe"],
    });

    // stderr is the emulator's own noise. Kept rather than ignored: when a run fails, it is the
    // only thing that says why, and a silent failure here looks like a hung test.
    let noise = "";
    child.stderr.on("data", (chunk: Buffer) => { noise += chunk.toString(); });

    const bridge = new EmulatorBridge(child);
    await bridge.ready(options.startupMs ?? 60_000, () => noise);
    return bridge;
  }

  private ready(timeoutMs: number, noise: () => string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new BridgeError(
          `the bridge did not report ready within ${timeoutMs} ms` +
            (noise() ? `. It said: ${noise().slice(0, 400)}` : ""),
        ));
      }, timeoutMs);

      const onLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        this.lines.off("line", onLine);
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(trimmed) as { ready?: boolean };
          if (parsed.ready === true) resolve();
          else reject(new BridgeError(`the bridge's first line was not a ready: ${trimmed.slice(0, 120)}`));
        } catch {
          reject(new BridgeError(`the bridge's first line was not JSON: ${trimmed.slice(0, 120)}`));
        }
      };
      // Ahead of the queue handler, so the ready line is not taken for a reply.
      this.lines.prependListener("line", onLine);
    });
  }

  /**
   * Send one message and return every whole reply the firmware produced.
   *
   * The low-level form. `request` is the `ApiTransport` one and is what DNX's own code calls.
   */
  async exchange(bytes: Uint8Array, timeoutMs = 120_000): Promise<{ replies: ApiFrame[]; raw: Uint8Array[] }> {
    if (this.closed) throw new BridgeError("the bridge is closed");
    if (this.fatal) throw this.fatal;

    const run = async (): Promise<{ replies: ApiFrame[]; raw: Uint8Array[] }> => {
      const line = await new Promise<BridgeReply>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new BridgeError(`the bridge did not answer within ${timeoutMs} ms`)),
          timeoutMs,
        );
        this.pending.push((result) => {
          clearTimeout(timer);
          if (result instanceof Error) reject(result);
          else resolve(result);
        });
        this.child.stdin.write(`${hex(bytes)}\n`);
      });

      if (line.error) throw new BridgeError(`the bridge refused the request: ${line.error}`);
      /*
       * **Reported, never repaired**, exactly as the bridge does. Bytes after the last `F7` are
       * what a dropped piece looks like, and quietly discarding them would turn a transport fault
       * into a short reply that parses — which is the failure mode hardest to attribute later.
       */
      if (line.partial) {
        throw new BridgeError(
          `the firmware left ${unhex(line.partial).length} bytes after the last F7, so a reply is ` +
            `incomplete: ${line.partial.slice(0, 80)}`,
        );
      }

      const raw = line.replies.map(unhex);
      return { replies: raw.map((frame) => decodeMessage(frame)), raw };
    };

    // One at a time. The protocol is a line in and a line out; overlapping requests would have
    // their replies swapped, which looks exactly like the device answering the wrong question.
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * `ApiTransport`: send a message and return **the** reply to it.
   *
   * The contract is that the frame returned answers `msgId`, and here that is checked rather than
   * assumed. The bridge hands back the replies to this request by construction, so a mismatch
   * would mean the firmware answered with the wrong `respId` — which is worth hearing about
   * loudly, because every other transport in DNX relies on that field to tell its own replies from
   * the traffic Overbridge and Transfer put on the same port.
   *
   * **A reply's own `msgId` is the device's counter and has nothing to do with ours.** Matching on
   * it instead would work for exactly as long as the two counters happened to agree.
   */
  async request(bytes: Uint8Array, msgId: number, timeoutMs: number): Promise<ApiFrame> {
    const { replies } = await this.exchange(bytes, Math.max(timeoutMs, 30_000));
    if (replies.length === 0) {
      throw new BridgeError(
        `the firmware produced no reply to message ${msgId}. That is an explicit no-reply from the ` +
          `bridge rather than a timeout, so the handler either does not exist or declined it.`,
      );
    }
    const answer = replies.find((frame) => frame.respId === msgId);
    if (!answer) {
      throw new BridgeError(
        `asked for ${msgId} and got ${replies.length} reply/replies answering ` +
          `${replies.map((r) => r.respId ?? "nothing").join(", ")}`,
      );
    }
    return answer;
  }

  /** Stop the bridge. EOF on its stdin is how it is meant to end. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    this.lines.close();
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null) return resolve();
      this.child.once("exit", () => resolve());
      // It should exit on EOF. If it does not, do not hang a test suite over it.
      setTimeout(() => { this.child.kill(); resolve(); }, 5_000).unref();
    });
  }
}
