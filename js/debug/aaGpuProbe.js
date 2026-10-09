import { createBuffer, writeBuffer } from "../gpu.js";
import { aspectOf } from "../view.js";
import {
  mandelSmoothWgsl,
  complexFromPixelWgsl,
  blendPixelAaWgsl,
} from "../iterators/mandelCommon.wgsl.js";

export const GRID = 16;
export const BLEND_LEVELS = [1, 2, 4, 8, 16];

const PARAMS_SIZE = 48;
const SAMPLES_BYTES = GRID * GRID * 4;
const BLENDS_BYTES = BLEND_LEVELS.length * 4;

const debugWgsl = /* wgsl */ `
struct DebugParams {
  center: vec2f,
  scale: f32,
  aspect: f32,
  resolution: vec2u,
  probe: vec2u,
  maxIter: u32,
  _pad: u32,
}

@group(0) @binding(0) var<uniform> params: DebugParams;
@group(0) @binding(1) var<storage, read_write> samples: array<f32>;
@group(0) @binding(2) var<storage, read_write> blends: array<f32>;

${mandelSmoothWgsl}
${complexFromPixelWgsl}
${blendPixelAaWgsl}

@compute @workgroup_size(16, 16, 1)
fn sample_field(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= ${GRID}u || gid.y >= ${GRID}u) {
    return;
  }
  let res = vec2f(f32(params.resolution.x), f32(params.resolution.y));
  let inv = 1.0 / f32(${GRID}u);
  let c = complex_from_pixel(
    params.center,
    params.scale,
    params.aspect,
    res,
    params.probe.x,
    params.probe.y,
    (f32(gid.x) + 0.5) * inv,
    (f32(gid.y) + 0.5) * inv
  );
  samples[gid.y * ${GRID}u + gid.x] = mandel_smooth(c, params.maxIter);
}

@compute @workgroup_size(1, 1, 1)
fn blend_levels(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x > 0u) {
    return;
  }
  let res = vec2f(f32(params.resolution.x), f32(params.resolution.y));
  let levels = array<u32, 5>(1u, 2u, 4u, 8u, 16u);
  for (var i = 0u; i < 5u; i = i + 1u) {
    blends[i] = blend_pixel_aa(
      params.center,
      params.scale,
      params.aspect,
      res,
      params.probe.x,
      params.probe.y,
      levels[i],
      params.maxIter
    );
  }
}
`;

/**
 * GPU AA probe: runs the real FP32 sample/blend kernels and readbacks results.
 */
export class AaGpuProbe {
  constructor(device) {
    this.device = device;
    this.paramsBuffer = createBuffer(
      device,
      PARAMS_SIZE,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      "aa-debug-params"
    );
    this.samplesBuffer = createBuffer(
      device,
      SAMPLES_BYTES,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      "aa-debug-samples"
    );
    this.blendsBuffer = createBuffer(
      device,
      BLENDS_BYTES,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      "aa-debug-blends"
    );
    this.samplesStaging = createBuffer(
      device,
      SAMPLES_BYTES,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      "aa-debug-samples-staging"
    );
    this.blendsStaging = createBuffer(
      device,
      BLENDS_BYTES,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      "aa-debug-blends-staging"
    );

    const module = device.createShaderModule({
      label: "aa-debug",
      code: debugWgsl,
    });
    const bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    this.bindGroupLayout = bgl;
    this.samplePipeline = device.createComputePipeline({
      label: "aa-debug-sample",
      layout,
      compute: { module, entryPoint: "sample_field" },
    });
    this.blendPipeline = device.createComputePipeline({
      label: "aa-debug-blend",
      layout,
      compute: { module, entryPoint: "blend_levels" },
    });

    this._busy = false;
    this._generation = 0;
  }

  /**
   * @returns {Promise<{ samples: Float32Array, blends: Float32Array, probe: {x:number,y:number}, generation: number } | null>}
   */
  async capture({ view, width, height, probeX, probeY, maxIter }) {
    if (this._busy) return null;
    this._busy = true;
    const generation = ++this._generation;

    try {
      const w = Math.max(1, width | 0);
      const h = Math.max(1, height | 0);
      const px = Math.min(w - 1, Math.max(0, probeX | 0));
      const py = Math.min(h - 1, Math.max(0, probeY | 0));

      const data = new ArrayBuffer(PARAMS_SIZE);
      const f32 = new Float32Array(data);
      const u32 = new Uint32Array(data);
      f32[0] = view.centerX.toNumber?.() ?? view.centerX;
      f32[1] = view.centerY.toNumber?.() ?? view.centerY;
      f32[2] = view.scale.toNumber?.() ?? view.scale;
      f32[3] = aspectOf(w, h);
      u32[4] = w;
      u32[5] = h;
      u32[6] = px;
      u32[7] = py;
      u32[8] = maxIter;
      u32[9] = 0;
      writeBuffer(this.device, this.paramsBuffer, data);

      const bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.paramsBuffer } },
          { binding: 1, resource: { buffer: this.samplesBuffer } },
          { binding: 2, resource: { buffer: this.blendsBuffer } },
        ],
      });

      const enc = this.device.createCommandEncoder({ label: "aa-debug-capture" });
      {
        const pass = enc.beginComputePass({ label: "aa-debug-samples" });
        pass.setPipeline(this.samplePipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(1, 1, 1);
        pass.end();
      }
      {
        const pass = enc.beginComputePass({ label: "aa-debug-blends" });
        pass.setPipeline(this.blendPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(1, 1, 1);
        pass.end();
      }
      enc.copyBufferToBuffer(this.samplesBuffer, 0, this.samplesStaging, 0, SAMPLES_BYTES);
      enc.copyBufferToBuffer(this.blendsBuffer, 0, this.blendsStaging, 0, BLENDS_BYTES);
      this.device.queue.submit([enc.finish()]);

      await this.samplesStaging.mapAsync(GPUMapMode.READ);
      await this.blendsStaging.mapAsync(GPUMapMode.READ);

      if (generation !== this._generation) {
        this.samplesStaging.unmap();
        this.blendsStaging.unmap();
        return null;
      }

      const samples = new Float32Array(this.samplesStaging.getMappedRange().slice(0));
      const blends = new Float32Array(this.blendsStaging.getMappedRange().slice(0));
      this.samplesStaging.unmap();
      this.blendsStaging.unmap();

      return {
        samples,
        blends,
        probe: { x: px, y: py },
        generation,
      };
    } finally {
      this._busy = false;
    }
  }
}
