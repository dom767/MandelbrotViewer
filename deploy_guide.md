# Static export and deploy guide

Reusable pattern for **Baffled Cat browser prototypes**: build a static package once, then deploy that same package locally or upload it to S3 (or compatible object storage) with sensible cache headers.

**This repo (Mandelbrot Zoomer):** project paths, S3 defaults, and smoke-tests are in [deploy.md](deploy.md). The packager scripts listed under [Intended file layout](#intended-file-layout-per-project) are implemented here. This file stays the shared mechanics reference.

---

## Goals

- Ship a **self-contained static folder** — no dev server, no `node_modules`, no fetch scripts at runtime.
- Keep every build (`Export/Build<k>`) and every release (`Export/VersionN`) in its own folder, for diffing, rollback, and re-upload.
- **Bundle** ES-module JS (and minify CSS where applicable); do not concatenate modules as globals.
- **Version-stamp** assets with `?v=N` so long-lived cache headers are safe.
- **Build once, deploy that build**: one unnumbered `Export/Build<k>`, stamped with a version only when it's deployed.
- **Separate data refresh from packaging** when the app depends on fetched snapshots (catalogs, manifests, etc.).
- Upload with **immutable cache** for versioned assets and **short cache** for `index.html`.
- **Verify** the live site reports the expected version after upload.

---

## Conventions

| Item | Convention |
| --- | --- |
| Export root | `Export/` at project root (gitignored) |
| Build folders | `Build1`, `Build2`, … made by **Build**, with `__VERSION__` still in the HTML |
| Release folders | `Version1`, `Version2`, … (no zero-padding): a stamped copy of a build, made by **Deploy Prod** |
| Local copies | `Build<k>-local`: the copy **Deploy Local** stamps with `b<k>-local` and serves; replaced each time |
| Release number | Kept on GitHub in `VERSION` (the last release). Deploy Prod claims the next number by committing and pushing only `VERSION` (`scripts/release-version.mjs`), so every machine shares one chain of numbers. Build and Deploy Local never use one up |
| Repository commands | `RunDev.cmd` / `Build.cmd` / `DeployLocal.cmd` / `DeployProd.cmd` → `actions/*.mjs` (see [deploy.md](deploy.md)) |
| Manifest | `Export/latest.json`, written by Build after a successful build |
| Public URL | `https://<bucket>/<prefix>/index.html` — prefix must match where users browse |

**Build once, deploy that build.** The deploys copy the latest build and only replace `__VERSION__` in its HTML; they never rebuild, so what goes live is byte for byte what Deploy Local served. Never overwrite a release folder, and never pick a release number from the folders on your machine: other machines release too.

### `Export/latest.json`

After a successful build, Build writes:

```json
{
  "build": 12,
  "dir": "Export/Build12",
  "builtAt": "2026-10-31T00:10:45.998Z",
  "source": { "commit": "8b1ba4f…", "uncommittedChanges": false }
}
```

Both deploys read it, so they deploy **the latest build**, not merely “the highest folder on disk”, and fail with "run Build first" if there isn't one. They print the build number and commit first; Deploy Prod warns if the build had uncommitted changes.

---

## Pipeline overview

```text
Source tree
    │
    ▼
1. (Optional) Refresh fetched data — separate command, not part of export
    │
    ▼
2. Build: refresh vendored SDKs, take the next Export/Build<k>
    │
    ▼
3. Bundle JS entry → app.bundle.min.js (esbuild / Rollup / Vite)
    │
    ▼
4. Emit / minify CSS → app.bundle.min.css
    │
    ▼
5. Copy or gzip runtime data assets into the build folder
    │
    ▼
6. Rewrite index.html for production (?v=__VERSION__, bundle paths, asset-version global "__VERSION__")
    │
    ▼
7. Write Export/latest.json
    │
    ▼
8. Deploy Local: stamp b<k>-local into Export/Build<k>-local and smoke-test it
    │
    ▼
9. Deploy Prod: claim VERSION N, stamp it into Export/VersionN, upload that folder + verify remote version
```

---

## Development vs production entry

Typical dev `index.html`:

```html
<link rel="stylesheet" href="css/app.css" />
<script type="module" src="js/main.js"></script>
```

Production rewrite, as Build leaves it:

```html
<link rel="stylesheet" href="app.bundle.min.css?v=__VERSION__" />
<script>self.__APP_ASSET_VERSION__ = "__VERSION__";</script>
<script type="module" src="app.bundle.min.js?v=__VERSION__"></script>
```

The deploys replace `__VERSION__` with `b<k>-local` (Deploy Local) or the release number `N` (Deploy Prod). Only HTML carries the version, so bundles are identical across deploys.

Replace `__APP_ASSET_VERSION__` with a project-specific global name (Mandelbrot uses `__MANDELBROT_ASSET_VERSION__`). The loader uses it to append `?v=N` to runtime fetches when the app loads local data assets.

Use **page-relative paths** (no leading `/`) so the app works at a subpath such as `/myapp/`.

---

## Bundling

- **Entry:** project’s main module (e.g. `js/main.js`).
- **Format:** `esm`, `bundle: true`, `minify: true`.
- **Output:** `Export/Build<k>/app.bundle.min.js`.
- **Fail hard** if bundling fails — do not leave an incomplete build.

Keep large runtime data **external** (fetched at load time) unless you intentionally want a single huge bundle. Do not inline multi‑MB JSON via the bundler’s JSON loader unless that is a deliberate trade-off.

### CSS

- Single stylesheet or a small chain — emit one `app.bundle.min.css` at the export root.
- External fonts/CDNs: either keep as `<link>` in HTML or document why they stay external.

---

## Runtime data assets

When the app `fetch`es JSON (or other files) at runtime:

| Environment | Typical pattern |
| --- | --- |
| Local dev | Plain `data/foo.json` |
| Production export | `data/foo.json.gz` (optional but recommended for large files) |

If using gzip in production:

- Ship **only** `.json.gz` in the export (omit uncompressed JSON).
- Set S3 `Content-Type: application/gzip`.
- **Do not** set `Content-Encoding: gzip` — the client decompresses with `DecompressionStream`.
- Append `?v=N` to fetch URLs when the asset-version global is set.

**Separate data refresh from export.** A flaky upstream API must not block a release build. Run fetch/import scripts explicitly before export when you want fresh data.

---

## What ships vs what stays in source

**Must ship (typical static app)**

| Export path | Role |
| --- | --- |
| `index.html` | Rewritten entry page |
| `app.bundle.min.js` | Bundled application |
| `app.bundle.min.css` | Styles |
| Runtime data / images | Whatever the app fetches or references |

**Must not ship**

| Exclude | Why |
| --- | --- |
| `js/` source tree | Folded into bundle |
| `css/` source (if emitted to root) | Avoid duplicate paths |
| `node_modules/`, `package.json` | Build-time only |
| Dev server scripts (`Start.cmd`, etc.) | Local only |
| Fetch / import scripts | Authoring, not runtime |
| `Export/` itself | Never nest exports |
| Packaging sources (`actions/`, `scripts/`, `*.cmd`) | Not runtime |
| Docs, VCS, editor config | Not runtime |

Adjust per project; document extras in that project’s `deploy.md`.

---

## Upload (S3)

Upload **only** the `Export/VersionN` folder Deploy Prod just stamped from the latest build (not the whole `Export/` tree).

Default parameters (override per project):

| Parameter | Example |
| --- | --- |
| Bucket | `baffledcat.com` |
| Prefix | `mandelbrot/` (must match the public URL path) |

### Cache headers

| Content | Cache-Control | Content-Type | Notes |
| --- | --- | --- | --- |
| `app.bundle.min.js`, `.css`, images | `public, max-age=31536000, immutable` | defaults | Safe with `?v=N` |
| `*.json.gz` | same | `application/gzip` | No `Content-Encoding` |
| `index.html` | `public, max-age=60` | `text/html; charset=utf-8` | Short TTL picks up new version stamp |

### Sync pattern (AWS CLI)

```powershell
# 1. Long-cache assets (exclude entry + gz catalogs)
aws s3 sync "Export/VersionN" "s3://bucket/prefix/" `
  --delete --exclude index.html --exclude "*.json.gz" `
  --cache-control "public, max-age=31536000, immutable"

# 2. Gzipped data
aws s3 sync "Export/VersionN" "s3://bucket/prefix/" `
  --exclude "*" --include "*.json.gz" `
  --content-type "application/gzip" `
  --cache-control "public, max-age=31536000, immutable"

# 3. Short-cache entry
aws s3 cp "Export/VersionN/index.html" "s3://bucket/prefix/index.html" `
  --cache-control "public, max-age=60" --content-type "text/html; charset=utf-8"
```

Use `--delete` only when the prefix is dedicated to this app. Do not sync into a shared prefix without a subdirectory.

### Post-upload verification

Fetch the public `index.html` and confirm the asset-version global matches `N`. Fail the script if it does not — catches wrong prefix, stale CDN edge, or upload to the wrong path.

### Secure context

Features like WebGPU, camera, geolocation, etc. require **HTTPS** (or `localhost`). Plain `http://` on a real hostname is not enough.

### AWS authentication

Deploy Prod probes `aws sts get-caller-identity` before upload; on failure, it runs `aws login` and retries. It does this before claiming a number, so a failed login doesn't use one up.

---

## Intended file layout (per project)

```text
MandelbrotViewer/
  index.html
  css/app.css
  js/main.js                 # entry
  StartServer.cmd            # dev server on the working tree (PORT or 10001)
  RunDev.cmd  Build.cmd  DeployLocal.cmd  DeployProd.cmd   # wrappers → actions/*.mjs
  actions/
    RunDev.mjs  Build.mjs  DeployLocal.mjs  DeployProd.mjs
    lib/build.mjs            # build/deploy helpers (AgentController template)
  scripts/
    repo-actions.mjs         # esbuild install, S3 sync + verify
    release-version.mjs      # VERSION claims on GitHub
  package.json               # esbuild (devDependency)
  Export/                    # generated; gitignored
    latest.json
    Build1/  BuildK/         # Build output, __VERSION__ in the HTML
    BuildK-local/            # Deploy Local's stamped copy
    Version1/  VersionN/     # Deploy Prod's stamped releases
  deploy.md                  # Mandelbrot-specific notes
  deploy_guide.md            # this file
```

No `data/` folder in this project — shaders and UI ship inside the JS/CSS bundles.

---

## Commands

```powershell
.\RunDev.cmd         # serve the working tree, no build
.\Build.cmd          # package Export/BuildK
.\DeployLocal.cmd    # stamp bK-local into Export/BuildK-local and serve it
.\DeployProd.cmd     # claim VERSION, stamp Export/VersionN, upload + verify (humans only)

# Custom destination for Deploy Prod
node actions/DeployProd.mjs --bucket example.com --prefix myapp/
```

Deploy Local is the smoke-test: it serves exactly the files Deploy Prod will upload, apart from the version stamp. Open `http://localhost:10001` (or your `PORT`). Use HTTPS or localhost for APIs that require a secure context.

---

## Export checklist (generic)

- [ ] Fetched data (if any) is the snapshot you intend to ship
- [ ] New `Export/Build<k>` created with `__VERSION__` in its HTML; `Export/latest.json` points at it
- [ ] Deploys copied the latest build (no rebuild); a release claimed its number on GitHub (`VERSION` pushed)
- [ ] No source trees / dev tooling in the build folder
- [ ] `index.html` references production bundles, not dev paths
- [ ] `?v=` on JS/CSS, filled in by the deploy (and runtime fetches that use the version global)
- [ ] Upload prefix matches the URL users visit
- [ ] Post-upload verification passed (if uploaded)
- [ ] Hosted URL is HTTPS if the app needs a secure context

---

## Per-project `deploy.md`

Mandelbrot’s notes are in [deploy.md](deploy.md). Other repos should cover the same sections:

1. **App shape** — entry HTML, module graph, workers, external fetches.
2. **Data pipeline** — what to refresh before export and how (`Fetch-Data.cmd`, etc.).
3. **Asset-version global name** — e.g. `__MANDELBROT_ASSET_VERSION__`.
4. **Default S3 bucket/prefix** and public URL.
5. **Smoke-test checklist** — features specific to that app.
6. **Implementation status** — which scripts exist in this repo.

Copy this `deploy_guide.md` into new projects; grow each repo’s `deploy.md` from the list above.
