import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { build } from "esbuild";

const cli = new URL(
  "./node_modules/@tailwindcss/cli/dist/index.mjs",
  import.meta.url,
).pathname;
function compileCss(input, output) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli, "-i", input, "-o", output, "--minify"],
      (error, _stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve();
      },
    );
  });
}
await fs.rm(new URL("./dist", import.meta.url), {
  recursive: true,
  force: true,
});
await fs.cp(
  new URL("./extension", import.meta.url),
  new URL("./dist", import.meta.url),
  { recursive: true },
);
const dist = new URL("./dist/", import.meta.url);
await Promise.all([
  compileCss(
    new URL("./extension/panel.css", import.meta.url).pathname,
    new URL("panel.css", dist).pathname,
  ),
  compileCss(
    new URL("./extension/workbench.css", import.meta.url).pathname,
    new URL("workbench.css", dist).pathname,
  ),
]);
await build({
  entryPoints: {
    workbench: new URL("./extension/workbench.js", import.meta.url).pathname,
    panel: new URL("./extension/panel.js", import.meta.url).pathname,
  },
  outdir: new URL("./dist", import.meta.url).pathname,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome116",
  minify: false,
});
await build({
  entryPoints: [
    new URL("./extension/content/runner.js", import.meta.url).pathname,
    new URL("./extension/content/replacement.js", import.meta.url).pathname,
  ],
  outdir: new URL("content", dist).pathname,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome116",
});
console.log("Extension built: " + new URL("./dist", import.meta.url).pathname);
