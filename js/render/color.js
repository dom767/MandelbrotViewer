import {
  LUT_WIDTH,
  LUT_HEIGHT,
  bakeLut2d,
  WRAP_MODE,
  WRAP_REPEAT,
  docFromPreset,
} from "../color/gradient.js";
import { createBuffer, writeBuffer } from "../gpu.js";

/** resolution + dens/off UV + wraps + interior + mode */
const COLOUR_PARAMS_SIZE = 48;

const colourWgsl = /* wgsl */ `
struct ColourParams {
  resolution: vec2u,
  densityU: f32,
  offsetU: f32,
  densityV: f32,
  offsetV: f32,
  wrapU: u32,
  wrapV: u32,
  interior: vec3f,
  mode: u32,
}

const LUT_W: f32 = ${LUT_WIDTH}.0;
const LUT_H: f32 = ${LUT_HEIGHT}.0;
const WRAP_CLAMP: u32 = 1u;
const WRAP_MIRROR: u32 = 2u;

@group(0) @binding(0) var<uniform> params: ColourParams;
@group(0) @binding(1) var<storage, read> escape: array<vec2f>;
@group(0) @binding(2) var lut: texture_2d<f32>;
@group(0) @binding(3) var lutSampler: sampler;
@group(0) @binding(4) var outTex: texture_storage_2d<rgba8unorm, write>;

fn map_coord(x: f32, dens: f32, off: f32, wrap: u32) -> f32 {
  let t = x * dens + off;
  if (wrap == WRAP_CLAMP) {
    return clamp(t, 0.0, 1.0);
  }
  if (wrap == WRAP_MIRROR) {
    let a = abs(t);
    let p = floor(a);
    let f = a - p;
    if ((u32(p) & 1u) == 1u) {
      return 1.0 - f;
    }
    return f;
  }
  return t - floor(t);
}

/** Half-texel inset so linear filter does not bleed across wrap edges when clamped. */
fn texel_uv(u: f32, v: f32) -> vec2f {
  let uu = mix(0.5 / LUT_W, 1.0 - 0.5 / LUT_W, clamp(u, 0.0, 1.0));
  let vv = mix(0.5 / LUT_H, 1.0 - 0.5 / LUT_H, clamp(v, 0.0, 1.0));
  return vec2f(uu, vv);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.resolution.x || gid.y >= params.resolution.y) {
    return;
  }
  let idx = gid.y * params.resolution.x + gid.x;
  let e = escape[idx];
  var rgb: vec3f;
  if (e.x < 0.0) {
    rgb = params.interior;
  } else {
    // densityU is pre-scaled on the CPU as (cycles / maxIter).
    // mode = secondary axis code: 0 flat, 1 angle, 2+ scalar (stripes/DE/trap).
    let u = map_coord(e.x, params.densityU, params.offsetU, params.wrapU);
    if (params.mode == 0u) {
      let v = 0.5;
      rgb = textureSampleLevel(lut, lutSampler, texel_uv(u, v), 0.0).rgb;
    } else if (params.mode == 1u) {
      // y packs a 16-bit angle and 7-bit band weight (see mandelCommon.wgsl.js).
      let p = u32(e.y);
      let a = f32(p & 0xffffu) / 65536.0;
      let w = f32(p >> 16u) / 127.0;
      let a0 = map_coord(a, params.densityV, params.offsetV, params.wrapV);
      let a1 = map_coord(2.0 * a, params.densityV, params.offsetV, params.wrapV);
      let c0 = textureSampleLevel(lut, lutSampler, texel_uv(u, a0), 0.0).rgb;
      let c1 = textureSampleLevel(lut, lutSampler, texel_uv(u, a1), 0.0).rgb;
      rgb = mix(c0, c1, w);
    } else {
      let v = map_coord(e.y, params.densityV, params.offsetV, params.wrapV);
      rgb = textureSampleLevel(lut, lutSampler, texel_uv(u, v), 0.0).rgb;
    }
  }
  textureStore(outTex, vec2i(i32(gid.x), i32(gid.y)), vec4f(rgb, 1.0));
}
`;

const blitWgsl = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  var uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  var out: VsOut;
  out.pos = vec4f(positions[vi], 0.0, 1.0);
  out.uv = uvs[vi];
  return out;
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  return textureSampleLevel(src, srcSampler, in.uv, 0.0);
}
`;

function wrapCode(name) {
  return WRAP_MODE[name] ?? WRAP_MODE[WRAP_REPEAT];
}

export class ColourPass {
  constructor(device, canvasFormat) {
    this.device = device;
    this.canvasFormat = canvasFormat;
    this.paramsBuffer = createBuffer(
      device,
      COLOUR_PARAMS_SIZE,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      "colour-params"
    );

    this.lutTexture = device.createTexture({
      label: "gradient-lut-2d",
      size: [LUT_WIDTH, LUT_HEIGHT],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.lutSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });
    this.blitSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.colourBgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba8unorm" },
        },
      ],
    });

    const colourModule = device.createShaderModule({ code: colourWgsl });
    this.colourPipeline = device.createComputePipeline({
      label: "colour-pipe",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.colourBgl] }),
      compute: { module: colourModule, entryPoint: "main" },
    });

    this.blitBgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    const blitModule = device.createShaderModule({ code: blitWgsl });
    this.blitPipeline = device.createRenderPipeline({
      label: "blit-pipe",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.blitBgl] }),
      vertex: { module: blitModule, entryPoint: "vs" },
      fragment: {
        module: blitModule,
        entryPoint: "fs",
        targets: [{ format: canvasFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.currentLutKey = null;
    this.imageTexture = null;
    this.imageWidth = 0;
    this.imageHeight = 0;
  }

  /** Upload raw RGBA8 LUT bytes (image-mode hook). */
  setLut(data, key = null) {
    this.device.queue.writeTexture(
      { texture: this.lutTexture },
      data,
      { bytesPerRow: LUT_WIDTH * 4 },
      [LUT_WIDTH, LUT_HEIGHT]
    );
    this.currentLutKey = key;
  }

  setGradientDoc(doc) {
    const key = JSON.stringify({
      p: doc.presetId,
      c: doc.custom,
      b: doc.blend,
      u: doc.uStops,
      v: doc.vStops,
      s: doc.source,
    });
    if (this.currentLutKey === key) return;
    this.setLut(bakeLut2d(doc), key);
  }

  /** @deprecated prefer setGradientDoc */
  setGradient(presetId) {
    this.setGradientDoc(docFromPreset(presetId));
  }

  ensureImage(width, height) {
    if (this.imageTexture && this.imageWidth === width && this.imageHeight === height) {
      return this.imageTexture;
    }
    if (this.imageTexture) {
      this.imageTexture.destroy();
    }
    this.imageTexture = this.device.createTexture({
      label: "fractal-image",
      size: [width, height],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
    this.imageWidth = width;
    this.imageHeight = height;
    return this.imageTexture;
  }

  /**
   * Colour entire escape buffer into image texture.
   * densityU should already be cycles/maxIter.
   */
  encodeColour(
    encoder,
    {
      escapeBuffer,
      width,
      height,
      densityU,
      offsetU = 0,
      densityV = 1,
      offsetV = 0,
      wrapU = WRAP_REPEAT,
      wrapV = WRAP_REPEAT,
      colourMode = 0,
    }
  ) {
    const image = this.ensureImage(width, height);
    const data = new ArrayBuffer(COLOUR_PARAMS_SIZE);
    const u32 = new Uint32Array(data);
    const f32 = new Float32Array(data);
    u32[0] = width;
    u32[1] = height;
    f32[2] = densityU;
    f32[3] = offsetU;
    f32[4] = densityV;
    f32[5] = offsetV;
    u32[6] = wrapCode(wrapU);
    u32[7] = wrapCode(wrapV);
    f32[8] = 0.11;
    f32[9] = 0.094;
    f32[10] = 0.07;
    u32[11] = colourMode;
    writeBuffer(this.device, this.paramsBuffer, data);

    const bg = this.device.createBindGroup({
      layout: this.colourBgl,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: escapeBuffer } },
        { binding: 2, resource: this.lutTexture.createView() },
        { binding: 3, resource: this.lutSampler },
        { binding: 4, resource: image.createView() },
      ],
    });

    const pass = encoder.beginComputePass({ label: "colour" });
    pass.setPipeline(this.colourPipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8), 1);
    pass.end();
  }

  encodeBlit(encoder, context) {
    if (!this.imageTexture) return;
    const view = context.getCurrentTexture().createView();
    const bg = this.device.createBindGroup({
      layout: this.blitBgl,
      entries: [
        { binding: 0, resource: this.imageTexture.createView() },
        { binding: 1, resource: this.blitSampler },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: 0.11, g: 0.094, b: 0.07, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.blitPipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
  }
}
