# GUI: app chrome for full-screen visual apps

How Baffled Cat viewers and visual tools lay out their controls: a full-bleed canvas, a central menu bar at the bottom, and floating panels over the view. Taken from MandelbrotViewer (`index.html`, `css/app.css`, `js/ui/AppChrome.js`), which follows the same pattern as PlanetViewer and Bifurcation. Colours, fonts and shapes come from `style.md` and `design/tokens.css`; this file covers layout and behaviour.

**Where it applies:** any app whose main content is a canvas (WebGPU/WebGL view, map, plot) with controls laid over it. Content pages and app homepages follow `landing-page.md` instead.

## The shell

Everything sits inside one full-viewport `#app` (`position: relative; width/height: 100%; overflow: hidden`). Declare the structure in `index.html`; JS only attaches behaviour.

```html
<div id="app">
  <canvas id="view"></canvas>            <!-- the visualisation, full bleed -->
  <canvas class="overlay"></canvas>      <!-- optional: pins, highlights; pointer-events: none -->
  <aside id="hud" class="hud">…</aside>  <!-- Settings panel (left on desktop) -->
  <aside class="xxx-panel hidden">…</aside>  <!-- one per tool (right on desktop) -->
  <div id="view-status">…</div>          <!-- small live readout: zoom, FPS, time -->
  <div id="nav-scrim" class="nav-scrim hidden"></div>
  <div id="render-status">…</div>        <!-- progress lozenge under the nav -->
  <nav id="app-nav">…</nav>              <!-- central menu bar -->
</div>
```

- The canvas is the page. No header, footer or scrolling; the body never scrolls, only panels do.
- Panels are `<aside>` with an `aria-label`. Hide with a `.hidden { display: none !important; }` class.
- Use `viewport-fit=cover` in the viewport meta and `env(safe-area-inset-*)` on anything pinned to an edge.

## The central menu bar

A single pill of icon buttons, centred at the bottom of the screen, on every screen size. It's the one place to open and close things.

| Property | Value |
|---|---|
| Position | `position: fixed; left: 50%; transform: translateX(-50%)`, bottom above the render-status lozenge |
| Width | `min(33rem, calc(100vw - 1.25rem))` for 6 buttons (about 5.5rem per button) |
| Height | `--nav-height: 58px` (44px buttons + 4px padding + border) |
| Layout | `display: grid; grid-template-columns: repeat(N, 1fr); gap: 2px; padding: 4px` |
| Look | `--radius-pill`, `rgba(38, 32, 25, 0.92)` (raised surface at 92%), `--border`, `backdrop-filter: blur(12px)`, `box-shadow: 0 8px 32px rgba(0,0,0,0.35)` |
| z-index | 9 (above everything except dialogs) |

**Buttons** (`.nav-btn`): a real `<button>` with a 20×20 stroke SVG icon (`stroke="currentColor"`, `stroke-width="2"`, round caps/joins, `aria-hidden="true"`) over a short label (`.nav-label`, one word, `--font-display` 0.68rem). Minimum 44px tall, pill-shaped.

- Rest: `--text-muted`, transparent. Hover: `--text` on `--bg-raised-hover`.
- Active (its panel is open, or fullscreen is on): `.is-active` → `--accent-amber` on `--accent-amber-soft`, plus `aria-pressed="true"`.
- Every button has an `aria-label`; toggles keep `aria-pressed` in sync.
- Order: **Home** (reset view) first, then **Settings**, **Fullscreen**, then the app's tool panels. Keep it to about six; more doesn't fit at 360px.
- Fullscreen swaps its icon and label ("Full" ↔ "Exit") and listens for `fullscreenchange` (plus the `webkit` prefix).
- Buttons call `stopPropagation()` on `click` and `pointerdown` so the canvas never sees the tap.

**Render-status lozenge** (optional, for progressive renders): a pill under the nav, a little narrower (`min(20rem, calc(100vw - 2.5rem))`), with an amber fill that grows left to right and mono text on top. `pointer-events: none`, `role="status"`. Reserve its height with `--render-status-space` so the nav sits 8px above it.

## Panels

All panels share one look: raised surface at 82–92% opacity, `--border`, `--radius`, `backdrop-filter: blur(12px)`, `flex` column with 0.55–0.75rem gaps, padding about `1rem 1.1rem`. Each has a header with a title (`--font-display`, 1.15rem, 600, `-0.02em`), and optionally a close button.

### Desktop (≥ 768px)

| Panel | Where | Width |
|---|---|---|
| Settings (HUD) | Top-left, `top/left: 1rem` | `min(17.5rem, calc(100vw - 2rem))` |
| Tool panels (Orbit, Cloud, Shots…) | Top-right, `top/right: 1rem` | `min(18–28rem, calc(100vw - 2rem))`, depending on content |
| Editors opened from Settings (e.g. Edit colours) | Top-right | `min(26rem, calc(100vw - 2rem))` |

- `max-height: calc(100vh - 2rem); overflow: auto`. The panel scrolls, never the page.
- Settings is **open by default** on desktop.
- **One right-hand panel at a time.** Opening a tool panel closes the other tool panels and any editor. Settings on the left can stay open alongside it.
- Square plots inside panels: `width: 100%; aspect-ratio: 1`.

### Mobile (< 768px): one panel at a time

A phone has room for the view **or** one panel, never two stacked. On mobile:

- **Only one panel is visible at any time,** including Settings. Opening any panel (Settings, a tool, an editor) closes every other one.
- Settings starts **closed**, so the first thing a visitor sees is the view.
- Every panel becomes a bottom sheet sitting directly on top of the menu bar, sized to its content and growing upward:

```css
@media (max-width: 767.98px) {
  .hud, .xxx-panel {
    --mobile-panel-gutter: 0.5rem;
    --mobile-panel-above-nav: calc(var(--nav-height) + var(--render-status-space) + 8px
      + env(safe-area-inset-bottom, 0px) + var(--mobile-panel-gutter));
    top: auto;
    left: var(--mobile-panel-gutter);
    right: var(--mobile-panel-gutter);
    bottom: var(--mobile-panel-above-nav);
    width: auto;
    max-height: calc(100dvh - env(safe-area-inset-top, 0px)
      - var(--mobile-panel-gutter) - var(--mobile-panel-above-nav));
    overflow: auto;
    z-index: 8;
  }
}
```

  (Give a `100vh` `max-height` first as a fallback for browsers without `dvh`.)
- The menu bar stays visible and tappable above the sheet, so the same button closes it.
- Settings opens with a **scrim** (`position: fixed; inset: 0; z-index: 7; background: rgba(14,12,9,0.45)`); tapping the scrim closes it. Tool panels that need the view visible (e.g. a probe that follows your finger) don't use a scrim.
- Hide small overlay readouts (zoom/FPS) while any panel is open, and move them to the top-left corner so they don't collide with the nav.

### Keeping it in one place

One class (`AppChrome`) owns the nav and the open/closed state of every panel. It takes DOM refs and callbacks in its constructor (`onOrbit(enabled)`, `isOrbitOpen()`, …) and enforces the rules above; panels don't close each other directly. Read the breakpoint once with `matchMedia` and re-sync on its `change` event.

- Use a **single breakpoint**: `(min-width: 768px)` in JS and `(max-width: 767.98px)` in CSS, so exactly 768px isn't both. Define it once in JS and reuse it.

## Input over the canvas

- Panels and controls call `stopPropagation()` on `pointerdown` and `wheel` (`{ passive: false }`) so dragging a slider doesn't pan the view.
- The canvas has `touch-action: none` and `cursor: grab` / `grabbing`.
- A panel that should let touches reach the view underneath uses `pointer-events: none` on the panel.
- Overlay canvases (pins, highlights) are `pointer-events: none`; hit-test through the main canvas in a capture-phase listener.

## Controls inside panels

- **Field** (`.field`): a 2-column grid. Label on top (`--font-mono`, 0.68rem, uppercase, `0.06em`, `--text-faint`), control full width underneath, optional value readout on the right (`--font-mono`, 0.8rem, `--text-muted`).
- Selects/inputs: `--bg` background, `--border`, `--radius-sm`, 0.9rem body text, `accent-color: --accent-amber`. Ranges have no border or background.
- Related options go in a sub-group: `--radius-sm` box with a faint fill, child options separated by a top hairline; hide the options (`hidden`) until they apply.
- Panel buttons: `--radius-sm`, faint fill, hover border `--accent-amber`. The single main action in a panel (e.g. "Take screenshot") is solid amber with `--bg` text.
- Modal dialogs (e.g. the ScreenGrabber capture panel) use `<dialog>`, `max-width: min(92vw, 26rem)`, z-index 20, a dark blurred `::backdrop`, and pill buttons (`.bc-btn--primary` / `--secondary`).

## Layers

| z-index | What |
|---|---|
| 0 | Main canvas |
| 1–2 | Overlay canvases, Settings, editors (desktop) |
| 3 | Tool panels, view readout, banners (desktop) |
| 7 | Mobile scrim |
| 8 | All panels on mobile |
| 9 | Menu bar, render-status lozenge |
| 20 | Modal dialogs |

## Dimensions at a glance

| Thing | Size |
|---|---|
| Breakpoint | 768px |
| Smallest supported width | 360px, no horizontal scrolling |
| Menu bar | `min(33rem, 100vw - 1.25rem)` × 58px, 8px above the status lozenge |
| Nav button | ≥ 44px tall, 20px icon |
| Desktop panel margin | 1rem from the edges |
| Settings panel | 17.5rem |
| Tool panels | 18rem (lists) to 28rem (plots) |
| Mobile gutter | 0.5rem each side and above the nav |

## Checklist

- [ ] Full-bleed canvas, no page scroll; panels scroll internally.
- [ ] Central bottom menu bar with Home, Settings, Fullscreen, then tools; icons + one-word labels.
- [ ] Active nav buttons in amber with `aria-pressed`.
- [ ] Desktop: Settings open on the left, at most one panel on the right.
- [ ] Mobile: Settings closed at start, exactly one panel visible at a time, sheets sit above the nav.
- [ ] Safe-area insets on every edge-pinned element; `100dvh` with a `100vh` fallback.
- [ ] Overlay controls don't leak pointer or wheel events to the canvas.
- [ ] Works at 360px wide and at exactly 768px.
