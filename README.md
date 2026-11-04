# Lumen Upscaler

**Live:** https://foundersmax.github.io/lumen-upscaler/

Upscale videos to 1080p, 2K or 4K in the browser. Everything runs locally on the GPU (WebGL2 + WebCodecs); files never leave the device.

## Develop
`index.html` is the single source file. Open it through any local server:

    python3 -m http.server 8000

## Build
    node build.mjs        # → dist/ (no dependencies needed)

The build wraps the page in a full document, self-hosts mediabunny from `vendor/`, and splits CSS/JS into hashed files so the strict Content-Security-Policy in `public/_headers` / `vercel.json` works.

## Deploy
Any static host with HTTPS (required for WebCodecs):
- **GitHub Pages:** push to `main`; `.github/workflows/pages.yml` builds and deploys. In the repo settings set Pages → Source to "GitHub Actions".
- **Netlify:** connect the repo; `netlify.toml` is preconfigured. Or drag `dist/` onto app.netlify.com/drop.
- **Vercel:** import the repo; `vercel.json` is preconfigured.
- **Cloudflare Pages:** build command `node build.mjs`, output `dist`.

## Browser support
Chrome, Edge and other Chromium browsers are fully supported. Safari and Firefox depend on their WebCodecs support; the app shows a message when something is missing.

Video I/O by [mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0, see `vendor/`).
