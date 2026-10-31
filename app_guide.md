# Graphical app guide

General principles for **Baffled Cat browser prototypes** — interactive maps, viewers, and visual tools. Copy this file into new projects alongside [deploy_guide.md](deploy_guide.md) and [style_guide.md](style_guide.md).

Each project adds its own README, `rendering.md` (if GPU-heavy), and `deploy.md` for specifics. This guide is the shared baseline.

---

## Philosophy

Build **small, inspectable prototypes** that ship as static files. Prefer browser-native APIs and plain modules over frameworks. Keep runtime dependencies at zero (or near zero). Use Node only at build time and for optional data-import scripts.

A prototype should be understandable by opening `index.html`, `css/app.css`, and `js/main.js` — not by tracing a framework bootstrap chain.

---

## Stack defaults

| Layer | Default | Avoid for prototypes |
| --- | --- | --- |
| Markup | Plain HTML in `index.html` | JSX, templating engines, SSR |
| Style | One `css/app.css` with `:root` tokens | CSS-in-JS, Tailwind (unless you already standardise on it), component libraries |
| Logic | ES modules (`type="module"`) | Global script tags, IIFE concatenation |
| Graphics | WebGPU or WebGL2 directly | Three.js, Babylon, PlayCanvas — heavy for a first pass |
| UI | DOM overlays + small classes | React, Vue, Svelte, Lit |
| Build (dev) | None — serve source as-is | Webpack dev server, Vite HMR (add only if pain justifies it) |
| Build (release) | esbuild bundle + minify | Full SPA frameworks, code-splitting routers |
| Runtime deps | **None** in `dependencies` | Anything that ships to the browser via npm |
| Dev deps | esbuild, fetch helpers (e.g. undici) | Framework CLI tooling |

**Rule:** if a library mostly re-exports platform APIs or hides types you need to control (blending, instancing, picking), write the thin layer yourself.

---

## Project shape

```text
myapp/
  index.html              # App shell: canvas + overlay DOM (panels, HUD, nav)
  css/app.css             # All UI chrome; design tokens in :root
  js/
    main.js               # Entry: init GPU, wire UI, game loop
    render/               # GPU passes, shaders, scene graph
    ui/                   # DOM components (classes, no framework)
    data/loader.js        # fetch + dev/prod paths
    content/              # Copy, tours, notes — data-ish, not render logic
    astro/ | math/ | …    # Domain logic, pure functions where possible
  data/                   # Snapshots consumed at runtime (JSON)
  scripts/                # Node import/fetch (never shipped)
  images/
  rendering.md            # Optional: how the look is achieved (for reproduction)
  deploy.md               # Project-specific deploy notes
  deploy_guide.md         # Shared export/upload pattern
  style_guide.md          # Shared visual language
  app_guide.md            # This file
```

Keep folders **flat and named by job**, not by pattern buzzwords (`controllers/`, `services/`).

---

## HTML and UI

### Shell pattern

- One full-viewport `#app` wrapper.
- **Canvas** for the graphical view (WebGPU/WebGL/2D).
- **Overlays** as sibling DOM: HUD, minimap, sheets, modals — not drawn in the GPU pass unless performance demands it.
- Declare structure in HTML; JS attaches behaviour. Avoid generating large UI trees in JS unless the content is truly dynamic (search results, info panel body).

### UI classes

- Small ES classes (`InfoPanel`, `Hud`, `AppChrome`) that take DOM element refs in the constructor.
- No virtual DOM. Update text with `textContent`, classes with `classList`, visibility with a `.hidden` utility class.
- Pointer events: call `stopPropagation` on overlay controls so canvas drag/orbit does not steal input.

### Responsive chrome

- **Mobile:** bottom nav + slide-up sheets + scrim.
- **Desktop:** persistent side panel / floating HUD where space allows.
- One breakpoint (e.g. `768px`) is enough for prototypes; use `matchMedia` in one place (`AppChrome`).

### Accessibility and motion

- `aria-label`, `role="dialog"`, `aria-live` on dynamic readouts.
- Respect `prefers-reduced-motion: reduce` — collapse transitions globally.
- Visible `:focus-visible` outlines (amber in Baffled Cat theme).

Visual tokens and typography: follow **style_guide.md**.

---

## JavaScript architecture

### Module graph

- **Entry:** `js/main.js` imports render, UI, and data; owns the animation loop and top-level state (`focused`, active tour, etc.).
- **Domain modules:** pure functions and small types (`coords.js`, `orbits.js`) — no DOM, no GPU.
- **Render modules:** one class per pass or subsystem; `Scene` (or equivalent) orchestrates draw order.
- **UI modules:** DOM only; call back into `main.js` via callbacks (`onSelect`, `onHome`), not global events unless necessary.
- **Content modules:** static arrays/maps (tours, notes, landmarks). Keep copy out of render code.

### State

- Prefer **explicit state in `main.js`** over a store library.
- Pass `getFocusedSystem`-style accessors into UI rather than importing mutable singletons everywhere.
- Deep-link where useful (`?focus=NAME`) via `URLSearchParams` + `history.replaceState` — no router package.

### What not to add

- No Redux, Zustand, MobX.
- No service worker (unless offline is a stated goal).
- No Web Worker unless CPU work blocks the main thread (large mesh processing, etc.) — PlanetViewer runs without one.
- No runtime npm imports in the browser during development.

---

## Graphics (WebGPU / WebGL)

### Own the pipeline

- Bootstrap device/context in one place (`gpu.js`).
- **Pass-based rendering:** HDR offscreen → scene passes → tonemap → swapchain. Document order in `rendering.md`.
- Shaders live next to the pass that uses them (or in the same file as string templates).
- Use instanced billboards/quads instead of geometry libraries for particles and discs.

### Transparency discipline

- Additive for glow (stars); premultiplied alpha for solids (planets, rings).
- Depth **test** on, depth **write** off for transparent particles — document blend modes so they can be reproduced.

### Dual scale (when the subject demands it)

Real units often need **visual exaggeration** for exploration (parsecs for flight, AU for orbits). Keep two scales explicit in code and HUD copy (“Local orbits exaggerated”). Do not silently lie in labels.

### Picking and camera

- Picking: project to screen, nearest within radius — no physics engine.
- Camera: one `FlyCamera` (or equivalent) with free flight + focus tween + orbit drag. Attach input on the canvas in one place.

Authoritative rendering detail belongs in **`rendering.md`** per project, not in this guide.

---

## Data and networking

### Snapshot model

- **Production never calls live APIs.** Fetch upstream data in Node scripts (`scripts/fetch-*.mjs`), write JSON to `data/`, commit or regenerate before export.
- Separate **`npm run fetch-data`** from **`npm run build`**. A flaky TAP/API must not block a release build.

### Loader contract

- Page-relative URLs: `data/foo.json` (works at subpaths like `/myapp/`).
- Dev: plain JSON. Production export: gzipped `data/foo.json.gz`, client decompresses with `DecompressionStream`.
- Stamp fetches with `__APP_ASSET_VERSION__` (project-specific global) + `?v=N` when exported.

### Size discipline

- Do not inline multi‑MB JSON into the JS bundle. Ship data as separate cacheable files.
- Optional sidecars (images manifest, binaries) fail soft in dev (`try/catch` → empty default).

---

## CSS

- All tokens in `:root` — colours, fonts, radii, transitions, breakpoints.
- Dark theme default for graphical apps (`color-scheme: dark`).
- Glass panels: semi-transparent background + `backdrop-filter` sparingly.
- One file is fine until ~1.5k lines; split only when a section is clearly independent.
- No `@import` chains that complicate export — esbuild/minifier should see one entry CSS file.

---

## Development workflow

```bash
# Daily dev — no build step
npx serve -p 8080
# or python -m http.server 8080

# Refresh upstream snapshots (optional, network)
npm run fetch-data

# Package Export/BuildK (then Deploy Local / Deploy Prod deploy that build)
npm run build
# Windows: Build.cmd
```

- **`Start.cmd` / `Stop.cmd`** optional for local server; never ship them.
- WebGPU and other secure-context APIs need **HTTPS or localhost**.
- Smoke-test the export folder before upload (see deploy_guide checklist).

---

## Release and hosting

Follow **[deploy_guide.md](deploy_guide.md)**:

- Build once into `Export/BuildK`; deploys stamp a copy (`Export/BuildK-local`, `Export/VersionN`).
- `Export/latest.json` manifest.
- esbuild ESM bundle, HTML rewrite, gzip data.
- S3 sync with long cache on assets, short cache on `index.html`.
- Verify live version matches after upload.
- **Upload prefix must match the public URL path** users visit.

---

## Documentation split

| Doc | Purpose |
| --- | --- |
| `app_guide.md` | Cross-project principles (this file) |
| `style_guide.md` | Colours, type, motion, layout |
| `deploy_guide.md` | Export/upload mechanics |
| `README.md` | What the app is, controls, quick start |
| `deploy.md` | This app’s bucket, prefix, smoke tests |
| `rendering.md` | GPU look reproduction (shaders, blends, formulas) |
| `tours.md` / content docs | Authoring rules for guided content |

Do not duplicate rendering formulas in README; link to `rendering.md`.

---

## Prototype checklist (new app)

- [ ] `index.html` + `css/app.css` + `js/main.js` runs with static server only
- [ ] Zero runtime npm dependencies
- [ ] DOM overlays for UI; canvas for the view
- [ ] Domain logic separated from render and UI
- [ ] Data snapshots in `data/`; fetch scripts in `scripts/`
- [ ] Loader supports dev JSON and production gzip + version stamp
- [ ] style_guide tokens used (or documented divergence)
- [ ] `prefers-reduced-motion` respected
- [ ] Run Dev / Build / Deploy Local / Deploy Prod (`actions/*.mjs`) wired per deploy_guide
- [ ] `deploy.md` lists public URL, smoke tests, and app-specific globals
- [ ] Optional `rendering.md` if the visual output is non-obvious

---

## When to bend the rules

| Situation | Allow |
| --- | --- |
| Panorama / editor app (e.g. Highpersonic) | Web Worker, larger assets, more tooling |
| Need hot reload for shader iteration | Vite or esbuild watch — dev only |
| 2D-only tool | Canvas 2D or SVG instead of WebGPU |
| Team already on React for this product line | React — but not the default for a new graphical prototype |

Default to the simplest stack that meets the brief. Add weight only when the prototype proves it needs it.
