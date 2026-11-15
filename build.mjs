import fs from "node:fs/promises";
import { build } from "esbuild";
await fs.rm(new URL("./dist", import.meta.url), {
  recursive: true,
  force: true,
});
await fs.cp(
  new URL("./extension", import.meta.url),
  new URL("./dist", import.meta.url),
  { recursive: true },
);
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
console.log("Extension built: " + new URL("./dist", import.meta.url).pathname);
