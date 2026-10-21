/**
 * Shared WGSL helpers for FP32 Mandelbrot smooth iteration + secondary axis.
 * Imported by production iterators so sample / blend math cannot drift.
 *
 * Escape contract (vec2f per pixel):
 *   x = smooth iteration (-1 interior)
 *   y = secondary channel (see colourMode / secondary axis)
 */

/**
 * Secondary axis via params.colourMode:
 *   0 flat    — y unused; colour pass samples LUT at v = 0
 *   1 angle   — packed A + band weight (A/2A blend in colour pass)
 *   2 stripes — Härkönen recent-window stripe average in [0,1]
 *   3 de      — distance estimate mapped to [0,1]
 *   4 trap    — cross orbit trap (+) → [0,1]
 *   5 trapo   — circle orbit trap (o, |z|=0.5) → [0,1]
 */
export const escapeSampleWgsl = /* wgsl */ `
const TAU: f32 = 6.283185307179586;
const SEC_FLAT: u32 = 0u;
const SEC_ANGLE: u32 = 1u;
const SEC_STRIPES: u32 = 2u;
const SEC_DE: u32 = 3u;
const SEC_TRAP: u32 = 4u;
const SEC_TRAP_O: u32 = 5u;
const STRIPE_WIN_MAX: u32 = 64u;

fn stripe_term(zx: f32, zy: f32, freq: f32) -> f32 {
  return 0.5 + 0.5 * sin(freq * atan2(zy, zx));
}

struct StripeWin {
  buf: array<f32, 64>,
  len: u32,
  pos: u32,
  sum: f32,
}

fn stripe_win_new() -> StripeWin {
  var w: StripeWin;
  w.len = 0u;
  w.pos = 0u;
  w.sum = 0.0;
  return w;
}

fn stripe_win_mean(w: ptr<function, StripeWin>) -> f32 {
  if ((*w).len == 0u) {
    return 0.5;
  }
  return (*w).sum / f32((*w).len);
}

fn stripe_win_add(w: ptr<function, StripeWin>, term: f32, capacity: u32) {
  let cap = clamp(capacity, 1u, STRIPE_WIN_MAX);
  if ((*w).len == cap) {
    (*w).sum = (*w).sum - (*w).buf[(*w).pos];
  } else {
    (*w).len = (*w).len + 1u;
  }
  (*w).buf[(*w).pos] = term;
  (*w).sum = (*w).sum + term;
  (*w).pos = ((*w).pos + 1u) % cap;
}

fn stripe_finish(s: vec4f, full: f32, prev: f32) -> vec4f {
  return vec4f(s.x, mix(prev, full, s.z), s.z, s.w);
}

fn wrap01(x: f32) -> f32 {
  return x - floor(x);
}

/** (smooth, angle01, bandWeight, escapeIter). */
fn escape_sample(i: u32, zx: f32, zy: f32, mag2: f32) -> vec4f {
  let ll = log2(0.5 * log2(mag2));
  let nu = f32(i) + 1.0 - ll;
  let w = clamp(3.0 - ll, 0.0, 1.0);
  return vec4f(nu, wrap01(atan2(zy, zx) / TAU), w, f32(i));
}

/** Distance-estimate → [0,1]. Log-ratio of DE in pixels; gain = octaves spanning the range. */
fn map_de(zx: f32, zy: f32, mag2: f32, dzx: f32, dzy: f32, pixel: f32, gain: f32) -> f32 {
  let mag = sqrt(max(mag2, 1e-30));
  let dmag = max(sqrt(dzx * dzx + dzy * dzy), 1e-30);
  let de = 2.0 * mag * log(mag) / dmag;
  let r = de / max(pixel, 1e-30);
  // asinh keeps near-set detail without slamming the far field to 1.
  let t = log(r + sqrt(r * r + 1.0));
  let span = max(gain, 0.25) * 5.0;
  return clamp(t / span, 0.0, 1.0);
}

/** Cross trap (+): distance to nearest coordinate axis. */
fn trap_dist_cross(zx: f32, zy: f32) -> f32 {
  return min(abs(zx), abs(zy));
}

/** Circle trap (o): distance to the circle |z| = 0.5. */
fn trap_dist_circle(zx: f32, zy: f32) -> f32 {
  return abs(sqrt(zx * zx + zy * zy) - 0.5);
}

fn trap_dist_for_mode(mode: u32, zx: f32, zy: f32) -> f32 {
  if (mode == SEC_TRAP_O) {
    return trap_dist_circle(zx, zy);
  }
  return trap_dist_cross(zx, zy);
}

fn is_trap_mode(mode: u32) -> bool {
  return mode == SEC_TRAP || mode == SEC_TRAP_O;
}

/** Close approaches → bright; soft falloff uses the full V range. */
fn map_trap(trap_min: f32) -> f32 {
  return 1.0 / (1.0 + trap_min * 10.0);
}

fn is_scalar_secondary(mode: u32) -> bool {
  return mode != SEC_ANGLE;
}

const ESCAPE_INTERIOR: vec4f = vec4f(-1.0, 0.0, 0.0, 0.0);

struct EscAcc {
  sum_m: f32,
  cs: f32,
  sn: f32,
  sum_w: f32,
  band: f32,
  count: u32,
}

fn esc_acc_new() -> EscAcc {
  return EscAcc(0.0, 0.0, 0.0, 0.0, 0.0, 0u);
}

fn esc_acc_add(acc_in: EscAcc, s: vec4f, scalar: bool) -> EscAcc {
  var acc = acc_in;
  if (s.x < 0.0) {
    return acc;
  }
  if (scalar) {
    acc.sum_m = acc.sum_m + s.x;
    acc.cs = acc.cs + s.y;
    acc.count = acc.count + 1u;
    return acc;
  }
  var a = s.y;
  var w = s.z;
  if (acc.count == 0u) {
    acc.band = s.w;
  } else if (s.w < acc.band) {
    let d = min(acc.band - s.w, 16.0);
    a = wrap01(a * exp2(d));
    w = 0.0;
  } else if (s.w > acc.band) {
    let d = min(s.w - acc.band, 16.0);
    let r = length(vec2f(acc.cs, acc.sn));
    let phi = atan2(acc.sn, acc.cs) * exp2(d);
    acc.cs = r * cos(phi);
    acc.sn = r * sin(phi);
    acc.sum_w = 0.0;
    acc.band = s.w;
  }
  acc.sum_m = acc.sum_m + s.x;
  acc.cs = acc.cs + cos(a * TAU);
  acc.sn = acc.sn + sin(a * TAU);
  acc.sum_w = acc.sum_w + w;
  acc.count = acc.count + 1u;
  return acc;
}

fn pack_angle_weight(a: f32, w: f32) -> f32 {
  let qa = min(u32(wrap01(a) * 65536.0), 65535u);
  let qw = u32(round(clamp(w, 0.0, 1.0) * 127.0));
  return f32(qa + qw * 65536u);
}

fn esc_acc_finish(acc: EscAcc, scalar: bool) -> vec2f {
  if (acc.count == 0u) {
    return vec2f(-1.0, 0.0);
  }
  let n = f32(acc.count);
  if (scalar) {
    return vec2f(acc.sum_m / n, acc.cs / n);
  }
  let a = wrap01(atan2(acc.sn, acc.cs) / TAU);
  return vec2f(acc.sum_m / n, pack_angle_weight(a, acc.sum_w / n));
}
`;

export const mandelSmoothWgsl = /* wgsl */ `
fn mandel_smooth(c: vec2f, max_iter: u32) -> vec4f {
  let mode = params.colourMode;
  var z = vec2f(0.0, 0.0);
  var dz = vec2f(1.0, 0.0);
  var i: u32 = 0u;
  var mag2 = 0.0;
  var sw = stripe_win_new();
  var sprev = 0.5;
  var sfull = 0.5;
  var trap_min = 1e20;
  loop {
    if (i >= max_iter) {
      return ESCAPE_INTERIOR;
    }
    let x2 = z.x * z.x;
    let y2 = z.y * z.y;
    mag2 = x2 + y2;
    if (mode == SEC_STRIPES && i > 0u) {
      let term = stripe_term(z.x, z.y, params.stripeFreq);
      sprev = select(term, stripe_win_mean(&sw), sw.len > 0u);
      stripe_win_add(&sw, term, params.stripeWindow);
      sfull = stripe_win_mean(&sw);
    }
    if (is_trap_mode(mode) && i > 0u) {
      trap_min = min(trap_min, trap_dist_for_mode(mode, z.x, z.y));
    }
    if (mag2 > 256.0) {
      break;
    }
    // z' = 2 z z' + 1
    let dzn = vec2f(
      2.0 * (z.x * dz.x - z.y * dz.y) + 1.0,
      2.0 * (z.x * dz.y + z.y * dz.x)
    );
    z = vec2f(x2 - y2 + c.x, 2.0 * z.x * z.y + c.y);
    dz = dzn;
    i = i + 1u;
  }
  let s = escape_sample(i, z.x, z.y, mag2);
  if (mode == SEC_FLAT) {
    return vec4f(s.x, 0.5, s.z, s.w);
  }
  if (mode == SEC_STRIPES) {
    return stripe_finish(s, sfull, sprev);
  }
  if (mode == SEC_DE) {
    let pixel = params.scale / max(f32(params.resolution.y), 1.0);
    let v = map_de(z.x, z.y, mag2, dz.x, dz.y, pixel, params.deGain);
    return vec4f(s.x, v, s.z, s.w);
  }
  if (is_trap_mode(mode)) {
    return vec4f(s.x, map_trap(trap_min), s.z, s.w);
  }
  return s;
}
`;

/**
 * Map a pixel + subpixel offset into the complex plane.
 * sxOff/syOff are in pixel units in [0,1] (e.g. (sx+0.5)/aa).
 */
export const complexFromPixelWgsl = /* wgsl */ `
fn complex_from_pixel(
  center: vec2f,
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
    center.x + (u - 0.5) * scale,
    center.y - (v - 0.5) * (scale / aspect)
  );
}
`;

/** Production AA: average escaped smooth-iters; angle or scalar secondary. */
export const blendPixelAaWgsl = /* wgsl */ `
fn blend_pixel_aa(
  center: vec2f,
  scale: f32,
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
      let c = complex_from_pixel(
        center, scale, aspect, resolution,
        px, py,
        (f32(sx) + 0.5) * inv_aa,
        (f32(sy) + 0.5) * inv_aa
      );
      acc = esc_acc_add(acc, mandel_smooth(c, max_iter), scalar);
    }
  }
  return esc_acc_finish(acc, scalar);
}
`;
