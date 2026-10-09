import { LUT_SIZE, bakeLut } from "../color/gradient.js";
import { createBuffer, writeBuffer } from "../gpu.js";

const COLOUR_PARAMS_SIZE = 32;

const colourWgsl = /* wgsl */ `
struct ColourParams {
  resolution: vec2u,
  density: f32,
  offset: f32,
  interior: vec3f,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> params: ColourParams;
@group(0) @binding(1) var<storage, read> escape: array<f32>;
@group(0) @binding(2) var lut: texture_2d<f32>;
@group(0) @binding(3) var lutSampler: sampler;
@group(0) @binding(4) var outTex: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.resolution.x || gid.y >= params.resolution.y) {
    return;
  }
  let idx = gid.y * params.resolution.x + gid.x;
  let m = escape[idx];
  var rgb: vec3f;
  if (m < 0.0) {
    rgb = params.interior;
  } else {
    // density is pre-scaled on the CPU as (cycles / maxIter).
    let t = fract(m * params.density + params.offset);
    rgb = textureSampleLevel(lut, lutSampler, vec2f(t, 0.5), 0.0).rgb;
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
  // Fullscreen triangle
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
      label: "gradient-lut",
      size: [LUT_SIZE, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.lutSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "clamp-to-edge",
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

    this.currentGrad = null;
    this.imageTexture = null;
    this.imageWidth = 0;
    this.imageHeight = 0;
  }

  setGradient(presetId) {
    if (this.currentGrad === presetId) return;
    const data = bakeLut(presetId);
    this.device.queue.writeTexture(
      { texture: this.lutTexture },
      data,
      { bytesPerRow: LUT_SIZE * 4 },
      [LUT_SIZE, 1]
    );
    this.currentGrad = presetId;
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

  /** Colour entire escape buffer into image texture. */
  encodeColour(encoder, { escapeBuffer, width, height, density, offset }) {
    const image = this.ensureImage(width, height);
    const data = new ArrayBuffer(COLOUR_PARAMS_SIZE);
    const u32 = new Uint32Array(data);
    const f32 = new Float32Array(data);
    u32[0] = width;
    u32[1] = height;
    f32[2] = density;
    f32[3] = offset;
    // Interior: warm near-black matching --bg
    f32[4] = 0.11;
    f32[5] = 0.094;
    f32[6] = 0.07;
    f32[7] = 0;
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
