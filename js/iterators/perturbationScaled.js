import { ITERATE_PARAMS_SIZE } from "./params.js";

/**
 * Scaled perturbation: same CPU BigInt reference as "perturbation", but the GPU
 * iterates Δ = δ / scale so Δc is O(1) in screen space.
 *
 * Δ is stored as mantissa × 2^e so rebase (Δ ← z/scale) does not hit the f32
 * ceiling at zoom ~3e38. Scale is uploaded as frexp (mant, exp) rather than a
 * single f32, so denormal flush cannot zero it (camera floor ~1e-90).
 *
 * Recurrence:  Δ' = 2 Z Δ + scale·Δ² + Δc
 * Escape:      |δ|² > 256 or |Z + δ|² > 256
 * Rebase:      Δ ← z/scale on glitch / ref-end
 *
 * Params: scale = mantissa in [0.5,1), scaleLo = binary exponent (as f32).
 * Bind group: 0 params, 1 escape, 2 refOrbit.
 */

export const iterateWgsl = /* wgsl */ `
struct Params {
  center: vec2f,
  scale: f32,
  aspect: f32,
  resolution: vec2u,
  tileOrigin: vec2u,
  tileSize: vec2u,
  maxIter: u32,
  aa: u32,
  centerLo: vec2f,
  scaleLo: f32,
  refLen: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> escape: array<f32>;
@group(0) @binding(2) var<storage, read> refOrbit: array<vec2f>;

/** Complex value = (x + i y) · 2^e */
struct CExp {
  x: f32,
  y: f32,
  e: i32,
}

fn smooth_from_mag2(i: u32, mag2: f32) -> f32 {
  let log_zn = log2(mag2) * 0.5;
  return f32(i) + 1.0 - log2(log_zn);
}

fn cexp_norm(x: f32, y: f32, e: i32) -> CExp {
  let a = max(abs(x), abs(y));
  if (a == 0.0) {
    return CExp(0.0, 0.0, 0);
  }
  if (!(a == a)) {
    return CExp(a, a, e);
  }
  let fr = frexp(a);
  return CExp(ldexp(x, -fr.exp), ldexp(y, -fr.exp), e + fr.exp);
}

fn cexp_add(a: CExp, b: CExp) -> CExp {
  let a0 = (a.x == 0.0) && (a.y == 0.0);
  let b0 = (b.x == 0.0) && (b.y == 0.0);
  if (a0) { return b; }
  if (b0) { return a; }
  let e = max(a.e, b.e);
  let ax = ldexp(a.x, a.e - e);
  let ay = ldexp(a.y, a.e - e);
  let bx = ldexp(b.x, b.e - e);
  let by = ldexp(b.y, b.e - e);
  return cexp_norm(ax + bx, ay + by, e);
}

/** True if |(x+iy)·2^e|² > thresh (avoids overflowing the squared magnitude). */
fn cexp_mag2_gt(x: f32, y: f32, e: i32, thresh: f32) -> bool {
  let m2 = x * x + y * y;
  if (!(m2 > 0.0)) {
    return false;
  }
  let fr = frexp(m2);
  let tr = frexp(thresh);
  let ea = fr.exp + 2 * e;
  if (ea > tr.exp) { return true; }
  if (ea < tr.exp) { return false; }
  return fr.fract > tr.fract;
}

/** Materialize mantissa·2^e into f32 (0 if underflow, large if overflow). */
fn cexp_to_f32(x: f32, y: f32, e: i32) -> vec2f {
  if (e < -126) {
    return vec2f(0.0, 0.0);
  }
  if (e > 127) {
    let s = 1e30;
    return vec2f(x * s, y * s);
  }
  return vec2f(ldexp(x, e), ldexp(y, e));
}

/** Δc in screen units (not multiplied by scale). */
fn delta_c_from_pixel(
  aspect: f32,
  resolution: vec2f,
  px: u32,
  py: u32,
  sx_off: f32,
  sy_off: f32
) -> vec2f {
  let u = (f32(px) + sx_off) / resolution.x;
  let v = (f32(py) + sy_off) / resolution.y;
  return vec2f(
    (u - 0.5),
    -(v - 0.5) / aspect
  );
}

/**
 * Scaled perturbation with exponent-separated Δ = (dx,dy)·2^de.
 * Scale = sm · 2^se (sm in [0.5, 1)).
 */
fn mandel_smooth_pert_scaled(dc: vec2f, ref_len: u32, sm: f32, se: i32) -> f32 {
  if (ref_len < 2u || sm == 0.0) {
    return -1.0;
  }
  var dx = 0.0;
  var dy = 0.0;
  var de: i32 = 0;
  var ref_i: u32 = 0u;
  var i: u32 = 0u;
  var mag2 = 0.0;

  loop {
    if (i >= params.maxIter) {
      return -1.0;
    }
    var Z = refOrbit[ref_i];

    // δ = scale · Δ = (sm·m) · 2^{se+de}
    var del = cexp_norm(sm * dx, sm * dy, se + de);

    if (cexp_mag2_gt(del.x, del.y, del.e, 256.0)) {
      let dv = cexp_to_f32(del.x, del.y, del.e);
      mag2 = dv.x * dv.x + dv.y * dv.y;
      if (!(mag2 > 0.0) || !(mag2 <= 1e20)) {
        mag2 = 1e10;
      }
      break;
    }

    let dvec = cexp_to_f32(del.x, del.y, del.e);
    let zx = Z.x + dvec.x;
    let zy = Z.y + dvec.y;
    mag2 = zx * zx + zy * zy;
    if (mag2 > 256.0) {
      if (!(mag2 <= 1e20)) {
        mag2 = 1e10;
      }
      break;
    }

    let dmag2 = dvec.x * dvec.x + dvec.y * dvec.y;
    if (ref_i + 1u >= ref_len || mag2 < dmag2) {
      // Δ ← z/scale = (z/sm) · 2^{-se}
      let inv = 1.0 / sm;
      let rebased = cexp_norm(zx * inv, zy * inv, -se);
      dx = rebased.x;
      dy = rebased.y;
      de = rebased.e;
      del = cexp_norm(sm * dx, sm * dy, se + de);
      ref_i = 0u;
      Z = vec2f(0.0, 0.0);
    }

    // t1 = 2 Z Δ
    let t1 = cexp_norm(
      2.0 * (Z.x * dx - Z.y * dy),
      2.0 * (Z.x * dy + Z.y * dx),
      de
    );
    // t2 = scale·Δ² = δ·Δ
    let t2 = cexp_norm(
      del.x * dx - del.y * dy,
      del.x * dy + del.y * dx,
      del.e + de
    );
    // t3 = Δc
    let t3 = CExp(dc.x, dc.y, 0);
    let sum = cexp_add(cexp_add(t1, t2), t3);
    dx = sum.x;
    dy = sum.y;
    de = sum.e;
    if (!(dx == dx) || !(dy == dy)) {
      mag2 = 1e10;
      break;
    }
    ref_i = ref_i + 1u;
    i = i + 1u;
  }
  if (!(mag2 > 0.0) || !(mag2 <= 1e20)) {
    mag2 = 1e10;
  }
  return smooth_from_mag2(i, mag2);
}

fn blend_pixel_aa_pert_scaled(
  sm: f32,
  se: i32,
  aspect: f32,
  resolution: vec2f,
  px: u32,
  py: u32,
  aa: u32,
  ref_len: u32
) -> f32 {
  let a = max(aa, 1u);
  let inv_aa = 1.0 / f32(a);
  var sum = 0.0;
  var escaped = 0u;
  for (var sy = 0u; sy < a; sy = sy + 1u) {
    for (var sx = 0u; sx < a; sx = sx + 1u) {
      let dc = delta_c_from_pixel(
        aspect, resolution,
        px, py,
        (f32(sx) + 0.5) * inv_aa,
        (f32(sy) + 0.5) * inv_aa
      );
      let m = mandel_smooth_pert_scaled(dc, ref_len, sm, se);
      if (m >= 0.0) {
        sum = sum + m;
        escaped = escaped + 1u;
      }
    }
  }
  if (escaped == 0u) {
    return -1.0;
  }
  return sum / f32(escaped);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.tileSize.x || gid.y >= params.tileSize.y) {
    return;
  }

  let px = params.tileOrigin.x + gid.x;
  let py = params.tileOrigin.y + gid.y;
  if (px >= params.resolution.x || py >= params.resolution.y) {
    return;
  }

  let res = vec2f(f32(params.resolution.x), f32(params.resolution.y));
  let idx = py * params.resolution.x + px;
  // scale = params.scale · 2^i32(scaleLo)  (frexp upload)
  let sm = params.scale;
  let se = i32(params.scaleLo);
  escape[idx] = blend_pixel_aa_pert_scaled(
    sm,
    se,
    params.aspect,
    res,
    px,
    py,
    params.aa,
    params.refLen
  );
}
`;

export const perturbationScaledIterator = {
  id: "perturbationScaled",
  label: "Perturbation scaled (CPU ref + GPU Δ)",
  precisionHint: "perturbation-scaled",
  supportsDeepZoom: true,
  needsReferenceOrbit: true,
  /** Pack scale as frexp (mant, exp) instead of float-float hi/lo. */
  scaleAsFrexp: true,
  wgsl: iterateWgsl,
  entryPoint: "main",
  paramsSize: ITERATE_PARAMS_SIZE,
};
