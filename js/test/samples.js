/**
 * Single-sample Mandelbrot for each production algorithm (JS mirrors).
 * Used by the comparison harness — not the live GPU path.
 */

import { Fixed, mandelSmoothFixed, computeReferenceOrbit } from "../math/bigFixed.js";
import { splitDouble } from "../math/splitDouble.js";

const BAIL2 = 256;

function smoothFromMag2(i, mag2) {
  const logZn = Math.log2(mag2) * 0.5;
  return i + 1 - Math.log2(logZn);
}

/** GPU FP32 mirror (Math.fround on every op). */
export function sampleFp32(cx, cy, maxIter) {
  const f = Math.fround;
  let zx = 0;
  let zy = 0;
  const Cx = f(cx);
  const Cy = f(cy);
  for (let i = 0; i < maxIter; i++) {
    const x2 = f(zx * zx);
    const y2 = f(zy * zy);
    const mag2 = f(x2 + y2);
    if (mag2 > BAIL2) return smoothFromMag2(i, mag2);
    zy = f(f(2 * zx * zy) + Cy);
    zx = f(f(x2 - y2) + Cx);
  }
  return -1;
}

/** CPU / JS Number (binary64). */
export function sampleCpuF64(cx, cy, maxIter) {
  let zx = 0;
  let zy = 0;
  for (let i = 0; i < maxIter; i++) {
    const x2 = zx * zx;
    const y2 = zy * zy;
    const mag2 = x2 + y2;
    if (mag2 > BAIL2) return smoothFromMag2(i, mag2);
    zy = 2 * zx * zy + cy;
    zx = x2 - y2 + cx;
  }
  return -1;
}

/** CPU BigInt fixed-point ground truth. */
export function sampleCpuRef(cx, cy, maxIter) {
  return mandelSmoothFixed(Fixed.fromNumber(cx), Fixed.fromNumber(cy), maxIter);
}

// --- float-float (double-double) mirror of floatFloat.wgsl.js ---

function ddFrom(x) {
  const { hi, lo } = splitDouble(x);
  return { hi, lo };
}

function ddQuickTwoSum(a, b) {
  const s = Math.fround(a + b);
  const e = Math.fround(b - Math.fround(s - a));
  return { hi: s, lo: e };
}

function ddTwoSum(a, b) {
  const s = Math.fround(a + b);
  const v = Math.fround(s - a);
  const e = Math.fround(
    Math.fround(a - Math.fround(s - v)) + Math.fround(b - v)
  );
  return { hi: s, lo: e };
}

function ddAdd(a, b) {
  const s = ddTwoSum(a.hi, b.hi);
  const t = ddTwoSum(a.lo, b.lo);
  const s2 = ddQuickTwoSum(s.hi, Math.fround(s.lo + t.hi));
  return ddQuickTwoSum(s2.hi, Math.fround(s2.lo + t.lo));
}

function ddSub(a, b) {
  return ddAdd(a, { hi: Math.fround(-b.hi), lo: Math.fround(-b.lo) });
}

function ddTwoProd(a, b) {
  const p = Math.fround(a * b);
  // fma(a,b,-p) — JS has Math.fma in modern engines
  const e = Math.fround(Math.fma ? Math.fma(a, b, -p) : a * b - p);
  return { hi: p, lo: e };
}

function ddMul(a, b) {
  const p = ddTwoProd(a.hi, b.hi);
  const t = Math.fround(
    Math.fround(Math.fround(a.hi * b.lo) + Math.fround(a.lo * b.hi)) + p.lo
  );
  return ddQuickTwoSum(p.hi, t);
}

function ddMulF32(a, b) {
  const p = ddTwoProd(a.hi, b);
  return ddQuickTwoSum(p.hi, Math.fround(p.lo + Math.fround(a.lo * b)));
}

export function sampleFloatFloat(cx, cy, maxIter) {
  const Cx = ddFrom(cx);
  const Cy = ddFrom(cy);
  let zx = { hi: 0, lo: 0 };
  let zy = { hi: 0, lo: 0 };
  for (let i = 0; i < maxIter; i++) {
    const zx2 = ddMul(zx, zx);
    const zy2 = ddMul(zy, zy);
    const mag2 = ddAdd(zx2, zy2);
    if (mag2.hi > BAIL2) return smoothFromMag2(i, mag2.hi);
    const twoxy = ddMulF32(ddMul(zx, zy), 2);
    const nx = ddAdd(ddSub(zx2, zy2), Cx);
    const ny = ddAdd(twoxy, Cy);
    zx = nx;
    zy = ny;
  }
  return -1;
}

/**
 * Perturbation + rebase mirror. Reference orbit at (refCx, refCy);
 * sample at (cx, cy) via δc = c − C_ref (f32).
 */
export function samplePerturbation(cx, cy, maxIter, refCx, refCy) {
  const f = Math.fround;
  const { zs, len } = computeReferenceOrbit(refCx, refCy, maxIter);
  if (len < 2) return -1;

  let dx = f(cx - refCx);
  let dy = f(cy - refCy);
  // δ_0 = 0; first step uses δc only — start with δ=0 then iterate
  // Production: δ starts 0, dc is offset. So reset:
  const dcx = dx;
  const dcy = dy;
  dx = 0;
  dy = 0;

  let ref = 0;
  for (let i = 0; i < maxIter; i++) {
    let Zx = zs[ref * 2];
    let Zy = zs[ref * 2 + 1];
    const zx = f(Zx + dx);
    const zy = f(Zy + dy);
    const mag2 = f(zx * zx + zy * zy);
    if (mag2 > BAIL2) return smoothFromMag2(i, mag2);
    const dmag2 = f(dx * dx + dy * dy);
    if (ref + 1 >= len || mag2 < dmag2) {
      dx = zx;
      dy = zy;
      ref = 0;
      Zx = 0;
      Zy = 0;
    }
    const d2x = f(dx * dx - dy * dy);
    const d2y = f(2 * dx * dy);
    const twx = f(2 * (Zx * dx - Zy * dy));
    const twy = f(2 * (Zx * dy + Zy * dx));
    dx = f(twx + d2x + dcx);
    dy = f(twy + d2y + dcy);
    ref += 1;
  }
  return -1;
}

/** @type {{ id: string, label: string, sample: Function }[]} */
export const ALGOS = [
  { id: "cpuRef", label: "CPU BigInt (reference)", sample: (p) => sampleCpuRef(p.cx, p.cy, p.maxIter) },
  { id: "cpuF64", label: "CPU f64", sample: (p) => sampleCpuF64(p.cx, p.cy, p.maxIter) },
  { id: "fp32", label: "GPU FP32", sample: (p) => sampleFp32(p.cx, p.cy, p.maxIter) },
  {
    id: "floatFloat",
    label: "GPU float-float",
    sample: (p) => sampleFloatFloat(p.cx, p.cy, p.maxIter),
  },
  {
    id: "perturbation",
    label: "Perturbation",
    sample: (p) =>
      samplePerturbation(p.cx, p.cy, p.maxIter, p.refCx, p.refCy),
  },
  {
    id: "perturbationScaled",
    label: "Perturbation scaled",
    sample: (p) =>
      samplePerturbationScaled(
        p.cx,
        p.cy,
        p.maxIter,
        p.refCx,
        p.refCy,
        p.scale
      ),
  },
];

function frexpJS(x) {
  if (!Number.isFinite(x) || x === 0) return { fract: 0, exp: 0 };
  const sign = x < 0 ? -1 : 1;
  const v = Math.abs(x);
  let exp = Math.floor(Math.log2(v)) + 1;
  let fract = v * 2 ** -exp;
  if (fract >= 1) {
    fract *= 0.5;
    exp += 1;
  } else if (fract > 0 && fract < 0.5) {
    fract *= 2;
    exp -= 1;
  }
  return { fract: sign * fract, exp };
}

function ldexpJS(x, e) {
  if (x === 0 || !Number.isFinite(x)) return x;
  return x * 2 ** e;
}

function cexpNorm(x, y, e) {
  const f = Math.fround;
  const a = Math.max(Math.abs(x), Math.abs(y));
  if (a === 0) return { x: 0, y: 0, e: 0 };
  if (!Number.isFinite(a)) return { x: a, y: a, e };
  const fr = frexpJS(a);
  return {
    x: f(ldexpJS(x, -fr.exp)),
    y: f(ldexpJS(y, -fr.exp)),
    e: e + fr.exp,
  };
}

function cexpAdd(a, b) {
  if (a.x === 0 && a.y === 0) return b;
  if (b.x === 0 && b.y === 0) return a;
  const e = Math.max(a.e, b.e);
  return cexpNorm(
    ldexpJS(a.x, a.e - e) + ldexpJS(b.x, b.e - e),
    ldexpJS(a.y, a.e - e) + ldexpJS(b.y, b.e - e),
    e
  );
}

function cexpMag2Gt(x, y, e, thresh) {
  const m2 = x * x + y * y;
  if (!(m2 > 0)) return false;
  const fr = frexpJS(m2);
  const tr = frexpJS(thresh);
  const ea = fr.exp + 2 * e;
  if (ea > tr.exp) return true;
  if (ea < tr.exp) return false;
  return fr.fract > tr.fract;
}

function cexpToF32(x, y, e) {
  const f = Math.fround;
  if (e < -126) return { x: 0, y: 0 };
  if (e > 127) return { x: f(x * 1e30), y: f(y * 1e30) };
  return { x: f(ldexpJS(x, e)), y: f(ldexpJS(y, e)) };
}

/**
 * Scaled perturbation mirror: Δ = mantissa·2^e, scale = sm·2^se.
 * Optional dcScreen = {x,y} supplies Δc directly (needed past ~1e-15 where
 * (cx-ref)/scale is lost in f64 absolute coordinates).
 */
export function samplePerturbationScaled(
  cx,
  cy,
  maxIter,
  refCx,
  refCy,
  scale,
  dcScreen = null
) {
  const f = Math.fround;
  const { zs, len, escaped: refEscaped } = computeReferenceOrbit(
    refCx,
    refCy,
    maxIter
  );
  if (len < 2 || !(scale > 0)) return -1;

  const fe = frexpJS(scale);
  const sm = f(fe.fract);
  const se = fe.exp;
  if (sm === 0) return -1;

  const dcx = f(dcScreen ? dcScreen.x : (cx - refCx) / scale);
  const dcy = f(dcScreen ? dcScreen.y : (cy - refCy) / scale);
  let dx = 0;
  let dy = 0;
  let de = 0;
  let ref = 0;

  for (let i = 0; i < maxIter; i++) {
    let Zx = zs[ref * 2];
    let Zy = zs[ref * 2 + 1];
    let del = cexpNorm(sm * dx, sm * dy, se + de);

    if (cexpMag2Gt(del.x, del.y, del.e, BAIL2)) {
      const dv = cexpToF32(del.x, del.y, del.e);
      let mag2 = dv.x * dv.x + dv.y * dv.y;
      if (!Number.isFinite(mag2) || mag2 > 1e20) mag2 = 1e10;
      return smoothFromMag2(i, mag2);
    }

    const dvec = cexpToF32(del.x, del.y, del.e);
    const zx = f(Zx + dvec.x);
    const zy = f(Zy + dvec.y);
    let mag2 = f(zx * zx + zy * zy);
    if (mag2 > BAIL2) {
      if (!Number.isFinite(mag2) || mag2 > 1e20) mag2 = 1e10;
      return smoothFromMag2(i, mag2);
    }

    const dmag2 = dvec.x * dvec.x + dvec.y * dvec.y;
    const refEnd = ref + 1 >= len;
    const glitch = dmag2 > 0 && mag2 < dmag2;

    if (refEnd && dmag2 === 0) {
      // δ flushed — cannot rebase without wiping Δc; follow reference.
      if (refEscaped) return smoothFromMag2(i, Math.max(mag2, BAIL2));
      return -1;
    }

    if (refEnd || glitch) {
      const inv = 1 / sm;
      const reb = cexpNorm(zx * inv, zy * inv, -se);
      dx = reb.x;
      dy = reb.y;
      de = reb.e;
      del = cexpNorm(sm * dx, sm * dy, se + de);
      ref = 0;
      Zx = 0;
      Zy = 0;
    }

    const t1 = cexpNorm(
      2 * (Zx * dx - Zy * dy),
      2 * (Zx * dy + Zy * dx),
      de
    );
    const t2 = cexpNorm(
      del.x * dx - del.y * dy,
      del.x * dy + del.y * dx,
      del.e + de
    );
    const sum = cexpAdd(cexpAdd(t1, t2), { x: dcx, y: dcy, e: 0 });
    dx = sum.x;
    dy = sum.y;
    de = sum.e;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      return smoothFromMag2(i, 1e10);
    }
    ref += 1;
  }
  return -1;
}
