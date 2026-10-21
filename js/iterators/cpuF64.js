/**
 * CPU Mandelbrot using JS Number (IEEE-754 binary64).
 * Same escape / AA contract as the GPU shaders and cpuRef, but much faster
 * than BigInt — useful mid-precision reference while debugging iterators.
 *
 * Escape buffer is interleaved Float32Array: [m0, y0, m1, y1, ...]
 * (y = packed angle/weight or scalar secondary, see js/color/smooth.js).
 */

import {
  escapeSample,
  ESCAPE_INTERIOR,
  blendEscapeAa,
  stripeTerm,
  createStripeWin,
  stripeWinMean,
  stripeWinAdd,
  trapDistForShape,
  finishSecondary,
  SECONDARY_STRIPES,
  SECONDARY_DE,
  SECONDARY_TRAP,
  SECONDARY_FLAT,
  SECONDARY_ANGLE,
  TRAP_SHAPE_CROSS,
  TRAP_SHAPE_CIRCLE,
  normalizeSecondary,
  isTrapSecondary,
} from "../color/smooth.js";
import { secondaryCode } from "../color/secondary.js";

function fromColourMode(colourMode) {
  const code = colourMode | 0;
  if (code === 5) {
    return { secondary: SECONDARY_TRAP, trapShape: TRAP_SHAPE_CIRCLE };
  }
  if (code === 4) {
    return { secondary: SECONDARY_TRAP, trapShape: TRAP_SHAPE_CROSS };
  }
  const map = {
    0: SECONDARY_FLAT,
    1: SECONDARY_ANGLE,
    2: SECONDARY_STRIPES,
    3: SECONDARY_DE,
  };
  return {
    secondary: map[code] ?? SECONDARY_ANGLE,
    trapShape: TRAP_SHAPE_CROSS,
  };
}

function mandelEscape(cx, cy, maxIter, secondary, opts) {
  let zx = 0;
  let zy = 0;
  let dzx = 1;
  let dzy = 0;
  let sw = null;
  let sprev = 0.5;
  let sfull = 0.5;
  let trapMin = 1e20;
  const mode = normalizeSecondary(secondary);
  const trapShape = opts.trapShape ?? TRAP_SHAPE_CROSS;

  for (let i = 0; i < maxIter; i++) {
    const x2 = zx * zx;
    const y2 = zy * zy;
    const mag2 = x2 + y2;
    if (mode === SECONDARY_STRIPES && i > 0) {
      if (!sw) sw = createStripeWin();
      const term = stripeTerm(zx, zy, opts.stripeFreq);
      sprev = sw.len > 0 ? stripeWinMean(sw) : term;
      stripeWinAdd(sw, term, opts.stripeWindow);
      sfull = stripeWinMean(sw);
    }
    if (isTrapSecondary(mode) && i > 0) {
      trapMin = Math.min(trapMin, trapDistForShape(trapShape, zx, zy));
    }
    if (mag2 > 256) {
      const s = escapeSample(i, zx, zy, mag2);
      return finishSecondary(s, mode, {
        sprev,
        sfull,
        zx,
        zy,
        mag2,
        dzx,
        dzy,
        pixel: opts.pixel,
        deGain: opts.deGain,
        trapMin,
      });
    }
    const ndzx = 2 * (zx * dzx - zy * dzy) + 1;
    const ndzy = 2 * (zx * dzy + zy * dzx);
    zy = 2 * zx * zy + cy;
    zx = x2 - y2 + cx;
    dzx = ndzx;
    dzy = ndzy;
  }
  return ESCAPE_INTERIOR;
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

function blendPixelAa(view, aspect, width, height, px, py, aa, maxIter, secondary, opts) {
  const a = Math.max(aa | 0, 1);
  const inv = 1 / a;
  const samples = [];
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
      samples.push(mandelEscape(c.x, c.y, maxIter, secondary, opts));
    }
  }
  return blendEscapeAa(samples, secondary);
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
  colourMode = secondaryCode(SECONDARY_ANGLE),
  stripeFreq = 5,
  stripeWindow = 32,
  deGain = 2,
}) {
  const { secondary, trapShape } = fromColourMode(colourMode);
  const scale = view.scale.toNumber?.() ?? view.scale;
  const opts = {
    stripeFreq,
    stripeWindow,
    deGain,
    trapShape,
    pixel: scale / Math.max(height, 1),
  };
  const x1 = tile.x + tile.w;
  const y1 = tile.y + tile.h;
  for (let py = tile.y; py < y1; py++) {
    for (let px = tile.x; px < x1; px++) {
      const e = blendPixelAa(
        view,
        aspect,
        width,
        height,
        px,
        py,
        aa,
        maxIter,
        secondary,
        opts
      );
      const o = (py * width + px) * 2;
      escape[o] = e.m;
      escape[o + 1] = e.y;
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
