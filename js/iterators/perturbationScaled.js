import { ITERATE_PARAMS_SIZE } from "./params.js";
import { escapeSampleWgsl } from "./mandelCommon.wgsl.js";

/**
 * Scaled perturbation: same CPU BigInt reference as "perturbation", but the GPU
 * iterates Δ = δ / scale so Δc is O(1) in screen space.
 *
 * Δ is stored as mantissa × 2^e so rebase (Δ ← z/scale) does not hit the f32
 * ceiling at zoom ~3e38. Scale is uploaded as frexp (mant, exp) rather than a
 * single f32, so denormal flush cannot zero it (camera floor ~1e-90).
 *
 * Recurrence:  Δ' = 2 Z Δ + scale·Δ² + Δc
 * Escape:      |δ|² > 256 (CExp) or |Z + δ_f32|² > 256
 * Rebase:      Δ ← Δ + Z/scale  (CExp), then Z ← 0
 *
 * Deep zoom: δ = scale·Δ underflows f32 past ~1e38×. Rebase Δ←z/scale then
 * makes |Δ|~1/scale, so Δc is lost in the f32 mantissa and every pixel
 * collapses to the reference. When δ does not materialize, do not rebase —
 * inherit the reference outcome (escaped bit in refLen high bit).
 *
 * Params: scale = mantissa, scaleLo = binary exp; refLen high bit = refEscaped.
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
  colourMode: u32,
  stripeFreq: f32,
  stripeWindow: u32,
  deGain: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> escape: array<vec2f>;
@group(0) @binding(2) var<storage, read> refOrbit: array<vec2f>;

${escapeSampleWgsl}

/** Complex value = (x + i y) · 2^e */
struct CExp {
  x: f32,
  y: f32,
  e: i32,
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
fn mandel_smooth_pert_scaled(
  dc: vec2f,
  ref_len: u32,
  ref_escaped: bool,
  sm: f32,
  se: i32
) -> vec4f {
  if (ref_len < 2u || sm == 0.0) {
    return ESCAPE_INTERIOR;
  }
  let mode = params.colourMode;
  var dx = 0.0;
  var dy = 0.0;
  var de: i32 = 0;
  var ref_i: u32 = 0u;
  var i: u32 = 0u;
  var mag2 = 0.0;
  var zx = 0.0;
  var zy = 0.0;
  var dzx = 1.0;
  var dzy = 0.0;
  var sw = stripe_win_new();
  var sprev = 0.5;
  var sfull = 0.5;
  var trap_min = 1e20;

  loop {
    if (i >= params.maxIter) {
      return ESCAPE_INTERIOR;
    }
    var Z = refOrbit[ref_i];

    // δ = scale · Δ = (sm·m) · 2^{se+de}
    var del = cexp_norm(sm * dx, sm * dy, se + de);
    let dvec = cexp_to_f32(del.x, del.y, del.e);
    zx = Z.x + dvec.x;
    zy = Z.y + dvec.y;
    if (mode == SEC_STRIPES && i > 0u) {
      let term = stripe_term(zx, zy, params.stripeFreq);
      sprev = select(term, stripe_win_mean(&sw), sw.len > 0u);
      stripe_win_add(&sw, term, params.stripeWindow);
      sfull = stripe_win_mean(&sw);
    }
    if (is_trap_mode(mode) && i > 0u) {
      trap_min = min(trap_min, trap_dist_for_mode(mode, zx, zy));
    }

    if (cexp_mag2_gt(del.x, del.y, del.e, 256.0)) {
      mag2 = dvec.x * dvec.x + dvec.y * dvec.y;
      if (!(mag2 > 0.0) || !(mag2 <= 1e20)) {
        mag2 = 1e10;
      }
      break;
    }

    mag2 = zx * zx + zy * zy;
    if (mag2 > 256.0) {
      if (!(mag2 <= 1e20)) {
        mag2 = 1e10;
      }
      break;
    }

    let dmag2 = dvec.x * dvec.x + dvec.y * dvec.y;
    let ref_end = ref_i + 1u >= ref_len;
    let glitch = dmag2 > 0.0 && mag2 < dmag2;

    if (ref_end && dmag2 == 0.0) {
      // δ flushed out of f32: cannot rebase without |Δ|~1/scale wiping Δc.
      // Pixel still tracks the reference — inherit its termination.
      if (ref_escaped) {
        mag2 = max(mag2, 256.0);
        break;
      }
      return ESCAPE_INTERIOR;
    }

    if (ref_end || glitch) {
      // δ is representable: safe to fold z into Δ.
      let inv = 1.0 / sm;
      let rebased = cexp_norm(zx * inv, zy * inv, -se);
      dx = rebased.x;
      dy = rebased.y;
      de = rebased.e;
      del = cexp_norm(sm * dx, sm * dy, se + de);
      ref_i = 0u;
      Z = vec2f(0.0, 0.0);
    }

    let ndzx = 2.0 * (zx * dzx - zy * dzy) + 1.0;
    let ndzy = 2.0 * (zx * dzy + zy * dzx);
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
    dzx = ndzx;
    dzy = ndzy;
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
  let s = escape_sample(i, zx, zy, mag2);
  if (mode == SEC_FLAT) {
    return vec4f(s.x, 0.5, s.z, s.w);
  }
  if (mode == SEC_STRIPES) {
    return stripe_finish(s, sfull, sprev);
  }
  if (mode == SEC_DE) {
    let pixel = (sm * exp2(f32(se))) / max(f32(params.resolution.y), 1.0);
    let v = map_de(zx, zy, mag2, dzx, dzy, pixel, params.deGain);
    return vec4f(s.x, v, s.z, s.w);
  }
  if (is_trap_mode(mode)) {
    return vec4f(s.x, map_trap(trap_min), s.z, s.w);
  }
  return s;
}

fn blend_pixel_aa_pert_scaled(
  sm: f32,
  se: i32,
  aspect: f32,
  resolution: vec2f,
  px: u32,
  py: u32,
  aa: u32,
  ref_len: u32,
  ref_escaped: bool
) -> vec2f {
  let a = max(aa, 1u);
  let inv_aa = 1.0 / f32(a);
  let scalar = is_scalar_secondary(params.colourMode);
  var acc = esc_acc_new();
  for (var sy = 0u; sy < a; sy = sy + 1u) {
    for (var sx = 0u; sx < a; sx = sx + 1u) {
      let dc = delta_c_from_pixel(
        aspect, resolution,
        px, py,
        (f32(sx) + 0.5) * inv_aa,
        (f32(sy) + 0.5) * inv_aa
      );
      acc = esc_acc_add(acc, mandel_smooth_pert_scaled(dc, ref_len, ref_escaped, sm, se), scalar);
    }
  }
  return esc_acc_finish(acc, scalar);
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
  let ref_len = params.refLen & 0x7fffffffu;
  let ref_escaped = (params.refLen & 0x80000000u) != 0u;
  escape[idx] = blend_pixel_aa_pert_scaled(
    sm,
    se,
    params.aspect,
    res,
    px,
    py,
    params.aa,
    ref_len,
    ref_escaped
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
