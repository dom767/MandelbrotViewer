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

### ScreenGrabber SDK pull (every build)

Before bundling, **Build** (`actions/Build.mjs`) downloads

`https://raw.githubusercontent.com/dom767/ScreenGrabber/master/sdk/baffled-screenshots.js`

to `js/vendor/baffled-screenshots.js`. The deploys never rebuild, so they ship whichever SDK the build bundled.

- If the download fails (network, non-200, or the file doesn't export `createBaffledScreenshots`), the build **fails**. It never falls back to the checked-in copy.
- If the SDK changed, the vendored file is overwritten; commit it so source development matches what shipped. If it's unchanged (ignoring line endings), the file isn't touched.
- The checked-in copy stays in the repo for running from source; it's only refreshed by Build.

---

## Asset-version global

```js
self.__MANDELBROT_ASSET_VERSION__ = "N";
```

Build writes it into production `index.html` as `"__VERSION__"` (as is every `?v=`); the deploys stamp it: `bK-local` for Deploy Local, the claimed release number for Deploy Prod. The bundles never contain the version. Reserved for future runtime asset fetches; the app currently has no versioned local data files.

---

## Default S3 destination

| Parameter | Value |
| --- | --- |
| Bucket | `baffledcat.com` |
| Prefix | `mandelbrot/` |
| Public URL | `https://baffledcat.com/mandelbrot/` |

Override on **Deploy Prod** with `--bucket` / `--prefix` (or `S3_BUCKET` / `S3_PREFIX`).

WebGPU requires **HTTPS** (or `localhost`). The live site must stay on HTTPS.

---

## Repository commands

Build once, deploy that build (AgentController `repository-commands.md`). Dashboard buttons and double-click wrappers:

| Action | What it does |
| --- | --- |
| **Run Dev** (`RunDev.cmd` → `actions/RunDev.mjs`) | Opens `StartServer.cmd` in its own window: serves the working tree, no build (`PORT` or `10001`) |
| **Build** (`Build.cmd` → `actions/Build.mjs`) | Refreshes the ScreenGrabber SDK, then packages `Export/BuildK` with `__VERSION__` left in `index.html`, and records it in `Export/latest.json`. No upload, no VERSION claim |
| **Deploy Local** (`DeployLocal.cmd` → `actions/DeployLocal.mjs`) | Copies the latest build to `Export/BuildK-local`, stamps `bK-local` and serves it in its own window (`PORT` or `10001`). Never rebuilds |
| **Deploy Prod** (`DeployProd.cmd` → `actions/DeployProd.mjs`) | Claims the next `VERSION` on GitHub, stamps it into `Export/VersionN`, syncs that to `mandelbrot/` and checks the live asset version. Never rebuilds. **Humans only**; agents never run this |

Both deploys fail with "No build yet: run Build first" when there's no build, and start their log with the build number, commit and build time. Deploy Prod warns when the build had uncommitted changes. Run Dev and Deploy Local use the same port, so close one before starting the other.

```powershell
.\RunDev.cmd                # dev server on the working tree
.\Build.cmd                 # Export/BuildK
.\DeployLocal.cmd           # serve Export/BuildK-local
# Deploy Prod: humans only, from the dashboard or DeployProd.cmd
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
- [ ] Deploy Local's `index.html` uses `app.bundle.min.js?v=bK-local` and `app.bundle.min.css?v=bK-local`, with no `__VERSION__` left
- [ ] After upload, live HTML contains `__MANDELBROT_ASSET_VERSION__` matching `N`

---

## What ships

| Export path | Role |
| --- | --- |
| `index.html` | Rewritten entry |
| `app.bundle.min.js` | Bundled app (includes vendored screenshots SDK + WGSL strings) |
| `app.bundle.min.css` | Minified `css/app.css` |

**Excluded:** `js/`, `css/`, `js/test/`, `baffledcat-screenshots/`, docs, `.cmd` scripts, `actions/`, `scripts/`, `node_modules/`, nested `Export/`.

---

## Implementation status

| Script | Role |
| --- | --- |
| `actions/RunDev.mjs` | Opens `StartServer.cmd` in a new window |
| `actions/Build.mjs` | SDK refresh, esbuild JS, minify CSS, rewrite HTML with `__VERSION__`, `Export/BuildK` + `latest.json` |
| `actions/DeployLocal.mjs` | Stamp `bK-local` into `Export/BuildK-local` and serve it |
| `actions/DeployProd.mjs` | Claim VERSION, stamp `Export/VersionN`, S3 sync + verify (humans only) |
| `actions/lib/build.mjs` | Shared build/deploy helpers (from the AgentController template) |
| `scripts/repo-actions.mjs` | esbuild install, AWS login, S3 sync + live-version check |
| `scripts/release-version.mjs` | Claims release numbers on GitHub (`VERSION`) |
| `StartServer.cmd` | Dev server on the working tree (`PORT` or `10001`) |
| `RunDev.cmd` / `Build.cmd` / `DeployLocal.cmd` / `DeployProd.cmd` | Thin wrappers → `actions/*.mjs` |
| `package.json` | Dev dependency: `esbuild`; `npm run build` = Build |
