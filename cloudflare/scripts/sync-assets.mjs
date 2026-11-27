import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const srcDir = resolve(root, "../host/static");
const destDir = resolve(root, "public");

const FILES = [
  "index.html",
  "app.js",
  "style.css",
  "font-coverage.json",
  "favicon.ico",
];

mkdirSync(destDir, { recursive: true });
for (const name of FILES) {
  copyFileSync(resolve(srcDir, name), resolve(destDir, name));
}
console.log(`Synced ${FILES.length} static assets from host/static -> cloudflare/public`);
