/**
 * What to call a Digitone 1 project once it has been opened.
 *
 * ## Why this is its own module rather than three lines inside `source.ts`
 *
 * Two reasons, and the second is the one that matters.
 *
 * It encodes a decision somebody asked about — *"In this case the project name and slot name are
 * the same, would they ever differ or are we just adding noise?"* They can differ, and the answer
 * below is why: they are two different things that are usually the same string.
 *
 * And `source.ts` reaches for MIDI. A Node test importing it would drag `MIDIInput` into a program
 * with no DOM, which is exactly how `devicesource.ts` came to fail `tsc`. Keeping the part worth
 * testing free of the part that needs a browser is what makes it testable at all.
 */

/**
 * The label for a project opened from a +Drive slot.
 *
 * **The drive name appears only when it disagrees with the project name.** The +Drive entry is the
 * file's name on the drive; the project name lives inside the image at offset 8. Renaming on one
 * side does not necessarily touch the other, and anything this tool stamps a build time into
 * changes the second and not the first — so when they differ, that difference is worth seeing.
 * When they agree, printing it twice is noise, which is how it was reported.
 */
export function slotLabel(projectName: string, driveName: string, slot: number): string {
  const prefix = projectName === driveName ? "" : `${driveName} · `;
  return `${prefix}slot ${slot}`;
}

/** What the top bar shows once a source is open: what it is, then where it came from. */
export function sourceBadge(projectName: string, label: string): string {
  return `${projectName} · ${label}`;
}
