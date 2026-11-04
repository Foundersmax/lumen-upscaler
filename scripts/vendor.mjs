// Downloads the pinned third-party builds the app serves from /vendor, verifying each tarball's
// sha512 against the value pinned below. vendor/ is generated (gitignored): run this once after
// cloning, and CI runs it before building.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const PKGS = [
  { name: "mediabunny", version: "1.62.0",
    integrity: "sha512-D8E8BDxjCyqyrGj074jLRQNgilDW5izJu8o9pg7THMYMIZBL1Fao5hOtdDPDfA+nSnk68tMa8IaCJmz8hSpJpw==",
    files: { "dist/bundles/mediabunny.min.mjs": "mediabunny.min.mjs", "LICENSE": "mediabunny.LICENSE" } },
  { name: "@huggingface/transformers", version: "4.3.1",
    integrity: "sha512-5+voSeUCFK6PCKlY15dPhNOKq3/zOTxDN7oC+Wy9dFb1QZ0TSQomZRRy7URRK8YRuUoE9fGMQTTPC5d/pWBJhA==",
    files: { "dist/transformers.min.js": "transformers.min.js", "LICENSE": "transformers.LICENSE" } },
  { name: "onnxruntime-web", version: "1.31.0-dev.20260914-8d85527a0", // the exact version transformers.js 4.3.1 depends on
    integrity: "sha512-Iy7rtadoBgxS/LLvDr3QW38DB1PNXRnr0GJMcL0TAt7c9qjgVQl83UlGCVyeAnK2InpmW8Uc3PL8XIuqtDeF6g==",
    files: { "dist/ort-wasm-simd-threaded.asyncify.mjs": "ort/ort-wasm-simd-threaded.asyncify.mjs",
             "dist/ort-wasm-simd-threaded.asyncify.wasm": "ort/ort-wasm-simd-threaded.asyncify.wasm" } },
];

const OUT = "vendor";
const tmp = mkdtempSync(join(tmpdir(), "lumen-vendor-"));
try {
  for (const p of PKGS) {
    const targets = Object.values(p.files).map((f) => join(OUT, f));
    if (!process.argv.includes("--force") && targets.every(existsSync)) { console.log(`✓ ${p.name}@${p.version} (present)`); continue; }
    const [info] = JSON.parse(execFileSync("npm", ["pack", `${p.name}@${p.version}`, "--pack-destination", tmp, "--json", "--silent"], { encoding: "utf8" }));
    const tgz = join(tmp, info.filename);
    const got = "sha512-" + createHash("sha512").update(readFileSync(tgz)).digest("base64");
    if (got !== p.integrity) throw new Error(`Integrity mismatch for ${p.name}@${p.version}\n  expected ${p.integrity}\n  got      ${got}`);
    const dir = join(tmp, p.name.replace(/[@/]/g, "_"));
    mkdirSync(dir, { recursive: true });
    execFileSync("tar", ["-xzf", tgz, "-C", dir]);
    for (const [from, to] of Object.entries(p.files)) {
      mkdirSync(dirname(join(OUT, to)), { recursive: true });
      copyFileSync(join(dir, "package", from), join(OUT, to));
    }
    console.log(`↓ ${p.name}@${p.version} (verified)`);
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
