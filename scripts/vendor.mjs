// Downloads the pinned third-party builds the app serves from /vendor, verifying each tarball's
// sha512 against the value pinned below. vendor/ is generated (gitignored): run this once after
// cloning, and CI runs it before building.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
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
             "dist/ort-wasm-simd-threaded.asyncify.wasm": "ort/ort-wasm-simd-threaded.asyncify.wasm",
             "dist/ort.webgpu.min.mjs": "ort/ort.webgpu.min.mjs", "package.json": "ort/package.json" /* MIT */ } },
  { name: "@mediapipe/tasks-vision", version: "1.1.1",
    integrity: "sha512-jwntgT5tzDrKOkqg6xNDNpRcTUnGvmylZE5DFnzPXossiWOIDdZX+C81LI75hlXhsG58YZW+lGzcmjH1qrQE/Q==",
    files: { "vision_bundle.mjs": "mediapipe/vision_bundle.mjs", "package.json": "mediapipe/package.json", // Apache-2.0 (no LICENSE file in the package)
             "wasm/vision_wasm_internal.js": "mediapipe/wasm/vision_wasm_internal.js", "wasm/vision_wasm_internal.wasm": "mediapipe/wasm/vision_wasm_internal.wasm",
             "wasm/vision_wasm_nosimd_internal.js": "mediapipe/wasm/vision_wasm_nosimd_internal.js", "wasm/vision_wasm_nosimd_internal.wasm": "mediapipe/wasm/vision_wasm_nosimd_internal.wasm" } },
];

// Plain files (not on npm), pinned by sha256.
const FILES = [
  // full-range BlazeFace: finds faces up to ~5 m away (the short-range model only sees selfie-distance faces)
  { url: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite",
    sha256: "3698b18f063835bc609069ef052228fbe86d9c9a6dc8dcb7c7c2d69aed2b181b", to: "mediapipe/blaze_face_full_range.tflite" },
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
  for (const f of FILES) {
    const target = join(OUT, f.to);
    if (!process.argv.includes("--force") && existsSync(target)) { console.log(`✓ ${f.to} (present)`); continue; }
    const dl = join(tmp, "dl.bin");
    execFileSync("curl", ["-fsSL", "--retry", "3", "-o", dl, f.url]); // curl honours the environment's proxy settings
    const got = createHash("sha256").update(readFileSync(dl)).digest("hex");
    if (got !== f.sha256) throw new Error(`Checksum mismatch for ${f.url}\n  expected ${f.sha256}\n  got      ${got}`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(dl, target);
    console.log(`↓ ${f.to} (verified)`);
  }
  // Privacy patch: MediaPipe batches usage statistics and POSTs them to odml.pa.googleapis.com,
  // with no option to turn that off. Lumen promises nothing leaves the device, so make the
  // logger's flush discard its queue. Fails loudly if a different version changes the code.
  const mp = join(OUT, "mediapipe/vision_bundle.mjs");
  if (existsSync(mp)) {
    let src = readFileSync(mp, "utf8");
    const MARK = "/*lumen:no-telemetry*/";
    if (!src.includes(MARK)) {
      const needle = "flush(t,e){if(this.error)";
      if (src.split(needle).length !== 2 || !src.includes("odml.pa.googleapis.com")) throw new Error("MediaPipe telemetry patch no longer applies; review vision_bundle.mjs before upgrading.");
      src = src.replace(needle, `flush(t,e){${MARK}this.i=[];t?.();return;if(this.error)`);
      writeFileSync(mp, src);
      console.log("✓ MediaPipe usage logging disabled");
    }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
