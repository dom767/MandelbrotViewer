# Mandelbrot Zoomer ? deploy notes

The repository follows AgentController `standards/guidelines/export.md` and
`repository-commands.md`. Each deploy packages its own build; there is no separate Build action.

## App shape

- Entry: `index.html`, `js/main.js`; stylesheet: `css/app.css`.
- esbuild bundles JS as minified ESM and minifies CSS into `app.bundle.min.js` and `app.bundle.min.css`.
- WGSL string modules are bundled. There are no workers or local data snapshots.
- Google Fonts remain external. Screenshot catalog/upload requests use `https://shots.baffledcat.com`.
- Ships only `index.html`, the two bundles and `build.json`.

## Repository commands

| Action | Behaviour |
| --- | --- |
| Run Local (`RunLocal.cmd`, `actions/RunLocal.mjs`) | Opens `StartServer.cmd` to serve the working tree without packaging. |
| Deploy Local (`DeployLocal.cmd`, `actions/DeployLocal.mjs`) | Requires a clean tree, replaces `Export/Local`, packages `0.0.C`, writes `build.json` and opens a static server. Never claims N. |
| Deploy Prod (`DeployProd.cmd`, `actions/DeployProd.mjs`) | Humans only. Requires a clean tree and HEAD on upstream after fetch; authenticates AWS, claims N, packages `Export/VersionN` as `0.N.C`, compares to Local, uploads and verifies. |

Run Local and Deploy Local use `PORT` or the app default `10001`. Close one server before starting the other. Agents use their assigned `PORT` (Task155: `7100`).

```powershell
.\RunLocal.cmd
.\DeployLocal.cmd
# Deploy Prod is for humans through the dashboard or DeployProd.cmd.
```

C is `git rev-list --count HEAD`, captured with the full source commit before the VERSION claim.
N is claimed on GitHub by `scripts/release-version.mjs`, using the highest of the remote VERSION,
local VERSION and existing `Export/VersionN` folders, plus one. Release folders are never overwritten.
A failed release can leave a skipped N. Old Export folders are left alone.

## ScreenGrabber SDK pull (every deploy)

`packageBuild({ dir, version })` in `actions/lib/build.mjs` refreshes
`js/vendor/baffled-screenshots.js` from
`https://raw.githubusercontent.com/dom767/ScreenGrabber/master/sdk/baffled-screenshots.js`.
Network errors, non-success responses and missing `createBaffledScreenshots` exports fail packaging.
If the SDK changes (ignoring line endings), packaging stops: commit the updated vendor file and retry.
The checked-in copy supports source development. See [screenshots.md](docs/screenshots.md).

## Versioning and manifests

Packaging writes the final version directly into HTML:

```js
self.__MANDELBROT_ASSET_VERSION__ = "0.N.C";
```

Local JS and CSS URLs carry `?v=0.N.C` (`0.0.C` locally). Bundles never contain the version.
`writeManifest` checks those URLs, then records version, n, c, full source commit, clean-tree status,
build time and SHA-256 hashes of shipped non-HTML files (excluding the manifest itself) in `build.json`.

Deploy Prod compares non-HTML hashes when `Export/Local/build.json` names the same source commit.
It prints ?bundles identical to the local build of <commit>? or warns for each differing file;
differences do not block upload. No local build is required for production.

## Production destination

- Bucket: `baffledcat.com`; prefix: `mandelbrot/`.
- Public URL: https://baffledcat.com/mandelbrot/
- Override with `--bucket` / `--prefix` or `S3_BUCKET` / `S3_PREFIX`.
- AWS CLI authentication is checked before claiming N; `aws login` runs if needed.
- Assets upload first with immutable year-long cache headers; `index.html` uploads last with a 60-second cache.
- Verification fetches public HTML without cache and requires the asset-version global to equal `0.N.C`.
- WebGPU requires HTTPS or localhost.

## Smoke-test checklist

- [ ] Canvas paints the Mandelbrot set; scroll zoom and drag pan work.
- [ ] Settings update algorithm, iterations, AA and gradient.
- [ ] Home, Settings, Orbit, Cloud, Shots and Fullscreen navigation works.
- [ ] URL state survives reload; Orbit follows the cursor.
- [ ] Shots lists/opens screenshots (network and Turnstile configuration required).
- [ ] Local HTML uses both bundles with `?v=0.0.C` and the matching asset-version global.
- [ ] `build.json` names the expected source and hashes the shipped bundles.
- [ ] Human production deployment verifies the live global equals `0.N.C`.
