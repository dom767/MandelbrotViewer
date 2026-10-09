/**
 * Complex-plane viewport: center + horizontal span (scale), stored as
 * fixed-point (see FRAC_BITS) so pan/zoom stay accurate far past JS Number.
 */

import { Fixed } from "./math/bigFixed.js";

/**
 * Smallest horizontal span → max zoom = FULL_WIDTH / MIN_SCALE = 1e90.
 * Scaled perturbation (mantissa×2^e Δ, frexp scale) supports this; unscaled
 * perturbation still dies near ~1e38 when δc underflows.
 */
const MIN_SCALE = Fixed.fromNumber(3.5e-90);
const MAX_SCALE = Fixed.fromNumber(8);
const FULL_WIDTH = Fixed.fromNumber(3.5);

export function createView(initial = {}) {
  return {
    centerX: Fixed.coerce(initial.centerX, -0.75),
    centerY: Fixed.coerce(initial.centerY, 0),
    /** Width of the view in complex-plane units. */
    scale: clampScale(Fixed.coerce(initial.scale, 3.5)),
  };
}

export function cloneView(view) {
  return {
    centerX: view.centerX.copy(),
    centerY: view.centerY.copy(),
    scale: view.scale.copy(),
  };
}

/** Number snapshot for GPU paths / probes that still take f64. */
export function viewToNumbers(view) {
  return {
    centerX: view.centerX.toNumber(),
    centerY: view.centerY.toNumber(),
    scale: view.scale.toNumber(),
  };
}

export function aspectOf(width, height) {
  return width / Math.max(height, 1);
}

/** Map canvas pixel (x,y) to complex plane (Fixed). Origin top-left. */
export function screenToComplex(view, x, y, width, height) {
  const w = Math.max(width, 1);
  const h = Math.max(height, 1);
  const aspect = aspectOf(w, h);
  const u = (x + 0.5) / w;
  const v = (y + 0.5) / h;
  const dx = view.scale.mul(Fixed.fromNumber(u - 0.5));
  const dy = view.scale
    .mul(Fixed.fromNumber(1 / aspect))
    .mul(Fixed.fromNumber(v - 0.5));
  return {
    x: view.centerX.add(dx),
    y: view.centerY.sub(dy),
  };
}

/** Zoom by factor (>1 zooms in) about a canvas pixel. */
export function zoomAt(view, factor, pivotX, pivotY, width, height) {
  if (!(width > 0) || !(height > 0)) return;
  const f = clamp(factor, 1 / 32, 32);
  if (!Number.isFinite(f) || f === 1) return;
  const before = screenToComplex(view, pivotX, pivotY, width, height);
  view.scale = clampScale(view.scale.mul(Fixed.fromNumber(1 / f)));
  const after = screenToComplex(view, pivotX, pivotY, width, height);
  view.centerX = view.centerX.add(before.x.sub(after.x));
  view.centerY = view.centerY.add(before.y.sub(after.y));
}

export function panByPixels(view, dx, dy, width, height) {
  if (!(width > 0) || !(height > 0)) return;
  const aspect = aspectOf(width, height);
  const ddx = view.scale.mul(Fixed.fromNumber(dx / width));
  const ddy = view.scale
    .mul(Fixed.fromNumber(1 / aspect))
    .mul(Fixed.fromNumber(dy / height));
  view.centerX = view.centerX.sub(ddx);
  view.centerY = view.centerY.add(ddy);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function clampScale(scale) {
  const s = Fixed.coerce(scale, 3.5);
  if (s.lt(MIN_SCALE)) return MIN_SCALE.copy();
  if (s.gt(MAX_SCALE)) return MAX_SCALE.copy();
  return s;
}

/** Magnification vs the classic full-set width (~3.5). Returns a Number when finite. */
export function zoomFactor(view) {
  const z = FULL_WIDTH.div(view.scale);
  const n = z.toNumber();
  if (Number.isFinite(n) && n > 0) return n;
  // Beyond Number — still fine up to ~1e308 via exponential parse
  return Number(z.toExponential(15));
}

/** Format center for HUD / URL (high digit count). */
export function formatCenter(view, sig = 18) {
  return {
    x: view.centerX.toDecimalString(sig),
    y: view.centerY.toDecimalString(sig),
  };
}
