import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  plugins: [tailwindcss()],
  root: path.join(dir, "extension"),
  server: {
    host: "127.0.0.1",
    port: 4192,
    fs: { allow: [dir] },
  },
});
