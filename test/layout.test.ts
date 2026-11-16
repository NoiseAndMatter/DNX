/**
 * The layout of each page, measured in a real browser at four window widths.
 *
 * A stylesheet test can say that a rule exists. It cannot say that a page scrolls sideways at
 * 480px, or that a button's label broke into two lines. Those were found by eye on 2026-11-15, and
 * this test is the measurement that found them, kept so that it runs again.
 *
 * It needs a browser, so it has a variable, as the emulator tests have:
 *
 * - `DNX_CHROME`: the path of chrome.exe or msedge.exe (any Chromium, version 105 or later)
 *
 * It also needs the built page (`npm run build:web`), because the scripts make the top bar. The
 * test starts the browser headless with a profile folder of its own, so it does not touch the
 * browser that is open on the desk. Each page is measured as it opens: no project, no instrument.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { requestPath, resolveStaticPath } from "../src/cli/staticpath.js";

const CHROME = process.env["DNX_CHROME"];
const ROOT = fileURLToPath(new URL("../web/", import.meta.url));
const BUILT = existsSync(join(ROOT, "dist"));
const skip = !CHROME || !existsSync(CHROME)
  ? "set DNX_CHROME to a Chromium browser to run the layout test"
  : !BUILT
    ? "build the page first: npm run build:web"
    : false;

const PAGES = ["index", "expander", "manager", "library", "probe"] as const;
const WIDTHS = [1500, 1110, 800, 480] as const;
const HEIGHT = 900;
const TYPES: Record<string, string> = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".wasm": "application/wasm", ".png": "image/png",
};

interface Measured {
  /** How far the page is wider than the window, in px. */
  sideways: number;
  /** Buttons whose label is on more than one line. A pattern cell is a button by design, and is not counted. */
  brokenLabels: string[];
  /** The bar with the most lines, and how many. */
  barLines: number;
  worstBar: string;
}

/** Runs in the page. Plain JavaScript in a string, because the browser gets it as text. */
const MEASURE = `(() => {
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : el.className ? "." + String(el.className).trim().split(/\\s+/)[0] : "");
  const root = document.documentElement;
  const brokenLabels = [];
  for (const el of document.querySelectorAll("button:not(.slot), .btn")) {
    if (!shown(el)) continue;
    const s = getComputedStyle(el);
    const line = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.45;
    const inner = el.getBoundingClientRect().height - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)
      - parseFloat(s.borderTopWidth) - parseFloat(s.borderBottomWidth);
    if (inner > line * 1.6) brokenLabels.push(name(el));
  }
  let barLines = 0, worstBar = "";
  for (const bar of document.querySelectorAll(".bar, .topbar")) {
    if (!shown(bar)) continue;
    const tops = new Set([...bar.children].filter(shown).map((k) => Math.round((k.getBoundingClientRect().top + k.getBoundingClientRect().bottom) / 2 / 12)));
    if (tops.size > barLines) { barLines = tops.size; worstBar = name(bar); }
  }
  return { sideways: Math.max(0, root.scrollWidth - root.clientWidth), brokenLabels, barLines, worstBar };
})()`;

/** The page's files over HTTP, as the dev server gives them, without its other routes. */
function serve(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const path = requestPath(request.url);
    const target = path === undefined ? undefined : resolveStaticPath(ROOT, path).path;
    if (!target || !existsSync(target) || !statSync(target).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": TYPES[extname(target)] ?? "application/octet-stream" });
    createReadStream(target).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, origin: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}` });
    });
  });
}

/** One page of the browser, spoken to over the DevTools protocol. */
class Tab {
  private next = 1;
  private readonly waiting = new Map<number, (result: unknown) => void>();
  private readonly events: ((method: string) => void)[] = [];
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; method?: string; result?: unknown };
      if (message.id !== undefined) this.waiting.get(message.id)?.(message.result);
      else if (message.method) for (const listener of this.events) listener(message.method);
    });
  }

  static async open(port: number): Promise<Tab> {
    const made = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
    const { webSocketDebuggerUrl } = (await made.json()) as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new Tab(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.next++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.waiting.set(id, resolve));
  }

  until(method: string): Promise<void> {
    return new Promise((resolve) => {
      const listener = (seen: string): void => {
        if (seen !== method) return;
        this.events.splice(this.events.indexOf(listener), 1);
        resolve();
      };
      this.events.push(listener);
    });
  }

  async measure(url: string, width: number): Promise<Measured> {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    const loaded = this.until("Page.loadEventFired");
    await this.send("Page.navigate", { url });
    await loaded;
    // The scripts build the top bar after the load event. Half a second is ten times what they take.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const answer = (await this.send("Runtime.evaluate", { expression: MEASURE, returnByValue: true })) as {
      result: { value: Measured };
    };
    return answer.result.value;
  }

  close(): void {
    this.socket.close();
  }
}

/** Start the browser headless, and give the port its DevTools listen on. */
async function startBrowser(profile: string): Promise<{ browser: ChildProcess; port: number }> {
  const browser = spawn(CHROME!, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
  ], { stdio: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  for (let tries = 0; tries < 100; tries++) {
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
      if (port > 0) return { browser, port };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser.kill();
  throw new Error("the browser did not open its DevTools port in 10 s");
}

test("each page fits its window at four widths", { skip, timeout: 120_000 }, async (t) => {
  const profile = mkdtempSync(join(tmpdir(), "dnx-layout-"));
  const { server, origin } = await serve();
  const { browser, port } = await startBrowser(profile);
  const tab = await Tab.open(port);
  await tab.send("Page.enable");
  t.after(async () => {
    tab.close();
    browser.kill();
    server.close();
    await new Promise((resolve) => browser.once("exit", resolve));
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  for (const page of PAGES) {
    for (const width of WIDTHS) {
      const at = `${page} at ${width}px`;
      const measured = await tab.measure(`${origin}/${page}.html`, width);

      await t.test(`${at}: no sideways scroll`, () => {
        assert.equal(measured.sideways, 0, `the page is ${measured.sideways}px wider than the window`);
      });
      // A group of buttons wraps inside when it is wider than the window.
      await t.test(`${at}: each button's label is on one line`, () => {
        assert.deepEqual(measured.brokenLabels, []);
      });
      await t.test(`${at}: no bar takes more than three lines`, () => {
        assert.ok(measured.barLines <= 3, `${measured.worstBar} takes ${measured.barLines} lines`);
      });
    }
  }
});
