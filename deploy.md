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

Before bundling, `export-static.mjs` (used by **Build**, **Deploy Local**, **Deploy Prod**, and the older `Export-Static.ps1`) downloads

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

Override on **Deploy Prod** with `--bucket` / `--prefix` (or `S3_BUCKET` / `S3_PREFIX`), or `-S3Bucket` / `-S3Prefix` on the legacy `Export-Static.ps1`.

WebGPU requires **HTTPS** (or `localhost`). The live site must stay on HTTPS.

---

## Repository commands

Dashboard / double-click entry points (AgentController `repository-commands.md`):

| Action | What it does |
| --- | --- |
| **Build** (`Build.cmd` → `actions/Build.mjs`) | Local packager only — `export-static.mjs` without `--release` (no upload, no VERSION claim) |
| **Deploy Local** (`DeployLocal.cmd` → `actions/DeployLocal.mjs`) | Same local export, then serve that `Export/` folder (`PORT` or default `10001`) |
| **Deploy Prod** (`DeployProd.cmd` → `actions/DeployProd.mjs`) | `--release` (claims VERSION) + S3 sync/verify to `mandelbrot/` — **humans only**; agents never run this |

Shared helpers live in `scripts/repo-actions.mjs`. The packager itself stays `export-static.mjs`.

```powershell
.\Build.cmd                 # local Export/VersionN-localK
.\DeployLocal.cmd           # local export + serve (Ctrl+C to stop)
# Deploy Prod: humans only, from the dashboard or DeployProd.cmd
```

Legacy wrappers (still work):

```powershell
.\Export-Static.ps1 -SkipUpload   # same as Build (pack only)
.\Export-Static.cmd               # same as Deploy Prod (pack + upload)
npm install
node export-static.mjs            # packager only
```

Local smoke-test (or use **Deploy Local**):

```powershell
npx --yes serve Export/VersionN -p 10001
```

Open `http://127.0.0.1:10001` in Chrome (WebGPU).

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
| `actions/Build.mjs` | Local packager (no `--release`) |
| `actions/DeployLocal.mjs` | Local packager + serve export folder |
| `actions/DeployProd.mjs` | `--release` + S3 sync/verify (humans only) |
| `scripts/repo-actions.mjs` | Shared ensure-deps / packager / serve / S3 helpers |
| `export-static.mjs` | Next `Export/VersionN`, SDK refresh, esbuild JS, minify CSS, rewrite HTML, `latest.json` |
| `Export-Static.ps1` | Legacy: packager + optional S3 (prefer the actions above) |
| `Export-Static.cmd` | Legacy double-click → `.ps1` |
| `Build.cmd` / `DeployLocal.cmd` / `DeployProd.cmd` | Thin wrappers → `actions/*.mjs` |
| `package.json` | Dev dependency: `esbuild` |
