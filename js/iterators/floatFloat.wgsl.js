/**
 * Float-float (double-double) arithmetic + Mandelbrot in WGSL.
 * ~100+ bits of significand vs f32's 24 — the practical deep-precision path on
 * WebGPU (WGSL has no f64).
 */

export const floatFloatWgsl = /* wgsl */ `
struct DD {
  hi: f32,
  lo: f32,
}

struct CPoint {
  x: DD,
  y: DD,
}

fn dd_from_f32(x: f32) -> DD {
  return DD(x, 0.0);
}

fn dd_quick_two_sum(a: f32, b: f32) -> DD {
  let s = a + b;
  let e = b - (s - a);
  return DD(s, e);
}

fn dd_two_sum(a: f32, b: f32) -> DD {
  let s = a + b;
  let v = s - a;
  let e = (a - (s - v)) + (b - v);
  return DD(s, e);
}

fn dd_add(a: DD, b: DD) -> DD {
  let s = dd_two_sum(a.hi, b.hi);
  let t = dd_two_sum(a.lo, b.lo);
  let s2 = dd_quick_two_sum(s.hi, s.lo + t.hi);
  return dd_quick_two_sum(s2.hi, s2.lo + t.lo);
}

fn dd_sub(a: DD, b: DD) -> DD {
  return dd_add(a, DD(-b.hi, -b.lo));
}

fn dd_two_prod(a: f32, b: f32) -> DD {
  let p = a * b;
  let e = fma(a, b, -p);
  return DD(p, e);
}

fn dd_mul(a: DD, b: DD) -> DD {
  let p = dd_two_prod(a.hi, b.hi);
  let t = ((a.hi * b.lo) + (a.lo * b.hi)) + p.lo;
  return dd_quick_two_sum(p.hi, t);
}

fn dd_mul_f32(a: DD, b: f32) -> DD {
  let p = dd_two_prod(a.hi, b);
  return dd_quick_two_sum(p.hi, p.lo + a.lo * b);
}

fn mandel_smooth_ff(cx: DD, cy: DD, max_iter: u32) -> vec4f {
  let mode = params.colourMode;
  var zx = dd_from_f32(0.0);
  var zy = dd_from_f32(0.0);
  var dzx = 1.0;
  var dzy = 0.0;
  var i: u32 = 0u;
  var mag2_hi = 0.0;
  var sw = stripe_win_new();
  var sprev = 0.5;
  var sfull = 0.5;
  var trap_min = 1e20;
  loop {
    if (i >= max_iter) {
      return ESCAPE_INTERIOR;
    }
    let zx2 = dd_mul(zx, zx);
    let zy2 = dd_mul(zy, zy);
    let mag2 = dd_add(zx2, zy2);
    mag2_hi = mag2.hi;
    if (mode == SEC_STRIPES && i > 0u) {
      let term = stripe_term(zx.hi, zy.hi, params.stripeFreq);
      sprev = select(term, stripe_win_mean(&sw), sw.len > 0u);
      stripe_win_add(&sw, term, params.stripeWindow);
      sfull = stripe_win_mean(&sw);
    }
    if (is_trap_mode(mode) && i > 0u) {
      trap_min = min(trap_min, trap_dist_for_mode(mode, zx.hi, zy.hi));
    }
    if (mag2_hi > 256.0) {
      break;
    }
    let ndzx = 2.0 * (zx.hi * dzx - zy.hi * dzy) + 1.0;
    let ndzy = 2.0 * (zx.hi * dzy + zy.hi * dzx);
    let twoxy = dd_mul_f32(dd_mul(zx, zy), 2.0);
    let nx = dd_add(dd_sub(zx2, zy2), cx);
    let ny = dd_add(twoxy, cy);
    zx = nx;
    zy = ny;
    dzx = ndzx;
    dzy = ndzy;
    i = i + 1u;
  }
  let s = escape_sample(i, zx.hi, zy.hi, mag2_hi);
  if (mode == SEC_FLAT) {
    return vec4f(s.x, 0.5, s.z, s.w);
  }
  if (mode == SEC_STRIPES) {
    return stripe_finish(s, sfull, sprev);
  }
  if (mode == SEC_DE) {
    let pixel = params.scale / max(f32(params.resolution.y), 1.0);
    let v = map_de(zx.hi, zy.hi, mag2_hi, dzx, dzy, pixel, params.deGain);
    return vec4f(s.x, v, s.z, s.w);
  }
  if (is_trap_mode(mode)) {
    return vec4f(s.x, map_trap(trap_min), s.z, s.w);
  }
  return s;
}

fn complex_from_pixel_ff(
  center_x: DD,
  center_y: DD,
  scale: DD,
  aspect: f32,
  resolution: vec2f,
  px: u32,
  py: u32,
  sx_off: f32,
  sy_off: f32
) -> CPoint {
  let u = (f32(px) + sx_off) / resolution.x;
  let v = (f32(py) + sy_off) / resolution.y;
  let cx = dd_add(center_x, dd_mul_f32(scale, u - 0.5));
  let scale_y = dd_mul_f32(scale, 1.0 / aspect);
  let cy = dd_sub(center_y, dd_mul_f32(scale_y, v - 0.5));
  return CPoint(cx, cy);
}

fn blend_pixel_aa_ff(
  center_x: DD,
  center_y: DD,
  scale: DD,
  aspect: f32,
  resolution: vec2f,
  px: u32,
  py: u32,
  aa: u32,
  max_iter: u32
) -> vec2f {
  let a = max(aa, 1u);
  let inv_aa = 1.0 / f32(a);
  let scalar = is_scalar_secondary(params.colourMode);
  var acc = esc_acc_new();
  for (var sy = 0u; sy < a; sy = sy + 1u) {
    for (var sx = 0u; sx < a; sx = sx + 1u) {
      let c = complex_from_pixel_ff(
        center_x, center_y, scale, aspect, resolution,
        px, py,
        (f32(sx) + 0.5) * inv_aa,
        (f32(sy) + 0.5) * inv_aa
      );
      acc = esc_acc_add(acc, mandel_smooth_ff(c.x, c.y, max_iter), scalar);
    }
  }
  return esc_acc_finish(acc, scalar);
}
`;
