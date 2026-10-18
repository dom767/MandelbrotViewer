import {
  escapeSampleWgsl,
  mandelSmoothWgsl,
  complexFromPixelWgsl,
  blendPixelAaWgsl,
} from "./mandelCommon.wgsl.js";
import { ITERATE_PARAMS_SIZE } from "./params.js";

export { ITERATE_PARAMS_SIZE };

/** GPU FP32 Mandelbrot iterator — writes vec2(smoothIter, packed angle/weight). */

/**
 * Shared bind-group layout expectation:
 * 0: params uniform
 * 1: escape storage buffer (array<vec2f>)
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
  colourMode: u32,
  stripeFreq: f32,
  stripeWindow: u32,
  deGain: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> escape: array<vec2f>;

${escapeSampleWgsl}
${mandelSmoothWgsl}
${complexFromPixelWgsl}
${blendPixelAaWgsl}

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
  // FP32 path uses hi parts only; lo is ignored.
  escape[idx] = blend_pixel_aa(
    params.center,
    params.scale,
    params.aspect,
    res,
    px,
    py,
    params.aa,
    params.maxIter
  );
}
`;

export const fp32Iterator = {
  id: "fp32",
  label: "GPU FP32",
  precisionHint: "f32",
  supportsDeepZoom: false,
  wgsl: iterateWgsl,
  entryPoint: "main",
  paramsSize: ITERATE_PARAMS_SIZE,
};
