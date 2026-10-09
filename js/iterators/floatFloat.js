import { ITERATE_PARAMS_SIZE } from "./params.js";
import { floatFloatWgsl } from "./floatFloat.wgsl.js";

/**
 * GPU float-float Mandelbrot — emulated ~64-bit (double-double) on WebGPU.
 * Same tile/escape contract as FP32 so colouring and the scheduler stay shared.
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
  _pad: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> escape: array<f32>;

${floatFloatWgsl}

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
  let cx = DD(params.center.x, params.centerLo.x);
  let cy = DD(params.center.y, params.centerLo.y);
  let sc = DD(params.scale, params.scaleLo);
  let idx = py * params.resolution.x + px;
  escape[idx] = blend_pixel_aa_ff(
    cx,
    cy,
    sc,
    params.aspect,
    res,
    px,
    py,
    params.aa,
    params.maxIter
  );
}
`;

export const floatFloatIterator = {
  id: "floatFloat",
  label: "GPU float-float (~64-bit)",
  precisionHint: "float-float",
  supportsDeepZoom: true,
  wgsl: iterateWgsl,
  entryPoint: "main",
  paramsSize: ITERATE_PARAMS_SIZE,
};
