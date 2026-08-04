/**
 * Generate a hardware test sheet for a converted project.
 *
 *   npm run sheet -- --from a.dnprj --file b.dn2prj --out sheet.html
 *
 * Wiring only: read the two files, hand them to the collector, hand the model to the
 * renderer, write the page. The sheet describes what is in the output file, so it is worth
 * regenerating after every build rather than editing by hand.
 *
 * The page names the user's project and sounds, so write it beside the corpus, never into
 * this repository.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { cliArgs, readProjectImage } from "./args.js";
import { basename } from "node:path";
import { projectName } from "../project/dn2image.js";
import { collectSheet } from "../sheet/collect.js";
import { renderSheet } from "../sheet/render.js";


function main(): void {
  const { arg } = cliArgs();

  const fromPath = arg("from");
  const filePath = arg("file");
  const outPath = arg("out");
  const noteFile = arg("notes");

  if (!fromPath || !filePath || !outPath) {
    console.error("usage: npm run sheet -- --from <a.dnprj> --file <b.dn2prj> --out <sheet.html> [--notes <n.json>]");
    process.exit(1);
  }

  const dn1Image = readProjectImage(fromPath);
  const outImage = readProjectImage(filePath);
  const sheets = collectSheet(outImage, dn1Image);

  const callouts = noteFile ? JSON.parse(readFileSync(noteFile, "utf8")) : undefined;

  writeFileSync(
    outPath,
    renderSheet(sheets, {
      projectName: projectName(outImage),
      sourceFile: basename(fromPath),
      outputFile: basename(filePath),
      ...(callouts ? { callouts } : {}),
    }),
  );

  const expanded = sheets.reduce((n, s) => n + s.expandedCount, 0);
  console.log(`written: ${outPath}`);
  console.log(`  ${sheets.length} patterns with content, ${expanded} expanded track instances`);
}

main();
