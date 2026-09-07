/**
 * The rows a settings-style list is made of: a name, an explanation, and a control.
 *
 * These were written inside `settings.ts`, where they read as part of the settings sheet. None of
 * them knows anything about settings — `row` takes a label and an element, `segmented` takes
 * options and a callback. The second panel that wants a labelled toggle would have copied them,
 * and a copy is where two panels start looking different for no reason.
 *
 * The markup they produce is styled by `.set-group`, `.set-row` and `.seg` in `toolnav.css`.
 */

/** A named control with an explanation under the name. */
export function row(name: string, description: string, control: HTMLElement): HTMLElement {
  const el = document.createElement("div");
  el.className = "set-row";

  const label = document.createElement("span");
  label.className = "label";
  const title = document.createElement("b");
  title.textContent = name;
  const why = document.createElement("span");
  why.textContent = description;
  label.append(title, why);

  const holder = document.createElement("span");
  holder.className = "control";
  holder.append(control);

  el.append(label, holder);
  return el;
}

/**
 * A row of mutually exclusive choices, one pressed.
 *
 * `aria-pressed` rather than a radio group: these are buttons that act immediately, and a radio
 * group announces itself as something you complete and submit.
 */
export function segmented<T extends string>(
  options: readonly T[],
  labels: Record<T, string>,
  current: T,
  onPick: (value: T) => void,
): HTMLElement {
  const group = document.createElement("span");
  group.className = "seg";
  group.setAttribute("role", "group");

  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = labels[option];
    button.setAttribute("aria-pressed", String(option === current));
    button.addEventListener("click", () => {
      // `forEach` rather than `for..of`: a Node test imports this, and the Node tsconfig's lib has
      // no iterator on `NodeListOf`.
      group.querySelectorAll("button").forEach((other) => {
        other.setAttribute("aria-pressed", String(other === button));
      });
      onPick(option);
    });
    group.append(button);
  }
  return group;
}

/** A button that does something, handed itself so it can report what happened. */
export function action(
  label: string,
  onClick: (button: HTMLButtonElement) => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "act";
  button.textContent = label;
  button.addEventListener("click", () => onClick(button));
  return button;
}

/** A titled set of rows. */
export function group(title: string, rows: readonly HTMLElement[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "set-group";
  const heading = document.createElement("h4");
  heading.textContent = title;
  section.append(heading, ...rows);
  return section;
}
