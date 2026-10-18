import { ITERATE_PARAMS_SIZE } from "../iterators/params.js";
import { splitDouble, frexpNumber } from "../math/splitDouble.js";
import { computeReferenceOrbit } from "../math/bigFixed.js";
import { createBuffer, writeBuffer, align256 } from "../gpu.js";
import { viewToNumbers } from "../view.js";

/**
 * Builds and dispatches iterator compute pipelines.
 * Pipelines are cached per iterator id.
 */

export class IteratePass {
  constructor(device) {
    this.device = device;
    this.pipelines = new Map();
    this.paramsBuffer = createBuffer(
      device,
      ITERATE_PARAMS_SIZE,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      "iterate-params"
    );

    this.bindGroupLayout = device.createBindGroupLayout({
      label: "iterate-bgl",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
      ],
    });
    this.pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.refBindGroupLayout = device.createBindGroupLayout({
      label: "iterate-ref-bgl",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
      ],
    });
    this.refPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.refBindGroupLayout],
    });

    this.refBuffer = null;
    this.refCapacity = 0;
    this.refLen = 0;
    this.refEscaped = false;
    this.refKey = null;
  }

  /**
   * Build / refresh the CPU reference orbit for perturbation iterators.
   * Cheap no-op when the iterator does not need one or the key is unchanged.
   */
  prepareReference(iterator, view, maxIter) {
    if (!iterator?.needsReferenceOrbit) {
      this.refKey = null;
      return;
    }
    const key = `${view.centerX.raw}|${view.centerY.raw}|${maxIter}`;
    if (this.refKey === key && this.refBuffer) return;

    const { zs, len, escaped } = computeReferenceOrbit(
      view.centerX,
      view.centerY,
      maxIter
    );
    const byteLen = Math.max(zs.byteLength, 8);
    const size = align256(byteLen);
    if (!this.refBuffer || this.refCapacity < size) {
      if (this.refBuffer) this.refBuffer.destroy();
      this.refBuffer = createBuffer(
        this.device,
        size,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        "ref-orbit"
      );
      this.refCapacity = size;
    }
    writeBuffer(this.device, this.refBuffer, zs);
    this.refLen = len;
    this.refEscaped = !!escaped;
    this.refKey = key;
  }

  getPipeline(iterator) {
    let pipe = this.pipelines.get(iterator.id);
    if (pipe) return pipe;
    const layout = iterator.needsReferenceOrbit
      ? this.refPipelineLayout
      : this.pipelineLayout;
    const module = this.device.createShaderModule({
      label: `iterate-${iterator.id}`,
      code: iterator.wgsl,
    });
    // Surface WGSL compile errors instead of silently dispatching a dead pipeline.
    module.getCompilationInfo?.().then((info) => {
      for (const m of info.messages) {
        if (m.type === "error") {
          console.error(`[iterate ${iterator.id}] WGSL:${m.lineNum}:${m.linePos} ${m.message}`);
        }
      }
    });
    pipe = this.device.createComputePipeline({
      label: `iterate-pipe-${iterator.id}`,
      layout,
      compute: { module, entryPoint: iterator.entryPoint ?? "main" },
    });
    this.pipelines.set(iterator.id, pipe);
    return pipe;
  }

  /**
   * Encode a tile dispatch into the given compute pass encoder.
   * @param {GPUComputePassEncoder} pass
   * @param {object} opts
   */
  encodeTile(pass, {
    iterator,
    escapeBuffer,
    view,
    resolution,
    aspect,
    tile,
    maxIter,
    aa,
    colourMode = 0,
    stripeFreq = 5,
    stripeWindow = 32,
    deGain = 2,
  }) {
    const pipeline = this.getPipeline(iterator);
    const useRef = !!iterator.needsReferenceOrbit;

    // GPU uniforms still take f32 hi/lo; deep zoom uses Fixed only for the
    // CPU reference orbit (perturbation). Scaled perturbation packs scale as
    // frexp (mant, exp) so Δ/rebase can pass the f32 ~3e38 ceiling.
    const nums = viewToNumbers(view);
    const cx = splitDouble(nums.centerX);
    const cy = splitDouble(nums.centerY);
    const scaleFrexp = !!iterator.scaleAsFrexp;
    const sc = scaleFrexp
      ? frexpNumber(nums.scale)
      : splitDouble(nums.scale);

    const data = new ArrayBuffer(ITERATE_PARAMS_SIZE);
    const f32 = new Float32Array(data);
    const u32 = new Uint32Array(data);
    f32[0] = cx.hi;
    f32[1] = cy.hi;
    f32[2] = scaleFrexp ? sc.mant : sc.hi;
    f32[3] = aspect;
    u32[4] = resolution.width;
    u32[5] = resolution.height;
    u32[6] = tile.x;
    u32[7] = tile.y;
    u32[8] = tile.w;
    u32[9] = tile.h;
    u32[10] = maxIter;
    u32[11] = aa;
    f32[12] = cx.lo;
    f32[13] = cy.lo;
    f32[14] = scaleFrexp ? sc.exp : sc.lo;
    // Scaled packs refEscaped in the high bit (see perturbationScaled.wgsl).
    let refWord = useRef ? this.refLen : 0;
    if (useRef && scaleFrexp && this.refEscaped) {
      refWord |= 0x80000000;
    }
    u32[15] = refWord;
    u32[16] = colourMode;
    f32[17] = stripeFreq;
    u32[18] = stripeWindow;
    f32[19] = deGain;

    writeBuffer(this.device, this.paramsBuffer, data);

    const bgl = useRef ? this.refBindGroupLayout : this.bindGroupLayout;
    const entries = [
      { binding: 0, resource: { buffer: this.paramsBuffer } },
      { binding: 1, resource: { buffer: escapeBuffer } },
    ];
    if (useRef) {
      entries.push({ binding: 2, resource: { buffer: this.refBuffer } });
    }

    const bindGroup = this.device.createBindGroup({
      layout: bgl,
      entries,
    });

    const wgX = Math.ceil(tile.w / 8);
    const wgY = Math.ceil(tile.h / 8);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(wgX, wgY, 1);
  }
}
