# Lumen

**Live:** https://foundersmax.github.io/lumen-upscaler/

Private, in-browser video tools. Everything runs on the user's device (WebCodecs, WebGL2, WebGPU/WASM); files never leave it.

- **Edit** (`/edit/`): edit video by editing its transcript. On-device Whisper transcription with word timestamps, select words and press Delete to cut, one-click pause trimming and filler removal, undo/redo, playback that skips cuts, waveform timeline, export to MP4/WebM (optionally upscaled), captions (.srt) and transcript (.txt). Projects are saved in the browser and restored when the same file is reopened.
- **Upscale** (`/`): upscale video to 1080p, 2K or 4K with a GPU pipeline (Catmull-Rom with anti-ringing + contrast-adaptive sharpening) and a before/after preview.

## Develop
No bundler or dependencies to install. Fetch the pinned third-party builds once, then serve the repo root:

    node scripts/vendor.mjs         # downloads + verifies mediabunny, transformers.js, onnxruntime-web into vendor/
    python3 -m http.server 8000     # → http://localhost:8000/ and /edit/

## Layout
    index.html, edit/index.html   pages
    src/engine/                   shared: GPU upscaler, chunked output sink, codecs/helpers
    src/upscale/main.js           Upscale page
    src/edit/                     Edit page: transcript model, audio extraction, Whisper worker, export, storage
    src/styles/app.css            design tokens + components (light and dark)
    scripts/vendor.mjs            fetches pinned third-party builds (sha512-verified) into vendor/ (generated, not committed)

## Build and deploy
    node scripts/vendor.mjs && node build.mjs   # → dist/ (copies files, stamps ?v=<hash> on module URLs for cache busting)

Pushing to `main` deploys to GitHub Pages via `.github/workflows/pages.yml`. `netlify.toml`, `vercel.json` and `public/_headers` (strict CSP) are ready for other hosts. HTTPS is required.

Speech models download from Hugging Face on first use and are cached by the browser.

## Browser support
Chrome, Edge and other Chromium browsers are fully supported. Safari and Firefox depend on their WebCodecs support; the app shows a message when something is missing.

Third-party licenses are copied into `vendor/` by the vendor script.
