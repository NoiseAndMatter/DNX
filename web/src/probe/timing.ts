/**
 * Where the time went when something took longer than it should have.
 *
 * ## Why these belong together, and away from the page
 *
 * Every one of them exists because a write stalled and nobody could say what had stalled. They are
 * not part of writing: they are the instruments held against it, and they answer questions the
 * write itself cannot — *was the page even running?*, *what arrived while we were sending?*, *was
 * the tab in the background?*
 *
 * Keeping them beside `writeBack` made that hard to see, and made the one thing they have in common
 * invisible: **each returns a stopper, and every stopper must be called.** A watcher that outlives
 * the operation it measures reports on the next one, and a heartbeat that outlives its wait
 * rewrites a finished verdict — the same defect as the late-reply redraw this page has already
 * fixed once.
 *
 * ## What they established
 *
 * `watchVisibility` is the one that decided the stalls. Browsers throttle `setTimeout` in a
 * backgrounded tab, and a hardware test is exactly when the tab gets backgrounded — because the
 * tester is looking at the instrument. `visibilitychange` is not a timer and is not throttled, so
 * it stays accurate while everything around it is slowed down.
 *
 * ## No DOM beyond what it measures
 *
 * `tickWhileWaiting` takes a redraw callback rather than reaching for a card. It needs *something*
 * to happen each tick so a card pasted mid-stall is worth reading; it does not need to know what a
 * card is. That is also what lets the rest of this file be checked without a browser.
 */

/**
 * The longest the page stopped running, and how much arrived while it did.
 *
 * **Written because three theories have been wrong and the fourth should not be a theory.** The
 * measured facts: a 321ms settle takes minutes (152.8s, then 246.1s), the tab is visible with zero
 * hidden time, the read-back on the same page moments later takes 0.2s, and inbound project reads of
 * ~3 MB have never stalled. Outbound bulk is the only thing implicated.
 *
 * Two candidates remain, and these two numbers separate them without any argument:
 *
 * - **One enormous gap** — the main thread was blocked solid. Whatever `output.send()` sets in
 *   motion is holding the renderer, and no amount of timer discipline will help.
 * - **Many small gaps, with traffic** — the page is being flooded while it sends, and
 *   `renderCapture()` rebuilding the results DOM per message is eating it. A device echoing our own
 *   write back at us would explain both the duration and why it scales with the write.
 *
 * A 50ms interval, so a blocked thread shows as one gap of the stall's whole length rather than
 * being smeared across a slow poll.
 */
export function watchMainThread(): () => { longestGapMs: number; ticks: number } {
  const period = 50;
  let last = Date.now();
  let longest = 0;
  let ticks = 0;

  const timer = setInterval(() => {
    const now = Date.now();
    // The gap beyond what was asked for: a timer that fires on time contributes nothing.
    longest = Math.max(longest, now - last - period);
    last = now;
    ticks++;
  }, period);

  return () => {
    clearInterval(timer);
    return { longestGapMs: Math.max(0, Math.round(longest)), ticks };
  };
}

/**
 * What arrived on the input port during one operation.
 *
 * Its own listener rather than a count from the capture, because the capture is also what would be
 * doing the work being measured — and a counter that only runs when the thing it measures is idle
 * measures nothing.
 */
export function watchInbound(input: MIDIInput): () => { messages: number; bytes: number; kinds: string } {
  let messages = 0;
  let bytes = 0;
  // Counted by kind, because "7,279 messages" did not say what they were — and what they are
  // decides whether this is the instrument's own clock, an echo of our write, or something else.
  const kinds = new Map<string, number>();

  const onMessage = (event: MIDIMessageEvent): void => {
    if (!event.data) return;
    messages++;
    bytes += event.data.length;
    kinds.set(kindOf(event.data[0] ?? 0), (kinds.get(kindOf(event.data[0] ?? 0)) ?? 0) + 1);
  };

  input.addEventListener("midimessage", onMessage);
  return () => {
    input.removeEventListener("midimessage", onMessage);
    const kinds$ = [...kinds]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, n]) => `${n}× ${kind}`)
      .join(", ");
    return { messages, bytes, kinds: kinds$ };
  };
}

/** What a status byte is, in the terms this investigation needs. */
export function kindOf(status: number): string {
  if (status === 0xf0) return "SysEx";
  if (status === 0xf8) return "clock";
  if (status === 0xfe) return "active sensing";
  if (status === 0xfa || status === 0xfb || status === 0xfc) return "transport";
  if (status >= 0xf1 && status <= 0xff) return `system 0x${status.toString(16)}`;
  if (status >= 0x80) return `channel 0x${(status & 0xf0).toString(16)}`;
  return "continuation";
}

/** The two rows that say where a write's time went, when there is anything to say. */
export function timeGoesRow(
  thread: { longestGapMs: number; ticks: number },
  inbound: { messages: number; bytes: number; kinds: string },
): [string, string][] {
  const rows: [string, string][] = [];
  if (thread.longestGapMs > 500) {
    rows.push([
      "Page stopped for",
      `${(thread.longestGapMs / 1000).toFixed(1)}s in one go — the main thread was blocked that ` +
        `long, so nothing on this page ran, timers included. ${thread.ticks} tick(s) got through.`,
    ]);
  }
  if (inbound.messages > 0) {
    rows.push([
      "Arrived meanwhile",
      `${inbound.messages} message(s), ${inbound.bytes.toLocaleString()} bytes — ${inbound.kinds}. ` +
        `Arrived while we were ` +
        `sending, and each one used to redraw the whole capture.`,
    ]);
  }
  return rows;
}

/**
 * How long the tab spent hidden during one operation.
 *
 * **The measurement that decides what the stalled writes were.** Browsers throttle `setTimeout` in
 * a backgrounded tab — heavily, after a few minutes — and a hardware test is exactly when the tab
 * gets backgrounded, because the tester is looking at the instrument. Every observation so far fits
 * that: two stalls at *unrelated* awaits, one of them a 321ms timer that a device cannot influence,
 * and a run that finished on its own "after some time".
 *
 * `visibilitychange` is not a timer and is not throttled, so this stays accurate while everything
 * around it is slowed down. If the next stalled write reports no hidden time at all, the theory is
 * dead and the fault is somewhere nobody has looked yet — which is worth as much as confirming it.
 */
export function watchVisibility(): () => { hiddenMs: number; times: number } {
  let hiddenMs = 0;
  let times = 0;
  let since: number | undefined;

  if (document.visibilityState === "hidden") {
    since = Date.now();
    times = 1;
  }

  const onChange = (): void => {
    if (document.visibilityState === "hidden") {
      since = Date.now();
      times++;
    } else if (since !== undefined) {
      hiddenMs += Date.now() - since;
      since = undefined;
    }
  };

  document.addEventListener("visibilitychange", onChange);
  return () => {
    document.removeEventListener("visibilitychange", onChange);
    // Counted up to now if the tab is still hidden — a write read while the tab is away is the
    // whole case being measured, so it must not be lost by being unfinished.
    return { hiddenMs: hiddenMs + (since === undefined ? 0 : Date.now() - since), times };
  };
}

/** The log row for a hidden tab, or nothing when it stayed in view. */
export function hiddenRow(watched: { hiddenMs: number; times: number }): [string, string][] {
  // **A visible tab is reported too, and that is not symmetry for its own sake.** This measurement
  // exists to test one theory — that the stalls are `setTimeout` throttling in a backgrounded tab.
  // The note above `watchVisibility` says a negative result is worth as much as a positive one, and
  // it is: a stalled write with *no* hidden time kills the theory and sends the search somewhere
  // nobody has looked. Returning nothing said that in a way indistinguishable from not having
  // measured at all — on the one artefact anybody actually sends.
  if (watched.hiddenMs === 0) {
    return [
      [
        "Tab stayed visible",
        `Never hidden while this ran, so timer throttling does not explain anything here. If this ` +
          `still stalled, the cause is somewhere else.`,
      ],
    ];
  }
  return [[
    "Tab was hidden",
    `${(watched.hiddenMs / 1000).toFixed(1)}s across ${watched.times} period(s) — browsers throttle ` +
      `timers in a background tab, so a wait can take far longer than its timeout says. Keep this ` +
      `tab visible for a clean measurement.`,
  ]];
}

/**
 * Tick a "still waiting" line on the card until the wait finishes.
 *
 * **This is a diagnostic, and it earns its place.** Two stalled writes on hardware left their card
 * mid-log with no verdict, and the logs disagreed about which step was last — so the question was
 * not *why is this wait slow* but *is anything on this page still running at all*. A timer that
 * ticks answers that directly: a moving counter means the page is alive and the device has not
 * answered, while a frozen one means the page stopped and the wait is innocent.
 *
 * Returns the stopper. Always call it — a heartbeat that outlives its wait rewrites a finished
 * verdict, which is the same defect as the late-reply redraw this page already fixed once.
 */
export function tickWhileWaiting(
  log: [string, string][],
  label: string,
  /** Called on every tick, so a card pasted mid-stall shows a number that is still moving. */
  onTick: () => void,
): () => void {
  const period = 500;
  const startedAt = Date.now();
  let last = startedAt;
  let longestPause = 0;
  const row: [string, string] = [label, "0.0s"];
  log.push(row);

  /**
   * Elapsed, **and the longest this row has gone without updating**.
   *
   * The second half is what makes a card pasted mid-stall worth anything. Every report so far has
   * arrived while the write was still hanging, and the measurement rows are only appended once it
   * finishes — so "is the page alive right now?" had no answer in the one artefact anybody actually
   * sends. Now it does:
   *
   * - the number climbs smoothly and reports no pause — the page is running, and waiting
   * - the number is frozen where it was — the page is blocked, and that **is** the answer
   * - the number jumps, with a large pause — it was blocked and has come back
   */
  const describe = (suffix: string): string => {
    const elapsed = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    const pause = longestPause > 1000 ? ` · longest pause ${(longestPause / 1000).toFixed(1)}s` : "";
    return `${elapsed}${suffix}${pause}`;
  };

  const timer = setInterval(() => {
    const now = Date.now();
    longestPause = Math.max(longestPause, now - last - period);
    last = now;
    row[1] = describe(" and counting…");
    onTick();
  }, period);

  return () => {
    clearInterval(timer);
    row[1] = describe("");
  };
}
