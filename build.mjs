// Builds a standalone, self-hosted site into dist/ from index.html (the single source file).
// - wraps the page in a full HTML document
// - serves mediabunny from /vendor instead of a CDN
// - moves the inline CSS and JS into files so a strict Content-Security-Policy works
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";

const src = readFileSync("index.html", "utf8");
const CDN = "https://cdn.jsdelivr.net/npm/mediabunny@1.62.0/dist/bundles/mediabunny.min.mjs";
if (!src.includes(CDN)) throw new Error("mediabunny import not found; update build.mjs");

const styleMatch = src.match(/<style>([\s\S]*?)<\/style>/);
const scriptMatch = src.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!styleMatch || !scriptMatch) throw new Error("expected exactly one <style> and one module <script>");

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 10);
const css = styleMatch[1];
const js = scriptMatch[1].replace(CDN, "./vendor/mediabunny.min.mjs");
const cssName = `app.${hash(css)}.css`, jsName = `app.${hash(js)}.js`;

const body = src
  .replace(styleMatch[0], "")
  .replace(scriptMatch[0], "")
  .replace(/<meta charset="utf-8">\s*/, "")
  .replace(/<title>[\s\S]*?<\/title>\s*/, "")
  .replace(/<meta name="claude:[^>]*>\s*/g, "")
  .replace(/<link rel="(preconnect|stylesheet)"[^>]*>\s*/g, "")
  .trim();

const title = src.match(/<title>([\s\S]*?)<\/title>/)[1];
const desc = "Upscale videos to 1080p, 2K or 4K in your browser. GPU-accelerated, private: files never leave your device.";
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta name="theme-color" content="#0d0f13" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f3f4f7" media="(prefers-color-scheme: light)">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
<link rel="icon" href="./favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<link rel="modulepreload" href="./vendor/mediabunny.min.mjs">
<link rel="stylesheet" href="./${cssName}">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}</style>
</head>
<body>
${body}
<noscript><p style="padding:16px">Lumen Upscaler needs JavaScript enabled.</p></noscript>
<script type="module" src="./${jsName}"></script>
</body>
</html>
`;

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/vendor", { recursive: true });
writeFileSync("dist/index.html", html);
writeFileSync(`dist/${cssName}`, css);
writeFileSync(`dist/${jsName}`, js);
cpSync("vendor", "dist/vendor", { recursive: true });
cpSync("public", "dist", { recursive: true });
console.log(`built dist/ → index.html, ${cssName}, ${jsName}, vendor/`);
