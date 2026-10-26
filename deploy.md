# Mandelbrot Zoomer — deploy notes

Project-specific packaging and upload notes. Shared mechanics live in [deploy_guide.md](deploy_guide.md).

---

## App shape

| Item | Path / detail |
| --- | --- |
| Entry HTML | `index.html` |
| Module entry | `js/main.js` (imports iterators, GPU, UI, URL state) |
| Styles | `css/app.css` (single file; Google Fonts stay CDN `<link>`s) |
| Workers | None |
| Runtime fetches | Screenshots API only (`https://shots.baffledcat.com`) — not bundled |
| External fonts | Google Fonts (Fredoka, Inter, JetBrains Mono, Space Grotesk) |

No `data/` snapshots. WGSL shaders are string modules under `js/iterators/*.wgsl.js` and fold into the JS bundle.

---

## Data pipeline

No data snapshots. Screenshot catalog data is loaded live from the ScreenGrabber API (see [docs/screenshots.md](docs/screenshots.md)).

### ScreenGrabber SDK pull (every export)

Before bundling, `export-static.mjs` (and so `Export-Static.ps1`, with or without `-SkipUpload`) downloads

`https://raw.githubusercontent.com/dom767/ScreenGrabber/master/sdk/baffled-screenshots.js`

to `js/vendor/baffled-screenshots.js`. It runs before a release number is claimed.

- If the download fails (network, non-200, or the file doesn't export `createBaffledScreenshots`), the export **fails**. It never falls back to the checked-in copy.
- If the SDK changed, the vendored file is overwritten; commit it so source development matches what shipped. If it's unchanged (ignoring line endings), the file isn't touched.
- The checked-in copy stays in the repo for running from source; it's only refreshed by an export.

---

## Asset-version global

```js
self.__MANDELBROT_ASSET_VERSION__ = "N";
```

Set by the packager in production `index.html`. Reserved for future runtime asset fetches; the app currently has no versioned local data files.

---

## Default S3 destination

| Parameter | Value |
| --- | --- |
| Bucket | `baffledcat.com` |
| Prefix | `mandelbrot/` |
| Public URL | `https://baffledcat.com/mandelbrot/` |

Override with `-S3Bucket` / `-S3Prefix` on `Export-Static.ps1`.

WebGPU requires **HTTPS** (or `localhost`). The live site must stay on HTTPS.

---

## Commands

```powershell
# Full export + upload
.\Export-Static.cmd

# Export only
.\Export-Static.ps1 -SkipUpload

# Packager only
npm install
node export-static.mjs
```

Local smoke-test:

```powershell
npx --yes serve Export/VersionN -p 8080
```

Open `http://localhost:8080` in Chrome (WebGPU).

---

## Smoke-test checklist

- [ ] Canvas paints the Mandelbrot set (WebGPU init succeeds)
- [ ] Scroll zoom and drag pan work
- [ ] Settings panel: algorithm / iterations / AA / gradient change the view
- [ ] Bottom nav: Home, Settings, Orbit, Cloud, Shots, Fullscreen
- [ ] URL query updates while navigating; reload restores view
- [ ] Orbit panel plots under the cursor
- [ ] Shots panel can list / open shots (needs network + Turnstile config)
- [ ] Production `index.html` uses `app.bundle.min.js?v=N` and `app.bundle.min.css?v=N`
- [ ] After upload, live HTML contains `__MANDELBROT_ASSET_VERSION__` matching `N`

---

## What ships

| Export path | Role |
| --- | --- |
| `index.html` | Rewritten entry |
| `app.bundle.min.js` | Bundled app (includes vendored screenshots SDK + WGSL strings) |
| `app.bundle.min.css` | Minified `css/app.css` |

**Excluded:** `js/`, `css/`, `js/test/`, `baffledcat-screenshots/`, docs, `RunMandelbrot.cmd`, packaging scripts, `node_modules/`, nested `Export/`.

---

## Implementation status

| Script | Role |
| --- | --- |
| `export-static.mjs` | Next `Export/VersionN`, esbuild JS, minify CSS, rewrite HTML, `latest.json` |
| `Export-Static.ps1` | Runs packager; optional S3 sync + remote version check |
| `Export-Static.cmd` | Double-click → `.ps1` |
| `package.json` | Dev dependency: `esbuild` |
