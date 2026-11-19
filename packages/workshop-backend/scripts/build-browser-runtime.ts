import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeOutputFile = resolve(packageDir, "src/generated/browser-export-runtime.txt");
const sanitizerOutputFile = resolve(packageDir, "src/generated/html-sanitizer-runtime.txt");
const pageOutputFile = resolve(packageDir, "src/generated/browser-export-page.js");

const runtimeResult = await build({
  entryPoints: [resolve(packageDir, "browser/browser-export-runtime.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2025",
  minify: true,
  write: false,
});
const pageResult = await build({
  entryPoints: [resolve(packageDir, "browser/browser-export-page.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2025",
  write: false,
});
const sanitizerResult = await build({
  entryPoints: [resolve(packageDir, "browser/html-sanitizer-runtime.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2025",
  minify: true,
  write: false,
});

// What an exported Cloudflare Worker project carries besides the gadget's own files
// (src/project-export.ts): its Worker and page runtime, copied as they are, and Cap'n Web for each
// side, with the version and licence it is redistributed under.
const capnwebDir = resolve(dirname(fileURLToPath(import.meta.resolve("capnweb"))), "..");
const projectRuntime = {
  worker: readFileSync(resolve(packageDir, "project-runtime/worker.js"), "utf8"),
  page: readFileSync(resolve(packageDir, "project-runtime/page.js"), "utf8"),
  capnwebBrowser: readFileSync(resolve(capnwebDir, "dist/index.js"), "utf8"),
  capnwebWorkers: readFileSync(resolve(capnwebDir, "dist/index-workers.js"), "utf8"),
  capnwebVersion: JSON.parse(readFileSync(resolve(capnwebDir, "package.json"), "utf8")).version as string,
  capnwebLicense: readFileSync(resolve(capnwebDir, "LICENSE.txt"), "utf8"),
};
writeIfChanged(
  resolve(packageDir, "src/generated/project-runtime.txt"),
  new TextEncoder().encode(JSON.stringify(projectRuntime)),
);

writeIfChanged(runtimeOutputFile, runtimeResult.outputFiles[0].contents);
writeIfChanged(sanitizerOutputFile, sanitizerResult.outputFiles[0].contents);
writeIfChanged(pageOutputFile, pageResult.outputFiles[0].contents);

function writeIfChanged(outputFile: string, bytes: Uint8Array) {
  const contents = new TextDecoder().decode(bytes);
  if (!existsSync(outputFile) || readFileSync(outputFile, "utf8") !== contents) {
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, contents);
  }
}
