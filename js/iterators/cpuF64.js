/**
 * CPU Mandelbrot using JS Number (IEEE-754 binary64).
 * Same escape / AA contract as the GPU shaders and cpuRef, but much faster
 * than BigInt — useful mid-precision reference while debugging iterators.
 */

function mandelSmooth(cx, cy, maxIter) {
  let zx = 0;
  let zy = 0;
  for (let i = 0; i < maxIter; i++) {
    const x2 = zx * zx;
    const y2 = zy * zy;
    const mag2 = x2 + y2;
    if (mag2 > 256) {
      const logZn = Math.log2(mag2) * 0.5;
      return i + 1 - Math.log2(logZn);
    }
    zy = 2 * zx * zy + cy;
    zx = x2 - y2 + cx;
  }
  return -1;
}

function complexFromPixel(view, aspect, width, height, px, py, sxOff, syOff) {
  const u = (px + sxOff) / width;
  const v = (py + syOff) / height;
  const cx = view.centerX.toNumber?.() ?? view.centerX;
  const cy = view.centerY.toNumber?.() ?? view.centerY;
  const scale = view.scale.toNumber?.() ?? view.scale;
  return {
    x: cx + (u - 0.5) * scale,
    y: cy - (v - 0.5) * (scale / aspect),
  };
}

function blendPixelAa(view, aspect, width, height, px, py, aa, maxIter) {
  const a = Math.max(aa | 0, 1);
  const inv = 1 / a;
  let sum = 0;
  let escaped = 0;
  for (let sy = 0; sy < a; sy++) {
    for (let sx = 0; sx < a; sx++) {
      const c = complexFromPixel(
        view,
        aspect,
        width,
        height,
        px,
        py,
        (sx + 0.5) * inv,
        (sy + 0.5) * inv
      );
      const m = mandelSmooth(c.x, c.y, maxIter);
      if (m >= 0) {
        sum += m;
        escaped += 1;
      }
    }
  }
  if (escaped === 0) return -1;
  return sum / escaped;
}

export function fillTileCpuF64({
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

export const cpuF64Iterator = {
  id: "cpuF64",
  label: "CPU f64",
  precisionHint: "f64",
  supportsDeepZoom: true,
  runOnCpu: true,
  fillTile: fillTileCpuF64,
};
