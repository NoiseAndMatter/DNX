/**
 * Rendering concern: turn a plan into DOM.
 *
 * Pure in the sense that matters — it reads a plan and returns markup, and knows nothing
 * about files, conversion or events. Positions are named the way the device names them,
 * through the same helpers the hardware test sheet uses.
 */

import { patternName } from "../../src/sheet/naming.js";
import { escapeHtml } from "../../src/sheet/html.js";
import type { ExpansionPlan } from "../../src/expand/types.js";

/** Compact list of patterns: "A1, A2, B5 +3 more". */
function patternList(patterns: readonly number[], limit = 6): string {
  const shown = patterns.slice(0, limit).map(patternName).join(", ");
  return patterns.length > limit ? `${shown} +${patterns.length - limit} more` : shown;
}

export function renderPlan(plan: ExpansionPlan): string {
  const assignments = plan.assignments
    .map(
      (a) => `<tr>
      <td class="track">T${a.dn2Track}</td>
      <td>${escapeHtml(a.usage.name || "(unnamed)")}</td>
      <td class="num">${a.usage.trigCount}</td>
      <td class="from">${a.usage.sourceTracks.map((t) => `T${t + 1}`).join(", ")}</td>
      <td class="patterns">${patternList(a.usage.patterns)}</td>
    </tr>`,
    )
    .join("");

  const overflow = plan.overflow.length
    ? `<h3>Staying sound-locked <span class="muted">(${plan.overflow.length}, lossless)</span></h3>
       <ul class="overflow">${plan.overflow
         .map((u) => `<li>${escapeHtml(u.name || "(unnamed)")} <span class="muted">${u.trigCount} trigs</span></li>`)
         .join("")}</ul>`
    : `<p class="good">Every sound-locked sound gets its own track. Nothing stays behind.</p>`;

  const perPattern = plan.perPattern
    ? `<p class="muted">Compact: destinations allocated per pattern across ${plan.perPattern.size} patterns
       — a sound may sit on different tracks in different patterns.</p>`
    : "";

  return `
    <div class="stats">
      <div><strong>${plan.assignments.length}</strong><span>sounds promoted</span></div>
      <div><strong>${plan.promotedTrigs}</strong><span>trigs moved</span></div>
      <div><strong>${plan.overflow.length}</strong><span>left sound-locked</span></div>
      <div><strong>${plan.livePatterns.length}</strong><span>patterns with content</span></div>
    </div>
    ${perPattern}
    ${
      plan.unusedSourceTracks.length
        ? `<p class="muted">Reusing unused source track(s) ${plan.unusedSourceTracks
            .map((t) => `T${t + 1}`)
            .join(", ")} — no trigs anywhere and only the factory init sound.</p>`
        : ""
    }
    <table>
      <thead><tr><th>Track</th><th>Sound</th><th>Trigs</th><th>From</th><th>Patterns</th></tr></thead>
      <tbody>${assignments || `<tr><td colspan="5" class="muted">No sound locks to promote.</td></tr>`}</tbody>
    </table>
    ${overflow}`;
}

export function renderSummary(name: string, fileName: string, patterns: number): string {
  return `<strong>${escapeHtml(name)}</strong> <span class="muted">${escapeHtml(fileName)} · ${patterns} patterns with content</span>`;
}
