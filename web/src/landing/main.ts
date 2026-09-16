/**
 * The landing page: the boot animation, which version this is, and the one piece of setup worth
 * doing before anybody connects an instrument.
 *
 * ## Why a page and not a splash
 *
 * The renderer's reveal lasts a few seconds and its **idle never ends** — `resolve()` is
 * documented as *"Idle remains animated"*. A splash has to get out of the way; this was built to
 * stay, so it is given a page. The expander, which used to be the site root, moved to
 * `expander.html`; the tool row's order is unchanged.
 *
 * ## The three states a visit can be in
 *
 * | | reveal | setup card |
 * |---|---|---|
 * | nothing stored about a previous run | **7,000 ms** | choose the DNX folder |
 * | been here before | **3,500 ms** | where files go, and where to change it |
 * | asked to skip it | none | the reminder only |
 *
 * The first row is the owner's definition of a first run: *no data about previous runs*. It is the
 * same question the setup card asks, so `seen.ts` answers both and the two cannot disagree.
 */

import { DNXLoader } from "./dnxloader.js";
import { DNX_BUILD } from "../version.js";
import { browserSupport, folderNote, unsupportedMessage } from "./browsercheck.js";
import { bootDurationMs, isFirstRun, readSkipBoot, rememberSeen, writeSkipBoot } from "./seen.js";
import { chooseFolder, folderState, folderSupported } from "../dnxfolder.js";
import { renderToolNav } from "../toolnav.js";
import { $ } from "../dom.js";

/**
 * The animation, as the owner set it on the tuning bench on 2026-09-16.
 *
 * **These numbers were chosen by eye against the real renderer and are not to be re-derived.**
 * `durationMs` is the exception and is decided per visit; everything else is theirs.
 */
const BOOT = {
  idleGlitch: 0.89,
  glow: 0.86,
  scanlines: true,
  fps: 60,
  maxDpr: 2.5,
  seed: 26,
  autoplay: true,
  respectReducedMotion: true,
} as const;

renderToolNav($("toolnav"), "landing");

$("version").textContent = DNX_BUILD;

/* ---- can this browser do it at all ------------------------------------------------------ */

const support = browserSupport();
const stop = unsupportedMessage(support);
if (stop) {
  const el = $("unsupported");
  el.textContent = stop;
  el.hidden = false;
}

/* ---- the animation ----------------------------------------------------------------------- */

/*
 * **Mounted even when the reveal is skipped**, at a length of nothing, so the page still carries
 * its own logo rather than an empty box. The renderer draws the settled art when it is not
 * animating, which is also what it shows to a reader who asked their system for less motion.
 */
const canvas = $("boot") as HTMLCanvasElement;
const skipping = readSkipBoot();
const loader = new DNXLoader(canvas, { ...BOOT, durationMs: skipping ? 1 : bootDurationMs() });
if (skipping) loader.resolve(0);

/*
 * **Remembered when the reveal has actually finished**, not on load. Somebody who closes the tab
 * during the long first reveal has not seen it, and should get it again — the alternative is a
 * first impression cut in half and never offered a second time.
 */
const firstRun = isFirstRun();
setTimeout(rememberSeen, skipping ? 0 : bootDurationMs());

/* ---- the setup card ------------------------------------------------------------------------ */

/**
 * One card, two jobs: offer the folder the first time, and afterwards say where files go.
 *
 * **Read from what the browser says now, never from a "setup done" flag.** A stored directory
 * handle can have its permission revoked, and a flag would mean the offer is never made again
 * while every file quietly goes back to the downloads folder. `folderState` asks the browser.
 */
async function drawSetup(): Promise<void> {
  const card = $("setup");
  card.replaceChildren();
  card.hidden = false;

  if (!support.usable) {
    card.hidden = true;
    return;
  }

  if (!folderSupported()) {
    // Cannot happen while DNX is Chromium-only, and said rather than assumed away.
    card.append(say(folderNote(support) || "Files will go to your downloads."));
    return;
  }

  const state = await folderState().catch(() => ({ kind: "none" } as const));
  const set = state.kind === "set" && state.permission === "granted";
  card.dataset["first"] = String(!set);

  if (set) {
    const where = document.createElement("span");
    where.className = "land-where";
    where.textContent = state.name;
    const line = say("Files go to ");
    line.append(where, document.createTextNode(" · change it in Settings."));
    card.append(line);
    return;
  }

  card.append(
    say(
      state.kind === "set"
        ? `DNX still remembers the folder ${state.name}, but the browser has withdrawn permission. ` +
          "Choose it again, or anything goes to your downloads."
        : "Choose a folder and DNX keeps everything it makes in it — exports, backups, and the copy " +
          "it takes before writing to an instrument. Without one, every file becomes a download.",
    ),
    chooseButton(),
  );
}

function say(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.textContent = text;
  return p;
}

function chooseButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Choose a folder…";
  button.addEventListener("click", () => {
    chooseFolder().then(
      () => void drawSetup(),
      (error: unknown) => {
        // Closing the picker is an answer, not a failure — the same reading Settings takes.
        const refusal = error as { name?: string; message?: string };
        if (refusal.name === "AbortError" && /user aborted/i.test(refusal.message ?? "")) return;
        const note = say(refusal.message ?? "The folder could not be opened.");
        note.className = "land-note";
        $("setup").append(note);
      },
    );
  });
  return button;
}

void drawSetup();

/* ---- skipping it next time ------------------------------------------------------------------ */

/*
 * Offered here as well as in Settings, because this is the page somebody is on when they decide
 * they have seen enough of it. It is the same preference either way.
 */
const row = $("skiprow");
const toggle = document.createElement("label");
const box = document.createElement("input");
box.type = "checkbox";
box.id = "skipboot";
box.checked = skipping;
box.addEventListener("change", () => writeSkipBoot(box.checked));
toggle.append(box, document.createTextNode(" Go straight to the tools next time"));
row.append(toggle);
if (firstRun) {
  row.append(
    document.createTextNode(" · This is the long version; later visits are shorter."),
  );
}
