# Static export and deploy guide

Reusable pattern for **Baffled Cat browser prototypes**: produce a versioned static build locally, then optionally upload to S3 (or compatible object storage) with sensible cache headers.

**This repo (Mandelbrot Zoomer):** project paths, S3 defaults, and smoke-tests are in [deploy.md](deploy.md). The packager scripts listed under [Intended file layout](#intended-file-layout-per-project) are implemented here. This file stays the shared mechanics reference.

---

## Goals

- Ship a **self-contained static folder** — no dev server, no `node_modules`, no fetch scripts at runtime.
- Keep every export in an **incrementing version folder** (`Export/Version1`, `Version2`, …) for diffing, rollback, and re-upload.
- **Bundle** ES-module JS (and minify CSS where applicable); do not concatenate modules as globals.
- **Version-stamp** assets with `?v=N` so long-lived cache headers are safe.
- **Separate data refresh from packaging** when the app depends on fetched snapshots (catalogs, manifests, etc.).
- Upload with **immutable cache** for versioned assets and **short cache** for `index.html`.
- **Verify** the live site reports the expected version after upload.

---

## Conventions

| Item | Convention |
| --- | --- |
| Export root | `Export/` at project root (gitignored) |
| Version folders | `Version1`, `Version2`, … (no zero-padding) |
| Next version | Highest existing `VersionN` + 1; start at `1` if none |
| Manifest | `Export/latest.json` written by the packager after a successful build |
| Public URL | `https://<bucket>/<prefix>/index.html` — prefix must match where users browse |

Do not mutate an old version folder in place. Always create the next number.

### `Export/latest.json`

After a successful export, write:

```json
{
  "version": 29,
  "dir": "Export/Version29",
  "exportedAt": "2026-08-28T08:08:22.257Z"
}
```

The upload wrapper reads this manifest so it uploads **the build that just finished**, not merely “the highest folder on disk”.

---

## Pipeline overview

```text
Source tree
    │
    ▼
1. (Optional) Refresh fetched data — separate command, not part of export
    │
    ▼
2. Choose next Export/VersionN
    │
    ▼
3. Bundle JS entry → app.bundle.min.js (esbuild / Rollup / Vite)
    │
    ▼
4. Emit / minify CSS → app.bundle.min.css
    │
    ▼
5. Copy or gzip runtime data assets into the export folder
    │
    ▼
6. Rewrite index.html for production (?v=N, bundle paths, asset-version global)
    │
    ▼
7. Write Export/latest.json
    │
    ▼
8. Smoke-test locally
    │
    ▼
9. (Optional) Upload Export/VersionN to hosting + verify remote version
```

---

## Development vs production entry

Typical dev `index.html`:

```html
<link rel="stylesheet" href="css/app.css" />
<script type="module" src="js/main.js"></script>
```

Production rewrite (version `N`):

```html
<link rel="stylesheet" href="app.bundle.min.css?v=N" />
<script>self.__APP_ASSET_VERSION__ = "N";</script>
<script type="module" src="app.bundle.min.js?v=N"></script>
```

Replace `__APP_ASSET_VERSION__` with a project-specific global name (Mandelbrot uses `__MANDELBROT_ASSET_VERSION__`). The loader uses it to append `?v=N` to runtime fetches when the app loads local data assets.

Use **page-relative paths** (no leading `/`) so the app works at a subpath such as `/myapp/`.

---

## Bundling

- **Entry:** project’s main module (e.g. `js/main.js`).
- **Format:** `esm`, `bundle: true`, `minify: true`.
- **Output:** `Export/VersionN/app.bundle.min.js`.
- **Fail hard** if bundling fails — do not ship an incomplete export.

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
| Packaging sources (`export-static.*`, `Export-Static.*`) | Not runtime |
| Docs, VCS, editor config | Not runtime |

Adjust per project; document extras in that project’s `deploy.md`.

---

## Upload (S3)

Upload **only** the latest `Export/VersionN` folder (not the whole `Export/` tree).

Default parameters (override per project):

| Parameter | Example |
| --- | --- |
| Bucket | `baffledcat.com` |
| Prefix | `mandelbrot/` (must match the public URL path) |
| Skip flag | `-SkipUpload` |

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

Wrapper should probe `aws sts get-caller-identity` before upload; on failure, run `aws login` and retry.

---

## Intended file layout (per project)

```text
MandelbrotViewer/
  index.html
  css/app.css
  js/main.js                 # entry
  export-static.mjs          # Node packager
  Export-Static.ps1          # Windows: export + optional upload
  Export-Static.cmd          # double-click entry → .ps1
  package.json               # esbuild (devDependency)
  Export/                    # generated; gitignored
    latest.json
    Version1/
    VersionN/
  deploy.md                  # Mandelbrot-specific notes
  deploy_guide.md            # this file
```

No `data/` folder in this project — shaders and UI ship inside the JS/CSS bundles.

---

## Commands (target UX)

```powershell
# Full export + upload
.\Export-Static.cmd

# Export only
.\Export-Static.ps1 -SkipUpload

# Custom destination
.\Export-Static.ps1 -S3Bucket "example.com" -S3Prefix "myapp/"

# Packager only
node export-static.mjs
```

Print the exact `aws s3` commands at the end of every export (even with `-SkipUpload`) for audit and manual runs.

### Local smoke-test

```powershell
npx --yes serve Export/VersionN -p 8080
```

Open `http://localhost:8080`. Use HTTPS or localhost for APIs that require a secure context.

---

## Export checklist (generic)

- [ ] Fetched data (if any) is the snapshot you intend to ship
- [ ] New `Export/VersionN` created; `Export/latest.json` updated
- [ ] No source trees / dev tooling in the version folder
- [ ] `index.html` references production bundles, not dev paths
- [ ] `?v=N` on JS/CSS (and runtime fetches that use the version global)
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
