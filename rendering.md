# Rendering notes

## Pipeline

1. **Iterate** (compute) — for each sample, run Mandelbrot and write a continuous iteration value into an `array<f32>` escape buffer (`-1` = interior).
2. **Colour** (compute) — map escape → RGBA8 image via a 1D gradient LUT: `fract((smoothIter / maxIter) * density + offset)`. Density is **palette cycles from iter 0 to maxIter**, so the same slider setting stays useful when you change the iteration limit.
3. **Blit** (render) — fullscreen sample of the image texture to the canvas swapchain.

Gradient / offset / density changes re-run colour + blit only. View, iterations, algorithm, or AA changes reset the progressive iterate ladder.

## Smooth iteration

At escape (bailout magnitude² > 256):

```text
nu = n + 1 - log2(log2(|z|))
```

with `log2(|z|) = 0.5 * log2(mag²)`. Colouring is agnostic to the iterator as long as this float (or `-1`) is written per pixel.

## Algorithms

- **GPU FP32** (`fp32`) — single-precision iterate; ignores uniform `centerLo` / `scaleLo`.
- **GPU float-float** (`floatFloat`) — double-double (`hi`+`lo` f32) for view mapping and the Mandelbrot step. Practical browser stand-in for 64-bit because WGSL has no `f64`. Slower; use when FP32 breaks down under zoom.
- **Perturbation** (`perturbation`) — CPU builds a high-precision reference orbit \(Z_n\) at the view center (`js/math/bigFixed.js`, 384-bit fixed-point BigInt). The GPU iterates \(\delta_{n+1} = 2 Z_n \delta_n + \delta_n^2 + \delta c\) in f32. Rebases when the reference runs out or \(|Z+\delta| < |\delta|\). Hits a hard wall near zoom `1e37` when f32 `scale` makes \(\delta c\) underflow.
- **Perturbation scaled** (`perturbationScaled`) — same reference upload; GPU iterates \(\Delta = \delta/\mathrm{scale}\) as mantissa×2^e with scale uploaded as frexp, \(\Delta' = 2 Z \Delta + \mathrm{scale}\,\Delta^2 + \Delta c\), and \(\Delta c\) in screen units (O(1)). Zoom floor matches the camera (~`1e90`×).
- **CPU f64** (`cpuF64`) — full Mandelbrot per sample in JS `Number` (binary64) on the CPU (`js/iterators/cpuF64.js`). Same escape/AA contract as the GPU paths; much faster than BigInt and a practical reference until the camera outruns f64.
- **CPU BigInt reference** (`cpuRef`) — full Mandelbrot per sample in 384-bit fixed-point on the CPU (`js/iterators/cpuRef.js`). Same smooth-escape and AA blend rules as the GPU shaders. Uploads tile rows into the shared escape buffer. Intended as ground truth for measuring GPU iterator error; expect very low tile throughput.

The **camera** (`js/view.js`) stores center and scale as 384-bit fixed-point (`Fixed`). Zoom floor is scale `3.5e-90` (`1e90`×) for **scaled** perturbation; unscaled perturbation still dies near zoom `1e37` when δc underflows. Reference orbits use the full `Fixed` center. URLs serialize `cx`/`cy`/`scale` as high-digit decimals.

## Iterator plugin contract

Each module under `js/iterators/` exports:

| Field | Meaning |
| --- | --- |
| `id` | Stable key (`fp32`) |
| `label` | HUD label |
| `precisionHint` | e.g. `f32` |
| `supportsDeepZoom` | Reserved for later gating |
| `needsReferenceOrbit` | If true, scheduler/IteratePass build and bind a ref orbit buffer |
| `runOnCpu` | If true, scheduler calls `fillTile` instead of a compute dispatch |
| `fillTile` | CPU iterators only: write one tile into a `Float32Array` escape image |
| `wgsl` | Compute shader source (GPU iterators) |
| `entryPoint` | Default `main` |

GPU bind group:

- `0` — uniform `Params` (center, scale, aspect, resolution, tile origin/size, maxIter, aa; last word is `refLen` for perturbation)
- `1` — storage escape buffer
- `2` — (perturbation only) read-only storage `array<vec2f>` of reference \(Z_n\)

Workgroup size: `8×8`. The scheduler dispatches one tile at a time (uniform buffer is rewritten per tile submit). On each iterate batch, `IteratePass.prepareReference` recomputes the CPU orbit when the view center or `maxIter` changes. CPU iterators fill tiles under a wall-clock frame budget and upload with `queue.writeBuffer`.

## Progressive quality ladder

On invalidate:

1. Wait for prior GPU work, clear the tile queue.
2. Climb: **1/32 → 1/16 → 1/8 → 1/4 → 1/2 → 1× → 2×2 → 4×4 → 8×8 → 16×16** up to the HUD `aaMax` (1, 2, 4, 8, or 16). The first preview is 1/32 of full resolution.
3. Each level is split into **64×64** logical-pixel tiles. Tile count per frame is **adaptive**: `floor(budgetMs / msPerTile)` (budget ~33 ms at 30 Hz minus colour/blit reserve), always at least one. Cost is measured with `queue.onSubmittedWorkDone()` (EMA). When the ladder steps AA or resolution, the estimate is scaled by `(aaRatio² × resScaleRatio²)` — so each 2× AA step (~4× samples) cuts predicted tiles/frame by about 4×.
4. While the pointer is active, the ladder pauses at **1×**; after ~120 ms idle it continues to the AA levels.
5. During AA levels (`aa > 1`), each updated tile is flashed with a short amber wash on a 2D overlay, and the frame is recoloured after every tile batch so refinement is visible as it lands.

AA uses a regular subpixel grid; smooth values of escaped samples are averaged into one float, then coloured once. Shared sample/blend WGSL lives in `js/iterators/mandelCommon.wgsl.js` (production iterator and AA debug probe both import it).

## AA debug panel (GPU truth)

Toggle **AA debug** in the HUD. Click the fractal (without dragging) to set a probe pixel.

A dedicated compute pass (`js/debug/aaGpuProbe.js`) runs on the GPU:

1. **16×16 samples** — one `mandel_smooth` per subpixel at `(sx+0.5)/16` offsets; written to a storage buffer and read back.
2. **Blends** — for `aa ∈ {1,2,4,8,16}`, the production `blend_pixel_aa` loop for that single pixel (average escaped smooth-iters only).

Results are coloured for display with the same LUT/density/offset as the main view. Each 16×16 cell also prints the GPU smooth-iteration number (`in` if interior); blend swatches show the averaged escape value. This diagnoses GPU subpixel sampling, not a CPU reimplementation.

## Colour

Presets in `js/color/gradient.js` bake a 512-wide `rgba8unorm` LUT. Interior pixels use a warm near-black matching `--bg`.
