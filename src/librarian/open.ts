/**
 * Opening a project into the manager — including opening a DN1 sketch *as* a DN2 project.
 *
 * ## Why this module exists
 *
 * The DN1-to-DN2 conversion is the reason this project started: sketch on the Digitone, finish
 * on the Digitone II with sixteen tracks and better arrangement tools. It is built,
 * byte-identical to Elektron's importer, and hardware-validated — but it lived at the end of
 * its own command, producing a file you then had to feed to a second command by hand.
 *
 * That made conversion look like a *destination*. It is not: it is **how a DN1 project enters
 * the manager**. This module makes that the shape of the code. Ask for a project, say whether
 * you want it as a DN2, and get back something the librarian can work on.
 *
 * ## What it deliberately does not do
 *
 * **Opening a `.dnprj` does not convert it by default.** The librarian handles both families,
 * and a DN1 project rearranged as a DN1 project is a real workflow — someone tidying their
 * Digitone has no interest in a DN2 file. Converting silently would take that away and hide a
 * lossy, one-way step behind an innocent verb. Conversion happens when asked for, and the
 * result says so.
 *
 * **The direction is one-way, permanently.** There is no DN2-to-DN1 path here and there should
 * not be: sixteen tracks do not fit in four, and 128 steps do not fit in 64. A converter that
 * silently discarded half a project would be worse than no converter.
 *
 * ## The template, and why it cannot be bundled
 *
 * Conversion is a transplant: the template supplies every byte of the 12.9 MB image we do not
 * model. We cannot ship one, because the only honest source is a project a real device wrote,
 * and the ones we hold are the author's own music. So it is located rather than embedded, the
 * same way the test corpus is — `DN_TEMPLATE`, then `DN_CORPUS`, then a sibling checkout.
 * Failing to find one is an error with a route out of it, never a guess.
 *
 * ## Node-only, and listed in `tsconfig.web.json`
 *
 * This module reads files, so it sits on the Node side of the split that lets the browser
 * share every byte of format knowledge with the CLI — `container.ts` is platform-free,
 * `projectfile.ts` is not. Anything here that the UI eventually needs has to move down into a
 * platform-free module first, taking a `Uint8Array` instead of a path.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeProjectImage } from "../project/dn2codec.js";
import { parseProject } from "../project/projectfile.js";
import type { ProjectManifest, ProjectPayload } from "../project/container.js";
import { mintProjectId, writeProjectId } from "../project/dn2image.js";
import { readProjectName } from "../project/dn1.js";
import { convertProject } from "../expand/convert.js";
import { PERCUSSION_LOW_RULES, planExpansion } from "../expand/plan.js";
import { type Device, deviceFor } from "./device.js";

export interface OpenOptions {
  /** Convert a DN1 project to DN2 on the way in. Ignored for a project that is already DN2. */
  asDn2?: boolean;
  /** Path to the DN2 project supplying the bytes conversion does not model. */
  template?: string;
  /** Give sound-locked sounds their own tracks on the DN2's sixteen. */
  expand?: boolean;
  /** Allocate expansion destinations per pattern rather than across the project. */
  compact?: boolean;
  /** Apply the percussion-low placement rules. */
  rules?: boolean;
  /** Give sounds sharing a first name-word one shared track. */
  aggregateByName?: boolean;
  /** Let expansion use tracks freed by unused MIDI tracks. */
  freeMidi?: boolean;
}

/** How the open project came to be, so nothing downstream has to guess. */
export interface Provenance {
  /** The file that was opened. */
  sourcePath: string;
  /** The name the source project carried. */
  sourceName: string;
  /** True when a DN1 project was converted on the way in. */
  converted: boolean;
  /** Set when converted. */
  templatePath?: string;
  /** The identity minted for a converted project, so a caller can report it. */
  projectId?: number;
  /** Set when converted with expansion. */
  expansion?: {
    soundsPromoted: number;
    trigsPromoted: number;
    tracksUsed: number[];
    /** Sounds that stay sound-locked because no track was free. Lossless, not a failure. */
    overflow: number;
  };
  /** Anything the conversion could not carry across. Empty is the normal case. */
  warnings: string[];
}

export interface OpenedProject {
  image: Uint8Array;
  device: Device;
  /** Carried so the result can be written back out as a valid project file. */
  manifest: ProjectManifest;
  payload: ProjectPayload;
  provenance: Provenance;
}

/** Raised where the caller can do something about it, rather than exiting from a library. */
export class OpenError extends Error {}

function read(path: string) {
  const { manifest, payload } = parseProject(new Uint8Array(readFileSync(path)));
  return { manifest, payload, image: decodeProjectImage(payload.raw).image };
}

/**
 * Where to look for a DN2 template, in order.
 *
 * Exported so an error message can list the places that were tried. Being told "not found" is
 * useless; being told where it looked is actionable.
 */
export function templateSearchPaths(): string[] {
  // `DN_TEMPLATE` names a file outright and ends the search: it is the most specific thing a
  // user can say, so nothing should quietly look past it.
  const explicit = process.env["DN_TEMPLATE"];
  if (explicit) return [explicit];

  // Then the corpus, following `test/corpus.ts`: **an explicit `DN_CORPUS` is authoritative.**
  // Falling back to a sibling folder when it is set but wrong would hide a configuration
  // error behind a file the user did not choose — and for a *template* that is worse than for
  // a test fixture, because the wrong template silently supplies 12.9 MB of someone else's
  // project to everything we write.
  const corpus = process.env["DN_CORPUS"];
  const root = corpus ?? join(process.cwd(), "..", "dn_sysex", "00_Examples");
  return [join(root, "02_DN2", "01_Projects", "EMPTY.dn2prj")];
}

/** The first template that exists, or `undefined`. */
export function findTemplate(): string | undefined {
  return templateSearchPaths().find((p) => existsSync(p));
}

/**
 * Open a project, converting a DN1 to DN2 when asked.
 *
 * The returned `manifest` and `payload` are always the ones the *output* needs: for a
 * conversion that means the template's, since the result is a DN2 file and its firmware
 * version, payload entry name and device signature must be the DN2's.
 */
export function openProject(path: string, options: OpenOptions = {}): OpenedProject {
  const source = read(path);
  const sourceDevice = deviceFor(source.image);

  if (!options.asDn2 || sourceDevice.kind === "dn2") {
    if (options.asDn2 && sourceDevice.kind === "dn2") {
      // Asking for a DN2 project as a DN2 project is a no-op, not an error — it keeps a
      // caller from having to branch on the device before it has opened the file.
    }
    return {
      image: source.image,
      device: sourceDevice,
      manifest: source.manifest,
      payload: source.payload,
      provenance: {
        sourcePath: path,
        sourceName: sourceDevice.projectName(source.image),
        converted: false,
        warnings: [],
      },
    };
  }

  const templatePath = options.template ?? findTemplate();
  if (!templatePath) {
    throw new OpenError(
      "Converting a Digitone 1 project needs a Digitone II project as a template — it " +
        "supplies every byte of the image the conversion does not model.\n" +
        "Pass --template <a.dn2prj>, or set DN_TEMPLATE. Looked in:\n" +
        templateSearchPaths()
          .map((p) => `  ${p}`)
          .join("\n") +
        "\nA blank project exported from the device is the cleanest choice.",
    );
  }

  const template = read(templatePath);
  if (deviceFor(template.image).kind !== "dn2") {
    throw new OpenError(`Template is not a Digitone II project: ${templatePath}`);
  }

  const plan = options.expand
    ? planExpansion(source.image, {
        useFreedMidiTracks: options.freeMidi ?? false,
        compactPerPattern: options.compact ?? false,
        aggregateByName: options.aggregateByName ?? false,
        ...(options.rules ? { rules: PERCUSSION_LOW_RULES } : {}),
      })
    : undefined;

  const { image, report } = convertProject(source.image, template.image, {
    ...(plan ? { plan } : {}),
  });

  // A converted project is a new project, so it gets its own identity rather than the
  // template's. Without this every file built from `EMPTY.dn2prj` claims to be `EMPTY` —
  // see `mintProjectId` for why the corpus says that is wrong.
  const id = mintProjectId();
  writeProjectId(image, id);

  return {
    image,
    device: deviceFor(image),
    manifest: template.manifest,
    payload: template.payload,
    provenance: {
      sourcePath: path,
      sourceName: readProjectName(source.image),
      converted: true,
      templatePath,
      projectId: id,
      ...(plan
        ? {
            expansion: {
              soundsPromoted: plan.assignments.length,
              trigsPromoted: report.trigsPromoted,
              tracksUsed: [...report.tracksUsed].sort((a, b) => a - b),
              overflow: plan.overflow.length,
            },
          }
        : {}),
      warnings: report.warnings
        .filter((w) => !w.message.includes("interpolated"))
        .map((w) => w.message),
    },
  };
}

/** One line saying what is open and how it got there, for the top of any CLI view. */
export function describeProvenance(p: Provenance): string {
  if (!p.converted) return `"${p.sourceName}"`;
  const bits = [`"${p.sourceName}" converted from Digitone 1`];
  if (p.expansion) {
    bits.push(
      `expanded onto ${p.expansion.tracksUsed.length} track(s): ` +
        `${p.expansion.soundsPromoted} sounds, ${p.expansion.trigsPromoted} trigs promoted` +
        (p.expansion.overflow ? `, ${p.expansion.overflow} still sound-locked` : ""),
    );
  }
  return bits.join(" — ");
}
