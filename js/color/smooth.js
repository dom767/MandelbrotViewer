/**
 * Continuous-iteration + secondary-axis helpers for CPU iterators.
 * Mirrors escapeSampleWgsl in js/iterators/mandelCommon.wgsl.js.
 */

import {
  SECONDARY_FLAT,
  SECONDARY_ANGLE,
  SECONDARY_STRIPES,
  SECONDARY_DE,
  SECONDARY_TRAP,
  TRAP_SHAPE_CROSS,
  TRAP_SHAPE_CIRCLE,
  normalizeSecondary,
  normalizeTrapShape,
  secondaryColourKind,
  isTrapSecondary,
} from "./secondary.js";

const TAU = Math.PI * 2;

function wrap01(x) {
  return x - Math.floor(x);
}

export function smoothFromEscape(n, mag2) {
  if (n < 0) return -1;
  const logZn = Math.log2(mag2) * 0.5;
  return n + 1 - Math.log2(logZn);
}

/** Escape sample at iteration i: smooth iter, angle01, band weight, band. */
export function escapeSample(i, zx, zy, mag2) {
  const ll = Math.log2(0.5 * Math.log2(mag2));
  return {
    m: i + 1 - ll,
    angle: wrap01(Math.atan2(zy, zx) / TAU),
    w: Math.min(1, Math.max(0, 3 - ll)),
    band: i,
  };
}

export const ESCAPE_INTERIOR = { m: -1, angle: 0, w: 0, band: 0 };

/** @deprecated use secondary axis codes */
export const COLOUR_MODE_ANGLE = 0;
export const COLOUR_MODE_STRIPE = 1;

export const STRIPE_WIN_MAX = 64;

export function stripeTerm(zx, zy, freq) {
  return 0.5 + 0.5 * Math.sin(freq * Math.atan2(zy, zx));
}

export function createStripeWin() {
  return { buf: new Float64Array(STRIPE_WIN_MAX), len: 0, pos: 0, sum: 0 };
}

export function stripeWinMean(w) {
  return w.len === 0 ? 0.5 : w.sum / w.len;
}

export function stripeWinAdd(w, term, capacity) {
  const cap = Math.min(STRIPE_WIN_MAX, Math.max(1, capacity | 0));
  if (w.len === cap) w.sum -= w.buf[w.pos];
  else w.len += 1;
  w.buf[w.pos] = term;
  w.sum += term;
  w.pos = (w.pos + 1) % cap;
  return w;
}

export function stripeFinish(s, full, prev) {
  return { ...s, stripe: prev + (full - prev) * s.w, y: prev + (full - prev) * s.w };
}

export function mapDe(zx, zy, mag2, dzx, dzy, pixel, gain) {
  const mag = Math.sqrt(Math.max(mag2, 1e-30));
  const dmag = Math.max(Math.hypot(dzx, dzy), 1e-30);
  const de = (2 * mag * Math.log(mag)) / dmag;
  const r = de / Math.max(pixel, 1e-30);
  const t = Math.log(r + Math.sqrt(r * r + 1)); // asinh
  const span = Math.max(gain, 0.25) * 5.0;
  return Math.min(1, Math.max(0, t / span));
}

/** Cross trap (+): distance to nearest coordinate axis. */
export function trapDistCross(zx, zy) {
  return Math.min(Math.abs(zx), Math.abs(zy));
}

/** Circle trap (o): distance to the circle |z| = 0.5. */
export function trapDistCircle(zx, zy) {
  return Math.abs(Math.hypot(zx, zy) - 0.5);
}

export function trapDistForShape(shape, zx, zy) {
  return normalizeTrapShape(shape) === TRAP_SHAPE_CIRCLE
    ? trapDistCircle(zx, zy)
    : trapDistCross(zx, zy);
}

/** @deprecated use trapDistForShape */
export function trapDistForMode(_secondary, zx, zy) {
  return trapDistForShape(TRAP_SHAPE_CROSS, zx, zy);
}

/** @deprecated use trapDistCross */
export const trapDist = trapDistCross;

/** Close approaches → bright; soft falloff. */
export function mapTrap(trapMin) {
  return 1 / (1 + trapMin * 10);
}

/**
 * Finish escape sample for the given secondary axis.
 * Sets `.y` for the escape buffer (packed angle or scalar).
 */
export function finishSecondary(s, secondary, extras = {}) {
  const mode = normalizeSecondary(secondary);
  if (mode === SECONDARY_FLAT) {
    return { ...s, y: 0.5, stripe: 0.5 };
  }
  if (mode === SECONDARY_STRIPES) {
    const y = extras.sprev + (extras.sfull - extras.sprev) * s.w;
    return { ...s, y, stripe: y };
  }
  if (mode === SECONDARY_DE) {
    const y = mapDe(
      extras.zx,
      extras.zy,
      extras.mag2,
      extras.dzx,
      extras.dzy,
      extras.pixel,
      extras.deGain ?? 2
    );
    return { ...s, y, stripe: y };
  }
  if (isTrapSecondary(mode)) {
    const y = mapTrap(extras.trapMin);
    return { ...s, y, stripe: y };
  }
  // angle — pack later in blendEscapeAa
  return { ...s, y: null };
}

export function packAngleWeight(a, w) {
  const qa = Math.min(Math.floor(wrap01(a) * 65536), 65535);
  const qw = Math.round(Math.min(1, Math.max(0, w)) * 127);
  return qa + qw * 65536;
}

export function unpackAngleWeight(y) {
  const p = y >>> 0;
  return { angle: (p & 0xffff) / 65536, w: (p >>> 16) / 127 };
}

/**
 * AA-blend escape samples. Returns `{ m, y }` for the escape buffer.
 */
export function blendEscapeAa(samples, secondary = SECONDARY_ANGLE) {
  const kind = secondaryColourKind(secondary);
  if (kind !== "angle") {
    let sumM = 0;
    let sumS = 0;
    let count = 0;
    for (const s of samples) {
      if (s.m < 0) continue;
      sumM += s.m;
      sumS += s.y ?? s.stripe ?? 0.5;
      count += 1;
    }
    return count === 0 ? { m: -1, y: 0 } : { m: sumM / count, y: sumS / count };
  }
  let sumM = 0;
  let cs = 0;
  let sn = 0;
  let sumW = 0;
  let band = 0;
  let count = 0;
  for (const s of samples) {
    if (s.m < 0) continue;
    let a = s.angle;
    let w = s.w;
    if (count === 0) {
      band = s.band;
    } else if (s.band < band) {
      a = wrap01(a * 2 ** Math.min(band - s.band, 16));
      w = 0;
    } else if (s.band > band) {
      const r = Math.hypot(cs, sn);
      const phi = Math.atan2(sn, cs) * 2 ** Math.min(s.band - band, 16);
      cs = r * Math.cos(phi);
      sn = r * Math.sin(phi);
      sumW = 0;
      band = s.band;
    }
    sumM += s.m;
    cs += Math.cos(a * TAU);
    sn += Math.sin(a * TAU);
    sumW += w;
    count += 1;
  }
  if (count === 0) return { m: -1, y: 0 };
  return {
    m: sumM / count,
    y: packAngleWeight(Math.atan2(sn, cs) / TAU, sumW / count),
  };
}

export {
  SECONDARY_FLAT,
  SECONDARY_ANGLE,
  SECONDARY_STRIPES,
  SECONDARY_DE,
  SECONDARY_TRAP,
  TRAP_SHAPE_CROSS,
  TRAP_SHAPE_CIRCLE,
  normalizeSecondary,
  normalizeTrapShape,
  isTrapSecondary,
};
