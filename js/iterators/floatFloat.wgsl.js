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

fn mandel_smooth_ff(cx: DD, cy: DD, max_iter: u32) -> f32 {
  var zx = dd_from_f32(0.0);
  var zy = dd_from_f32(0.0);
  var i: u32 = 0u;
  var mag2_hi = 0.0;
  loop {
    if (i >= max_iter) {
      return -1.0;
    }
    let zx2 = dd_mul(zx, zx);
    let zy2 = dd_mul(zy, zy);
    let mag2 = dd_add(zx2, zy2);
    mag2_hi = mag2.hi;
    if (mag2_hi > 256.0) {
      break;
    }
    let twoxy = dd_mul_f32(dd_mul(zx, zy), 2.0);
    let nx = dd_add(dd_sub(zx2, zy2), cx);
    let ny = dd_add(twoxy, cy);
    zx = nx;
    zy = ny;
    i = i + 1u;
  }
  let log_zn = log2(mag2_hi) * 0.5;
  return f32(i) + 1.0 - log2(log_zn);
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
) -> f32 {
  let a = max(aa, 1u);
  let inv_aa = 1.0 / f32(a);
  var sum = 0.0;
  var escaped = 0u;
  for (var sy = 0u; sy < a; sy = sy + 1u) {
    for (var sx = 0u; sx < a; sx = sx + 1u) {
      let c = complex_from_pixel_ff(
        center_x, center_y, scale, aspect, resolution,
        px, py,
        (f32(sx) + 0.5) * inv_aa,
        (f32(sy) + 0.5) * inv_aa
      );
      let m = mandel_smooth_ff(c.x, c.y, max_iter);
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
`;
