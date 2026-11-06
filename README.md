# Lumen

**Live:** https://wetnix.com · editor https://wetnix.com/edit/ · upscaler https://wetnix.com/upscale/

Private, in-browser video tools. Everything runs on the user's device (WebCodecs, WebGL2, WebGPU/WASM); files never leave it.

- **Edit** (`/edit/`): edit video by editing its transcript. On-device Whisper transcription with word timestamps, select words and press Delete to cut, one-click pause trimming and filler removal, undo/redo, playback that skips cuts, waveform timeline, export to MP4/WebM (optionally upscaled), captions (.srt) and transcript (.txt). Reframe to 9:16, 1:1 or 4:5 with on-device face tracking (MediaPipe BlazeFace full-range, CPU) and a camera-operator path: locked off when the speaker is still, smooth pans when they move, instant cuts on scene changes; live vertical preview and frame-accurate crop in export. Studio voice: on-device noise removal (noise profile learned from the file), a broadcast dynamic-mic voice tone (low cut, proximity warmth, presence lift, smooth top), de-esser, expander, compressor, and BS.1770 loudness normalisation to −14 / −16 LUFS with a −1 dBFS limiter; live preview through an AudioWorklet with hold-to-compare. Animated burned-in captions (6 styles: Highlight, Pop, Box, Clean, Reveal, One word; position, size, length, highlight colour) previewed live over the video. Transcription can be paused and continued later; double-click a word to fix its text; find in transcript with "cut all". Projects are saved in the browser and restored when the same file is reopened.
- **Upscale** (`/upscale/`): upscale video to 1080p, 2K or 4K with a GPU pipeline (Catmull-Rom with anti-ringing + contrast-adaptive sharpening) and a before/after preview.

## Develop
No bundler or dependencies to install. Fetch the pinned third-party builds once, then serve the repo root:

    node scripts/vendor.mjs         # downloads + verifies mediabunny, transformers.js, onnxruntime-web into vendor/
    python3 -m http.server 8000     # → http://localhost:8000/ and /edit/

## Layout
    index.html                    home page
    edit/, upscale/               tool pages
    src/engine/                   shared: GPU upscaler, chunked output sink, codecs/helpers
    src/upscale/main.js           Upscale page
    src/audio/                    voice DSP (dsp.js, shared by export, analysis, AudioWorklet preview and Node tests)
    src/edit/                     Edit page: transcript model, audio extraction, Whisper worker, export, storage
    src/styles/app.css            design tokens + components (light and dark)
    scripts/vendor.mjs            fetches pinned third-party builds (sha512-verified) into vendor/ (generated, not committed)

## Build and deploy
    node scripts/vendor.mjs && node build.mjs   # → dist/ (copies files, stamps ?v=<hash> on module URLs for cache busting)

Pushing to `main` deploys to GitHub Pages via `.github/workflows/pages.yml`. `netlify.toml`, `vercel.json` and `public/_headers` (strict CSP) are ready for other hosts. HTTPS is required.

Speech models download from Hugging Face on first use and are cached by the browser. Every page carries a Content-Security-Policy meta tag (GitHub Pages can't set headers) limiting connections to this site and Hugging Face; `scripts/vendor.mjs` also disables MediaPipe's built-in usage logging, which otherwise POSTs to Google.

## Browser support
Chrome, Edge and other Chromium browsers are fully supported. Safari and Firefox depend on their WebCodecs support; the app shows a message when something is missing.

Third-party licenses are copied into `vendor/` by the vendor script.
