import {
  mandelSmoothFixed,
  complexFromPixelFixed,
} from "../math/bigFixed.js";

/**
 * Ground-truth Mandelbrot on the CPU using BigInt fixed-point (FRAC_BITS).
 * Slow — intended for validating GPU iterators, not interactive deep zooms.
 *
 * Same escape contract as GPU paths: smooth iteration float, or -1 interior.
 * AA averages escaped samples only (matches mandelCommon.wgsl.js).
 */

function blendPixelAa(view, aspect, width, height, px, py, aa, maxIter) {
  const a = Math.max(aa | 0, 1);
  const inv = 1 / a;
  let sum = 0;
  let escaped = 0;
  for (let sy = 0; sy < a; sy++) {
    for (let sx = 0; sx < a; sx++) {
      const c = complexFromPixelFixed(
        view.centerX,
        view.centerY,
        view.scale,
        aspect,
        width,
        height,
        px,
        py,
        (sx + 0.5) * inv,
        (sy + 0.5) * inv
      );
      const m = mandelSmoothFixed(c.x, c.y, maxIter);
      if (m >= 0) {
        sum += m;
        escaped += 1;
      }
    }
  }
  if (escaped === 0) return -1;
  return sum / escaped;
}

/**
 * Fill one tile of the escape image (width × height Float32Array).
 */
export function fillTileCpuRef({
  escape,
  width,
  height,
  view,
  aspect,
  tile,
  maxIter,
  aa,
}) {
  const x1 = tile.x + tile.w;
  const y1 = tile.y + tile.h;
  for (let py = tile.y; py < y1; py++) {
    const row = py * width;
    for (let px = tile.x; px < x1; px++) {
      escape[row + px] = blendPixelAa(
        view,
        aspect,
        width,
        height,
        px,
        py,
        aa,
        maxIter
      );
    }
  }
}

export const cpuRefIterator = {
  id: "cpuRef",
  label: "CPU BigInt (reference)",
  precisionHint: "bigint-fixed",
  supportsDeepZoom: true,
  /** Scheduler runs fillTile on the CPU and uploads to the escape buffer. */
  runOnCpu: true,
  fillTile: fillTileCpuRef,
};
