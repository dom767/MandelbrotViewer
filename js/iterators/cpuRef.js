import { complexFromPixelFixed, Fixed } from "../math/bigFixed.js";
import {
  escapeSample,
  ESCAPE_INTERIOR,
  blendEscapeAa,
  stripeTerm,
  createStripeWin,
  stripeWinMean,
  stripeWinAdd,
  trapDistForMode,
  finishSecondary,
  SECONDARY_STRIPES,
  SECONDARY_TRAP,
  SECONDARY_TRAP_O,
  SECONDARY_DE,
  SECONDARY_FLAT,
  SECONDARY_ANGLE,
  normalizeSecondary,
  isTrapSecondary,
} from "../color/smooth.js";
import { secondaryCode } from "../color/secondary.js";

/**
 * Ground-truth Mandelbrot on the CPU using BigInt fixed-point (FRAC_BITS).
 * Slow — intended for validating GPU iterators, not interactive deep zooms.
 *
 * Escape buffer is interleaved Float32Array: [m0, y0, m1, y1, ...]
 * (y = packed angle/weight or scalar secondary, see js/color/smooth.js).
 * AA averages escaped samples only (matches mandelCommon.wgsl.js).
 */

const BAIL2 = 256;

const SEC_BY_CODE = {
  0: SECONDARY_FLAT,
  1: SECONDARY_ANGLE,
  2: SECONDARY_STRIPES,
  3: SECONDARY_DE,
  4: SECONDARY_TRAP,
  5: SECONDARY_TRAP_O,
};

function secondaryFromColourMode(colourMode) {
  if (typeof colourMode === "string") return normalizeSecondary(colourMode);
  return SEC_BY_CODE[colourMode | 0] ?? SECONDARY_ANGLE;
}

function mandelEscapeFixed(cx, cy, maxIter, secondary, opts) {
  const Cx = cx instanceof Fixed ? cx : Fixed.fromNumber(cx);
  const Cy = cy instanceof Fixed ? cy : Fixed.fromNumber(cy);
  let zx = Fixed.zero();
  let zy = Fixed.zero();
  let dzx = 1;
  let dzy = 0;
  const bailRaw = Fixed.fromNumber(BAIL2).raw;
  let sw = null;
  let sprev = 0.5;
  let sfull = 0.5;
  let trapMin = 1e20;
  const mode = normalizeSecondary(secondary);

  for (let i = 0; i < maxIter; i++) {
    const zx2 = zx.mul(zx);
    const zy2 = zy.mul(zy);
    const mag2Raw = zx2.raw + zy2.raw;
    const zxn = zx.toNumber();
    const zyn = zy.toNumber();
    const mag2 = new Fixed(mag2Raw).toNumber();
    if (mode === SECONDARY_STRIPES && i > 0) {
      if (!sw) sw = createStripeWin();
      const term = stripeTerm(zxn, zyn, opts.stripeFreq);
      sprev = sw.len > 0 ? stripeWinMean(sw) : term;
      stripeWinAdd(sw, term, opts.stripeWindow);
      sfull = stripeWinMean(sw);
    }
    if (isTrapSecondary(mode) && i > 0) {
      trapMin = Math.min(trapMin, trapDistForMode(mode, zxn, zyn));
    }
    if (mag2Raw > bailRaw) {
      const s = escapeSample(i, zxn, zyn, mag2);
      return finishSecondary(s, mode, {
        sprev,
        sfull,
        zx: zxn,
        zy: zyn,
        mag2,
        dzx,
        dzy,
        pixel: opts.pixel,
        deGain: opts.deGain,
        trapMin,
      });
    }
    const ndzx = 2 * (zxn * dzx - zyn * dzy) + 1;
    const ndzy = 2 * (zxn * dzy + zyn * dzx);
    const twoxy = zx.mul(zy);
    const nx = zx2.sub(zy2).add(Cx);
    const ny = twoxy.add(twoxy).add(Cy);
    zx = nx;
    zy = ny;
    dzx = ndzx;
    dzy = ndzy;
  }
  return ESCAPE_INTERIOR;
}

function blendPixelAa(view, aspect, width, height, px, py, aa, maxIter, secondary, opts) {
  const a = Math.max(aa | 0, 1);
  const inv = 1 / a;
  const samples = [];
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
      samples.push(mandelEscapeFixed(c.x, c.y, maxIter, secondary, opts));
    }
  }
  return blendEscapeAa(samples, secondary);
}

/**
 * Fill one tile of the interleaved escape image (width × height × 2 floats).
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
  colourMode = secondaryCode(SECONDARY_ANGLE),
  stripeFreq = 5,
  stripeWindow = 32,
  deGain = 2,
}) {
  const secondary = secondaryFromColourMode(colourMode);
  const scale = view.scale.toNumber?.() ?? Number(view.scale);
  const opts = {
    stripeFreq,
    stripeWindow,
    deGain,
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

export const cpuRefIterator = {
  id: "cpuRef",
  label: "CPU BigInt (reference)",
  precisionHint: "bigint-fixed",
  supportsDeepZoom: true,
  /** Scheduler runs fillTile on the CPU and uploads to the escape buffer. */
  runOnCpu: true,
  fillTile: fillTileCpuRef,
};
