/**
 * The library's one project list, as both of its halves fill it.
 *
 * Presets and Kits open a project from it; Wavetables read a project's pool from it. They used to
 * have a list each — the toolbar's and a *Pool of* dropdown inside the wavetable pane — which put
 * two lists of the same names on one screen, and the two had already drifted to different formats
 * (`24. PRESETS` and `024 PRESETS`). One function, so they cannot drift again.
 */

/**
 * The project loaded on the instrument.
 *
 * **Slot 0, and the only number here where 0 is not "the first of 128."** It has a pool — the one
 * the instrument is playing — and no file DNX can open, so Presets and Kits refuse it at Open while
 * Wavetables read it like any other.
 */
export const WORKING_PROJECT = 0;

export interface ListedProject {
  index: number;
  name: string;
}

/**
 * Fill `select` with the loaded project, then every stored one.
 *
 * Keeps `prefer` chosen when it is still listed, so re-listing does not move somebody off the
 * project they were looking at; otherwise the loaded project, which is the one being played.
 */
export function renderProjectList(
  select: HTMLSelectElement,
  projects: readonly ListedProject[],
  prefer?: number,
): void {
  const working = document.createElement("option");
  working.value = String(WORKING_PROJECT);
  working.textContent = "Working project";

  select.replaceChildren(
    working,
    ...projects.map((project) => {
      const option = document.createElement("option");
      option.value = String(project.index);
      // The slot first: it is what addresses the project and what the instrument's own screen
      // shows. A name alone is ambiguous — a +Drive can hold two projects called NEW PROJECT.
      // Trimmed: a slot with no name — a blank card, an unsaved slot — would otherwise end in a
      // space after its number.
      option.textContent = `${String(project.index).padStart(3, "0")} ${project.name}`.trimEnd();
      return option;
    }),
  );

  const listed = prefer !== undefined && projects.some((project) => project.index === prefer);
  select.value = String(listed ? prefer : WORKING_PROJECT);
}
