// Builds the static site into dist/. The app is plain ES modules (no bundler), so the build
// copies the pages, sources and vendored libraries, and stamps a version on module URLs
// so browsers pick up new code after each deploy.
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const COPY = ["index.html", "404.html", "edit", "upscale", "src", "vendor", "favicon.svg", "public/_headers"];
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
for (const p of COPY) cpSync(p, join("dist", p === "public/_headers" ? "_headers" : p), { recursive: true });

// Version = hash of all source files; appended to local .js/.css URLs in HTML and JS imports.
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const srcFiles = ["index.html", ...walk("edit"), ...walk("upscale"), ...walk("src")];
const v = createHash("sha256").update(srcFiles.map((f) => readFileSync(f)).join("")).digest("hex").slice(0, 10);
for (const f of walk("dist").filter((f) => /\.(html|js)$/.test(f) && !f.includes(`${join("dist", "vendor")}`))) {
  const s = readFileSync(f, "utf8")
    .replace(/((?:src|href)=")(\.{1,2}\/[^"?#]+\.(?:js|css))"/g, `$1$2?v=${v}"`)
    .replace(/(from\s+"|import\(\s*"|new URL\(\s*")(\.{1,2}\/[^"?#]+\.js)"/g, `$1$2?v=${v}"`);
  writeFileSync(f, s);
}
console.log(`built dist/ (version ${v})`);
