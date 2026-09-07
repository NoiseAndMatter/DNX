/**
 * The smallest markdown a help page needs, and nothing else.
 *
 * ## Why not a library
 *
 * DNX has **no runtime dependencies**, and a help renderer is a poor reason to acquire the first
 * one. What the help pages actually use is headings, bold, code, links, bullets, ordered lists,
 * tables and blockquotes. That is a hundred lines, and the alternative is 40 KB shipped to a
 * musician so a `?` can render a bold word.
 *
 * ## Every string that reaches HTML is escaped first
 *
 * The source is written by this project, so nothing here is hostile. It is escaped anyway: the day
 * a help body is built from a project name or a device's own error text is the day the assumption
 * changes, and a renderer that was only safe because of who called it is not safe.
 *
 * ## Soft-wrapped lines are folded
 *
 * Help bodies are written as wrapped prose in source. Treating each source line as its own block
 * turns a bullet that wraps into a one-item list plus a detached paragraph, so a continuation line
 * joins the one above it. Fenced blocks and table rows are left alone.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** Inline: code first, so nothing inside backticks is read as markup. */
function inline(text: string): string {
  const code: string[] = [];
  // The placeholder is written as an escape rather than a literal byte. A NUL in source prints as
  // nothing in a terminal, a diff and a review, which is how three regexes in this repository ended
  // up matching nothing at all; `test/sourcehygiene.test.ts` caught this one within the hour.
  let out = text.replace(/`([^`]+)`/g, (_m, body: string) => {
    code.push(`<code>${escape(body)}</code>`);
    return `\u0000${code.length - 1}\u0000`;
  });

  out = escape(out);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) =>
    // Only http(s) and in-page anchors. A `javascript:` href in help text would be a strange bug
    // to have, and refusing it costs one regex.
    /^(https?:\/\/|#|\/)/.test(href) ? `<a href="${href}" target="_blank" rel="noopener">${label}</a>` : label);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");

  return out.replace(/\u0000(\d+)\u0000/g, (_m, at: string) => code[Number(at)]!);
}

/** Join a wrapped line onto the one above it, so a bullet stays one bullet. */
function fold(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let fenced = false;

  for (const line of lines) {
    const text = line.trim();
    if (text.startsWith("```")) { fenced = !fenced; out.push(line); continue; }
    if (fenced) { out.push(line); continue; }

    const opensBlock = text === ""
      || /^#{1,6}\s/.test(text)
      || /^[-*]\s/.test(text)
      || /^\d+\.\s/.test(text)
      || text.startsWith(">")
      || text.includes("|");
    const previous = out.at(-1) ?? "";
    const joinable = out.length > 0 && previous.trim() !== "" && !previous.trim().startsWith("#");

    if (!opensBlock && joinable) out[out.length - 1] = `${previous.replace(/\s+$/, "")} ${text}`;
    else out.push(line);
  }
  return out.join("\n");
}

function tableRow(line: string, cell: "td" | "th"): string {
  const cells = line.trim().replace(/^\||\|$/g, "").split("|");
  return `<tr>${cells.map((c) => `<${cell}>${inline(c.trim())}</${cell}>`).join("")}</tr>`;
}

/** Markdown to HTML. Block level, then inline within each block. */
export function mdToHtml(source: string): string {
  const lines = fold(source).split("\n");
  const out: string[] = [];
  let at = 0;

  while (at < lines.length) {
    const line = lines[at]!;
    const text = line.trim();

    if (text === "") { at++; continue; }

    if (text.startsWith("```")) {
      const body: string[] = [];
      at++;
      while (at < lines.length && !lines[at]!.trim().startsWith("```")) body.push(lines[at++]!);
      at++;
      out.push(`<pre><code>${escape(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(text);
    if (heading) {
      const level = Math.min(heading[1]!.length + 2, 6);
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      at++;
      continue;
    }

    // A table needs its separator row, or a sentence with a pipe in it becomes a table.
    if (text.includes("|") && /^\s*\|?[\s:-]*\|[\s:|-]*$/.test(lines[at + 1] ?? "")) {
      const head = tableRow(line, "th");
      at += 2;
      const body: string[] = [];
      while (at < lines.length && lines[at]!.includes("|")) body.push(tableRow(lines[at++]!, "td"));
      out.push(`<table><thead>${head}</thead><tbody>${body.join("")}</tbody></table>`);
      continue;
    }

    if (/^[-*]\s/.test(text) || /^\d+\.\s/.test(text)) {
      const ordered = /^\d+\.\s/.test(text);
      const items: string[] = [];
      while (at < lines.length) {
        const item = lines[at]!.trim();
        const match = ordered ? /^\d+\.\s+(.*)$/.exec(item) : /^[-*]\s+(.*)$/.exec(item);
        if (!match) break;
        items.push(`<li>${inline(match[1]!)}</li>`);
        at++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    if (text.startsWith(">")) {
      const body: string[] = [];
      while (at < lines.length && lines[at]!.trim().startsWith(">")) {
        body.push(lines[at++]!.trim().replace(/^>\s?/, ""));
      }
      out.push(`<blockquote>${inline(body.join(" "))}</blockquote>`);
      continue;
    }

    out.push(`<p>${inline(text)}</p>`);
    at++;
  }

  return out.join("");
}
