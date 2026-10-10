# Mandelbrot Zoomer

Interactive Mandelbrot explorer for the browser. Iteration runs on the GPU via **WebGPU compute**, with progressive resolution and antialiasing so the view stays responsive while zooming.

## Quick start

Double-click **`RunMandelbrot.cmd`** — it starts a local static server and opens Chrome at `http://localhost:10001` (WebGPU needs a secure context; `localhost` is fine).

Or manually:

```bash
npx serve -p 10001
```

```bash
python -m http.server 10001
```

Then open `http://localhost:10001`.

## Controls

| Input | Action |
| --- | --- |
| Scroll wheel | Zoom toward cursor |
| Click-drag / touch-drag | Pan |
| Pinch | Zoom about midpoint |
| HUD | Algorithm, max iterations, AA cap, gradient, offset, density (palette cycles over 0…maxIter) |
| Orbit (HUD checkbox) | Live plot of \(z_n\) for the point under the mouse (Fixed-point reference iteration) |

## Shareable URLs

View state is written to the query string (throttled), for example:

```
?cx=-0.75&cy=0&scale=3.5e+0&iter=200&algo=fp32&aa=4&grad=fire&goff=0&gdens=0.12
```

Copy the address bar to share a location. Deep zooms store `cx` / `cy` / `scale` as high-precision decimals (the camera is 384-bit fixed-point, not JS `Number`). Digit count for `cx`/`cy` grows with zoom so a reload stays on the same feature.

## Algorithm probe tests

Compare all iterators at 80 fixed complex points (5 zoom bands × 16 samples) against the CPU BigInt reference:

```bash
node js/test/run.js
node js/test/run.js --band=f48-edge
node js/test/run.js --json
```

Bands: `overview` → `medium` → `f32-edge` → `f48-edge` → `f64-edge` (seahorse / mini-set). `f48-edge` is the float-float stress band (~48-bit). GPU algorithms are exercised via JS mirrors of the same math (not a live WebGPU dispatch).

## Requirements

- A browser with WebGPU (recent Chrome, Edge, or Firefox with WebGPU enabled)
- No build step and no runtime npm dependencies for development
- Node.js 18+ optional, for `js/test/run.js`

## Project layout

See [app_guide.md](app_guide.md) for shared Baffled Cat conventions. Rendering details (quality ladder, iterator plugin contract, smooth colouring) are in [rendering.md](rendering.md).

## Algorithms

| ID | Label | Notes |
| --- | --- | --- |
| `fp32` | GPU FP32 | Fast; precision fades with deep zoom |
| `floatFloat` | GPU float-float (~64-bit) | Emulated double-double on the GPU (WebGPU has no `f64`) |
| `perturbation` | Perturbation (CPU ref + GPU δ) | BigInt ref + unscaled f32 δ; deep until scale≈1e-38 (δc underflow) |
| `perturbationScaled` | Perturbation scaled (CPU ref + GPU Δ) | Same ref; Δ=δ/scale with mantissa×2^e (scale as frexp); deep to ~1e90× |
| `cpuF64` | CPU f64 | JS `Number` iterate on the CPU; fast reference while zoom stays within binary64 |
| `cpuRef` | CPU BigInt (reference) | 384-bit fixed-point on the CPU; ground truth for comparing GPU algos (very slow) |

Pick the algorithm in the HUD. Iterators are registered plugins under `js/iterators/`.
