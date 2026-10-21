# Rendering notes

## Pipeline

1. **Iterate** (compute) — for each sample, run Mandelbrot and write `vec2(smoothIter, secondary)` into an `array<vec2f>` escape buffer (`x = -1` = interior). The secondary channel depends on the **V axis** dropdown (independent of the gradient preset): flat, packed escape angle, stripe average, distance estimate, or orbit traps (+ / o).
2. **Colour** (compute) — map escape → RGBA8 via a **2D** colour-scheme LUT. Mapping uses per-axis density/offset and wrap (repeat / clamp / mirror) in the shader: `u = map(smoothIter, densU, offU, wrapU)`, similarly for `v`. Flat fixes `v = 0` (1D fallback = bottom LUT row); angle mode colours `mix(LUT(u, A), LUT(u, 2A), w)`; scalar secondaries sample `LUT(u, map(e.y, …))`. `densU` is **palette cycles from iter 0 to maxIter**; `densV` is cycles across the V domain.
3. **Blit** (render) — fullscreen sample of the image texture to the canvas swapchain.

LUT bake / offset / density / wrap / stop edits re-run colour + blit only. View, iterations, algorithm, AA, V-axis algorithm, or V-axis knobs (stripe frequency/window, DE gain) reset the progressive iterate ladder.

## Smooth iteration

At escape (bailout magnitude² > 256):

```text
nu = n + 1 - log2(log2(|z|))
```

with `log2(|z|) = 0.5 * log2(mag²)`.

## Escape angle

No single angle value is continuous across escape bands: a point that escapes one iteration later has been squared once more, so \(\arg z\) doubles. Instead each sample stores

```text
A = atan2(zy, zx) / (2π)               wrapped to [0, 1)
w = clamp(3 - log2(log2|z|), 0, 1)     band weight
```

At the outer edge of band \(n\) (\(|z_n| \to 256\)) \(w \to 0\). At the inner edge (\(|z_n| \to 16\), next to band \(n+1\)) \(w \to 1\), and the neighbour there has \(A_{n+1} \approx 2A_n\) with \(w \approx 0\). So `mix(LUT(u, A), LUT(u, 2A), w)` matches on both sides of every band boundary, and the repeating LUT hides the \(\pm\pi\) wrap of `atan2`. The residual mismatch is \(\arg(1 + c/z_n^2)\), roughly \(|c|/256\) radians.

`y` packs both as an exact integer in f32: 16-bit angle + 7-bit weight × 65536 (≤ 2²³ − 1). Interior pixels write `(-1, 0)`. The WGSL lives in `escapeSampleWgsl` (`js/iterators/mandelCommon.wgsl.js`), mirrored for CPU iterators in `js/color/smooth.js`.

## Secondary (V) axis

The HUD **V axis** dropdown sets iterate uniform `colourMode` (word 16). Gradient presets only choose the 2D LUT; they no longer imply an iterate mode. Codes:

| Code | Id | Escape `y` | Colour pass |
| --- | --- | --- | --- |
| 0 | `flat` | unused | `v = 0` (1D row) |
| 1 | `angle` | packed A + band weight | A/2A mix (above) |
| 2 | `stripes` | Härkönen recent-window average | scalar map |
| 3 | `de` | distance estimate in `[0,1]` | scalar map |
| 4 | `trap` + shape cross | cross orbit trap (+) → `[0,1]` | scalar map |
| 5 | `trap` + shape circle | circle orbit trap (o, \|z\|=0.5) → `[0,1]` | scalar map |

Stripe / DE knobs (`stripeFreq`, `stripeWindow`, `deGain` — words 17–19) appear only when that algorithm is selected.

### Stripe average

With V axis = Stripes, the orbit accumulates Härkönen's stripe term for \(i \ge 1\), but only the **most recent** \(W\) terms contribute (ring buffer, \(W \le 64\); "Window" slider, default 32):

```text
t_i = 0.5 + 0.5 · sin(k · arg z_i)        k = stripeFreq ("Stripes" slider, 1–16)
S   = mix(mean of window before last term, mean after, w)
```

A full-orbit mean washes out at deep zooms (early terms dominate and neighbouring pixels share almost the same long history). The recent window keeps the local stripe structure. `w` is the same band weight as above. `y` stores `S` in \([0, 1]\); AA averages linearly. Stripe gradient presets contrast-stretch the mid-clustered `S` on the LUT V axis.

### Distance estimate / orbit trap

DE maps \(2|z|\log|z|/|z'|\) in pixel units through \(\mathrm{asinh}(r)/(5\cdot\mathrm{deGain})\) so the far field does not clamp to 1. Orbit trap is one V-axis mode with a **Trap shape** sub-option (cross / circle); soft falloff \(1/(1+10\cdot\mathrm{trap})\). Cross = distance to the nearer coordinate axis; circle = distance to \(|z|=0.5\).

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
| `fillTile` | CPU iterators only: write one tile into an interleaved `Float32Array` (`[m, packedAngle, …]`) |
| `wgsl` | Compute shader source (GPU iterators) |
| `entryPoint` | Default `main` |

GPU bind group:

- `0` — uniform `Params` (center, scale, aspect, resolution, tile origin/size, maxIter, aa; last word is `refLen` for perturbation)
- `1` — storage escape buffer (`array<vec2f>`)
- `2` — (perturbation only) read-only storage `array<vec2f>` of reference \(Z_n\)

Workgroup size: `8×8`. The scheduler dispatches one tile at a time (uniform buffer is rewritten per tile submit). On each iterate batch, `IteratePass.prepareReference` recomputes the CPU orbit when the view center or `maxIter` changes. CPU iterators fill tiles under a wall-clock frame budget and upload with `queue.writeBuffer`.

## Progressive quality ladder

On invalidate:

1. Wait for prior GPU work, clear the tile queue.
2. Climb: **1/32 → 1/16 → 1/8 → 1/4 → 1/2 → 1× → 2×2 → 4×4 → 8×8 → 16×16** up to the HUD `aaMax` (1, 2, 4, 8, or 16). The first preview is 1/32 of full resolution.
3. Each level is split into **64×64** logical-pixel tiles. Tile count per frame is **adaptive**: `floor(budgetMs / msPerTile)` (budget ~33 ms at 30 Hz minus colour/blit reserve), always at least one. Cost is measured with `queue.onSubmittedWorkDone()` (EMA). When the ladder steps AA or resolution, the estimate is scaled by `(aaRatio² × resScaleRatio²)` — so each 2× AA step (~4× samples) cuts predicted tiles/frame by about 4×.
4. While the pointer is active, the ladder pauses at **1×**; after ~120 ms idle it continues to the AA levels.
5. During AA levels (`aa > 1`), each updated tile is flashed with a short amber wash on a 2D overlay, and the frame is recoloured after every tile batch so refinement is visible as it lands.

AA uses a regular subpixel grid. Escaped samples average smooth-iter linearly. Angles are first expressed in the deepest band in the pixel: shallower samples are doubled up and given weight 0, because they sit at the band edge where that is exact. Then they are combined with a **circular mean** (unit-vector average then `atan2`), and the pixel is coloured once. Shared sample/blend WGSL lives in `js/iterators/mandelCommon.wgsl.js`.

## Colour

Colour schemes and the Colour panel share a **GradientDocument** in `js/color/gradient.js`: U stops (iteration) × V stops (secondary), combined by **RGB multiply**, with RGB or HSL interpolation between stops. The result bakes to a `512×64` `rgba8unorm` LUT. Strip schemes default to a white→black V ramp (**white at v = 0** so Flat/1D equals the U palette); use Wrap V = Mirror for a reflected ramp. Angle hue keeps a hue wheel on V. Edits (doc + Offset/Density) persist per scheme in `localStorage` (`js/color/schemeStore.js`); share URLs with `ustops`/`vstops` override storage on load. **Reset to Default** clears the current scheme's storage entry. An image-LUT `source: "image"` path is reserved (upload stub only for now).

Edge wrap is applied in the colour shader (sampler stays `repeat`). Interior pixels use a warm near-black matching `--bg`. Orbit / Cloud use a 1D `bakeLut` from U×V at `v = 0`.
