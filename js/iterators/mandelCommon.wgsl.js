/**
 * Shared WGSL helpers for FP32 Mandelbrot smooth iteration.
 * Imported by the production iterator and the AA debug probe so sample math cannot drift.
 */

export const mandelSmoothWgsl = /* wgsl */ `
fn mandel_smooth(c: vec2f, max_iter: u32) -> f32 {
  var z = vec2f(0.0, 0.0);
  var i: u32 = 0u;
  var mag2 = 0.0;
  loop {
    if (i >= max_iter) {
      return -1.0;
    }
    let x2 = z.x * z.x;
    let y2 = z.y * z.y;
    mag2 = x2 + y2;
    if (mag2 > 256.0) {
      break;
    }
    z = vec2f(x2 - y2 + c.x, 2.0 * z.x * z.y + c.y);
    i = i + 1u;
  }
  // Continuous potential: n + 1 - log2(log2(|z|))
  let log_zn = log2(mag2) * 0.5; // log2(|z|)
  let nu = f32(i) + 1.0 - log2(log_zn);
  return nu;
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

/** Production AA: average escaped smooth-iters only. */
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
) -> f32 {
  let a = max(aa, 1u);
  let inv_aa = 1.0 / f32(a);
  var sum = 0.0;
  var escaped = 0u;
  for (var sy = 0u; sy < a; sy = sy + 1u) {
    for (var sx = 0u; sx < a; sx = sx + 1u) {
      let c = complex_from_pixel(
        center, scale, aspect, resolution,
        px, py,
        (f32(sx) + 0.5) * inv_aa,
        (f32(sy) + 0.5) * inv_aa
      );
      let m = mandel_smooth(c, max_iter);
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
