/**
 * Inspect .dnprj / .dn2prj project files.
 *
 *   npm run project -- <file.dnprj> [...]
 *   npm run project -- --objects <file.dnprj>    list every object in the chain
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { isLengthValid, parseProject } from "../project/container.js";

function ascii(bytes: Uint8Array): string {
  return [...bytes].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
}

function inspect(path: string, showObjects: boolean): void {
  const { manifest, payload } = parseProject(new Uint8Array(readFileSync(path)));

  console.log(`\n${basename(path)}`);
  console.log(
    `  ${manifest.FileType} for product(s) [${manifest.ProductType.join(", ") || "none listed"}] ` +
      `OS ${manifest.FirmwareVersion}`,
  );
  console.log(
    `  payload "${manifest.Payload}" ${payload.raw.length} bytes  kind=${payload.kind} ` +
      `format=${payload.formatVersion} slot=${payload.slot} objVersion=${payload.objectVersion}`,
  );
  console.log(
    `  length ${isLengthValid(payload) ? "ok" : `MISMATCH (stored ${payload.storedLength}, expected ${payload.computedLength})`}` +
      `  check=0x${payload.checkField.toString(16).padStart(8, "0")}  objects=${payload.objects.length}`,
  );

  if (showObjects) {
    for (const obj of payload.objects) {
      const preview = ascii(obj.data.subarray(8, 32));
      console.log(
        `    @0x${obj.offset.toString(16).padStart(6, "0")} ` +
          `size=${String(obj.data.length).padStart(7)} v=${String(obj.version).padStart(10)}  |${preview}|`,
      );
    }
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const showObjects = argv.includes("--objects");
  const paths = argv.filter((a) => !a.startsWith("--"));

  if (paths.length === 0) {
    console.error("usage: npm run project -- [--objects] <file.dnprj> [...]");
    process.exit(1);
  }
  for (const path of paths) inspect(path, showObjects);
}

main();
