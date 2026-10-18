import { ITERATE_PARAMS_SIZE } from "./params.js";
import { escapeSampleWgsl } from "./mandelCommon.wgsl.js";

/**
 * Perturbation Mandelbrot: high-precision reference orbit on the CPU (BigInt
 * fixed-point), GPU iterates δ_{n+1} = 2 Z_n δ_n + δ_n² + δc in f32, with
 * rebasing so an early-escaping reference or a glitch region cannot corrupt
 * the result.
 *
 * Bind group: 0 params, 1 escape (array<vec2f>), 2 refOrbit (array<vec2f> of Z_n).
 * Uniform pad field carries refLen (u32).
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

/** δc for a subpixel sample relative to the reference at view center. */
fn delta_c_from_pixel(
  scale: f32,
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
    (u - 0.5) * scale,
    -(v - 0.5) * (scale / aspect)
  );
}

/**
 * Perturbed iteration with rebasing (Zhuoran). The pixel orbit z = Z_ref + δ
 * follows the reference; when the reference is about to run out, or when
 * |z| < |δ| (the orbit has drifted away from the reference and the delta
 * formula is losing precision), we fold the reference into δ (δ ← z) and
 * restart the reference at index 0 (Z_0 = 0). The true iteration count
 * keeps running independently of the reference index.
 */
fn mandel_smooth_pert(dc: vec2f, ref_len: u32) -> vec4f {
  if (ref_len < 2u) {
    return ESCAPE_INTERIOR;
  }
  let mode = params.colourMode;
  var dx = 0.0;
  var dy = 0.0;
  // Note: "ref" is a reserved keyword in WGSL — use ref_i.
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
    zx = Z.x + dx;
    zy = Z.y + dy;
    mag2 = zx * zx + zy * zy;
    if (mode == SEC_STRIPES && i > 0u) {
      let term = stripe_term(zx, zy, params.stripeFreq);
      sprev = select(term, stripe_win_mean(&sw), sw.len > 0u);
      stripe_win_add(&sw, term, params.stripeWindow);
      sfull = stripe_win_mean(&sw);
    }
    if (is_trap_mode(mode) && i > 0u) {
      trap_min = min(trap_min, trap_dist_for_mode(mode, zx, zy));
    }
    if (mag2 > 256.0) {
      break;
    }
    let dmag2 = dx * dx + dy * dy;
    if (ref_i + 1u >= ref_len || mag2 < dmag2) {
      // Rebase: δ becomes the full orbit, reference restarts at Z_0 = 0.
      dx = zx;
      dy = zy;
      ref_i = 0u;
      Z = vec2f(0.0, 0.0);
    }
    // z' = 2 z z' + 1 (on reconstructed z)
    let ndzx = 2.0 * (zx * dzx - zy * dzy) + 1.0;
    let ndzy = 2.0 * (zx * dzy + zy * dzx);
    // δ' = 2 Z δ + δ² + δc
    let d2x = dx * dx - dy * dy;
    let d2y = 2.0 * dx * dy;
    let twx = 2.0 * (Z.x * dx - Z.y * dy);
    let twy = 2.0 * (Z.x * dy + Z.y * dx);
    dx = twx + d2x + dc.x;
    dy = twy + d2y + dc.y;
    dzx = ndzx;
    dzy = ndzy;
    ref_i = ref_i + 1u;
    i = i + 1u;
  }
  let s = escape_sample(i, zx, zy, mag2);
  if (mode == SEC_FLAT) {
    return vec4f(s.x, 0.5, s.z, s.w);
  }
  if (mode == SEC_STRIPES) {
    return stripe_finish(s, sfull, sprev);
  }
  if (mode == SEC_DE) {
    let pixel = params.scale / max(f32(params.resolution.y), 1.0);
    let v = map_de(zx, zy, mag2, dzx, dzy, pixel, params.deGain);
    return vec4f(s.x, v, s.z, s.w);
  }
  if (is_trap_mode(mode)) {
    return vec4f(s.x, map_trap(trap_min), s.z, s.w);
  }
  return s;
}

fn blend_pixel_aa_pert(
  scale: f32,
  aspect: f32,
  resolution: vec2f,
  px: u32,
  py: u32,
  aa: u32,
  ref_len: u32
) -> vec2f {
  let a = max(aa, 1u);
  let inv_aa = 1.0 / f32(a);
  let scalar = is_scalar_secondary(params.colourMode);
  var acc = esc_acc_new();
  for (var sy = 0u; sy < a; sy = sy + 1u) {
    for (var sx = 0u; sx < a; sx = sx + 1u) {
      let dc = delta_c_from_pixel(
        scale, aspect, resolution,
        px, py,
        (f32(sx) + 0.5) * inv_aa,
        (f32(sy) + 0.5) * inv_aa
      );
      acc = esc_acc_add(acc, mandel_smooth_pert(dc, ref_len), scalar);
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
  // Reference is at view center; scale hi is enough for δc (small offsets).
  let sc = params.scale + params.scaleLo;
  escape[idx] = blend_pixel_aa_pert(
    sc,
    params.aspect,
    res,
    px,
    py,
    params.aa,
    params.refLen
  );
}
`;

export const perturbationIterator = {
  id: "perturbation",
  label: "Perturbation (CPU ref + GPU δ)",
  precisionHint: "perturbation",
  supportsDeepZoom: true,
  needsReferenceOrbit: true,
  wgsl: iterateWgsl,
  entryPoint: "main",
  paramsSize: ITERATE_PARAMS_SIZE,
};
