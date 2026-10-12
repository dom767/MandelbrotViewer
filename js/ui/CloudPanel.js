import { bakeLut, colourEscape, LUT_SIZE } from "../color/gradient.js";
import { configureCanvas, createBuffer, writeBuffer, align256 } from "../gpu.js";
import { screenToComplex } from "../view.js";
import { computeReferenceOrbit } from "../math/bigFixed.js";

const PLOT_CSS = 420;
const DEFAULT_GRID = 64;
const GRID_MIN = 8;
const GRID_MAX = 256;
const FLOATS_PER_VERT = 8; // pos.xyz + pad, color.rgba
const BYTES_PER_VERT = FLOATS_PER_VERT * 4;
const AUTO_YAW_RAD_PER_SEC = 0.18;
const SAMPLE_BUDGET_MS = 8;
const Z_HEIGHT_SCALE = 0.55; // |z|=2 → ~1.1 world units

const SHADER = /* wgsl */ `
struct Uniforms {
  mvp: mat4x4f,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSIn {
  @location(0) position: vec3f,
  @location(1) color: vec4f,
};

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) color: vec4f,
};

@vertex
fn vs_main(input: VSIn) -> VSOut {
  var out: VSOut;
  out.clip = u.mvp * vec4f(input.position, 1.0);
  out.color = input.color;
  return out;
}

@fragment
fn fs_main(input: VSOut) -> @location(0) vec4f {
  return input.color;
}
`;

/**
 * Right-side panel: W×H screen-grid orbits as an additive WebGPU point cloud.
 * X/Y = sample screen position; Z (height) = |z_n|.
 */
export class CloudPanel {
  /**
   * @param {HTMLElement} root
   * @param {{ device: GPUDevice, format: GPUTextureFormat }} gpu
   */
  constructor(root, gpu) {
    this.root = root;
    this.device = gpu.device;
    this.format = gpu.format;
    this.enabled = false;
    this.gridSize = DEFAULT_GRID;
    this._dpr = 1;
    this._lut = null;
    this._lutKey = "";
    this._yaw = 0.65;
    this._pitch = 0.45;
    this._dragging = false;
    this._lastPtr = null;
    this._raf = 0;
    this._lastFrame = 0;
    this._pointCount = 0;
    this._capacity = 0;
    this._cpuVerts = null;
    this._vertexBuffer = null;
    this._uniformBuffer = null;
    this._pipeline = null;
    this._bindGroup = null;
    this._context = null;
    this._depthTex = null;
    this._depthView = null;
    this._sampleGen = 0;
    this._sampleJob = null;
    this._onGridChange = null;
    this._build();
    this._initGpu();
    this._bindPointer();
  }

  _build() {
    this.root.innerHTML = `
      <header class="cloud-panel__header">
        <h2 class="cloud-panel__title">Cloud</h2>
        <label class="cloud-panel__length">
          <span>Length</span>
          <input id="cloud-grid" class="cloud-panel__length-input" type="number" min="${GRID_MIN}" max="${GRID_MAX}" step="1" value="${DEFAULT_GRID}" aria-label="Sample grid length" />
        </label>
      </header>
      <div class="cloud-panel__plot-wrap">
        <canvas id="cloud-plot" width="${PLOT_CSS}" height="${PLOT_CSS}" aria-label="Iteration magnitude point cloud"></canvas>
      </div>
    `;

    this.gridInput = this.root.querySelector("#cloud-grid");
    this.canvas = this.root.querySelector("#cloud-plot");

    const onGridInput = () => {
      const n = clampGrid(Number(this.gridInput.value));
      this.gridInput.value = String(n);
      if (n === this.gridSize) return;
      this.gridSize = n;
      if (this._onGridChange) this._onGridChange();
    };
    this.gridInput.addEventListener("change", onGridInput);

    this.root.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.root.addEventListener("wheel", (e) => e.stopPropagation(), {
      passive: false,
    });
  }

  /**
   * @param {() => void} cb
   */
  onGridChange(cb) {
    this._onGridChange = cb;
  }

  _initGpu() {
    this._context = configureCanvas(
      this.device,
      this.canvas,
      this.format,
      "premultiplied"
    );
    if (!this._context) return;

    const module = this.device.createShaderModule({
      label: "cloud-points",
      code: SHADER,
    });
    this._pipeline = this.device.createRenderPipeline({
      label: "cloud-points",
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: BYTES_PER_VERT,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 16, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [
          {
            format: this.format,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: { topology: "point-list" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: false,
        depthCompare: "less",
      },
    });

    this._uniformBuffer = createBuffer(
      this.device,
      align256(64),
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      "cloud-uniforms"
    );
    this._bindGroup = this.device.createBindGroup({
      layout: this._pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this._uniformBuffer } }],
    });

    this._resizeCanvas();
  }

  _bindPointer() {
    const canvas = this.canvas;
    canvas.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this._dragging = true;
      this._lastPtr = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      e.stopPropagation();
      if (!this._dragging || !this._lastPtr) return;
      const dx = e.clientX - this._lastPtr.x;
      const dy = e.clientY - this._lastPtr.y;
      this._lastPtr = { x: e.clientX, y: e.clientY };
      this._yaw += dx * 0.008;
      this._pitch = clamp(this._pitch + dy * 0.008, -1.2, 1.2);
    });
    const endDrag = (e) => {
      e.stopPropagation();
      this._dragging = false;
      this._lastPtr = null;
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
  }

  _resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._dpr = dpr;
    const w = Math.round(PLOT_CSS * dpr);
    const h = Math.round(PLOT_CSS * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.style.width = `${PLOT_CSS}px`;
      this.canvas.style.height = `${PLOT_CSS}px`;
      this._ensureDepth(w, h);
      if (this._context) {
        this._context.configure({
          device: this.device,
          format: this.format,
          alphaMode: "premultiplied",
        });
      }
    }
  }

  _ensureDepth(w, h) {
    if (this._depthTex) {
      if (this._depthTex.width === w && this._depthTex.height === h) return;
      this._depthTex.destroy();
    }
    this._depthTex = this.device.createTexture({
      size: { width: w, height: h },
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this._depthView = this._depthTex.createView();
  }

  _ensureLut(gradId) {
    if (this._lutKey === gradId && this._lut) return this._lut;
    this._lut = bakeLut(gradId, LUT_SIZE);
    this._lutKey = gradId;
    return this._lut;
  }

  _ensureCapacity(maxPoints) {
    const n = Math.max(1, maxPoints | 0);
    if (this._capacity >= n && this._vertexBuffer && this._cpuVerts) return;
    if (this._vertexBuffer) this._vertexBuffer.destroy();
    this._capacity = n;
    this._cpuVerts = new Float32Array(n * FLOATS_PER_VERT);
    this._vertexBuffer = createBuffer(
      this.device,
      n * BYTES_PER_VERT,
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      "cloud-verts"
    );
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.root.classList.toggle("hidden", !this.enabled);
    if (this.enabled) {
      this._resizeCanvas();
      this._startLoop();
    } else {
      this._stopLoop();
      this._cancelSample();
    }
  }

  /**
   * Progressive sample of the current view into the point cloud.
   * @param {object} opts
   * @param {object} opts.view
   * @param {number} opts.canvasW
   * @param {number} opts.canvasH
   * @param {{grad:string, goff:number, gdens:number, maxIter:number}} opts.params
   */
  beginRebuild({ view, canvasW, canvasH, params }) {
    if (!this.enabled || !this._pipeline) return;
    this._cancelSample();
    const gen = ++this._sampleGen;
    const grid = this.gridSize;
    const maxIter = Math.max(1, params.maxIter | 0);
    const maxPoints = grid * grid * maxIter;
    this._ensureCapacity(maxPoints);
    this._pointCount = 0;

    const lut = this._ensureLut(params.grad);
    const colourOpts = {
      density: params.gdens,
      offset: params.goff,
      maxIter,
      lut,
    };

    let cell = 0;
    const totalCells = grid * grid;
    const verts = this._cpuVerts;
    let uploadFrom = 0;

    const step = () => {
      if (gen !== this._sampleGen || !this.enabled) return;
      const t0 = performance.now();
      while (cell < totalCells && performance.now() - t0 < SAMPLE_BUDGET_MS) {
        const i = cell % grid;
        const j = (cell / grid) | 0;
        cell++;
        const px = ((i + 0.5) / grid) * canvasW;
        const py = ((j + 0.5) / grid) * canvasH;
        const c = screenToComplex(view, px, py, canvasW, canvasH);
        const { zs, len } = computeReferenceOrbit(c.x, c.y, maxIter);
        const sx = (i + 0.5) / grid - 0.5;
        const sz = (j + 0.5) / grid - 0.5;
        const n = Math.max(0, len | 0);
        for (let k = 0; k < n; k++) {
          const zx = zs[k * 2];
          const zy = zs[k * 2 + 1];
          if (!Number.isFinite(zx) || !Number.isFinite(zy)) continue;
          const mag = Math.hypot(zx, zy);
          if (!Number.isFinite(mag)) continue;
          const rgb = colourEscape(k, colourOpts);
          if (this._pointCount >= this._capacity) break;
          const o = this._pointCount * FLOATS_PER_VERT;
          verts[o] = sx;
          verts[o + 1] = mag * Z_HEIGHT_SCALE;
          verts[o + 2] = sz;
          verts[o + 3] = 0;
          verts[o + 4] = rgb[0];
          verts[o + 5] = rgb[1];
          verts[o + 6] = rgb[2];
          verts[o + 7] = 0.35;
          this._pointCount++;
        }
      }

      if (this._pointCount > uploadFrom) {
        const byteOffset = uploadFrom * BYTES_PER_VERT;
        const slice = verts.subarray(
          uploadFrom * FLOATS_PER_VERT,
          this._pointCount * FLOATS_PER_VERT
        );
        this.device.queue.writeBuffer(
          this._vertexBuffer,
          byteOffset,
          slice
        );
        uploadFrom = this._pointCount;
      }

      if (cell < totalCells) {
        this._sampleJob = requestAnimationFrame(step);
      } else {
        this._sampleJob = null;
      }
    };

    this._sampleJob = requestAnimationFrame(step);
  }

  _cancelSample() {
    this._sampleGen++;
    if (this._sampleJob != null) {
      cancelAnimationFrame(this._sampleJob);
      this._sampleJob = null;
    }
  }

  _startLoop() {
    if (this._raf) return;
    this._lastFrame = performance.now();
    const tick = (now) => {
      this._raf = 0;
      if (!this.enabled) return;
      const dt = Math.min(0.05, (now - this._lastFrame) / 1000);
      this._lastFrame = now;
      if (!this._dragging) this._yaw += AUTO_YAW_RAD_PER_SEC * dt;
      this._draw();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  _stopLoop() {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
  }

  _draw() {
    if (!this._context || !this._pipeline || !this._depthView) return;
    this._resizeCanvas();
    const w = this.canvas.width;
    const h = this.canvas.height;
    this._ensureDepth(w, h);

    const mvp = makeOrbitMvp(this._yaw, this._pitch, w / Math.max(h, 1));
    writeBuffer(this.device, this._uniformBuffer, mvp);

    const encoder = this.device.createCommandEncoder({ label: "cloud" });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this._context.getCurrentTexture().createView(),
          clearValue: { r: 0.11, g: 0.094, b: 0.07, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: this._depthView,
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    pass.setPipeline(this._pipeline);
    pass.setBindGroup(0, this._bindGroup);
    if (this._pointCount > 0 && this._vertexBuffer) {
      pass.setVertexBuffer(0, this._vertexBuffer);
      pass.draw(this._pointCount);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}

function clampGrid(n) {
  if (!Number.isFinite(n)) return DEFAULT_GRID;
  return Math.min(GRID_MAX, Math.max(GRID_MIN, Math.round(n)));
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Column-major mat4 orbit camera around cloud center. */
function makeOrbitMvp(yaw, pitch, aspect) {
  const target = [0, 0.35, 0];
  const radius = 1.25;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const eye = [
    target[0] + radius * cp * sy,
    target[1] + radius * sp,
    target[2] + radius * cp * cy,
  ];
  const view = lookAt(eye, target, [0, 1, 0]);
  const proj = perspective(50 * (Math.PI / 180), aspect, 0.05, 20);
  return mul4(proj, view);
}

function lookAt(eye, center, up) {
  const zx = eye[0] - center[0];
  const zy = eye[1] - center[1];
  const zz = eye[2] - center[2];
  let zl = Math.hypot(zx, zy, zz) || 1;
  const z0 = zx / zl;
  const z1 = zy / zl;
  const z2 = zz / zl;
  let x0 = up[1] * z2 - up[2] * z1;
  let x1 = up[2] * z0 - up[0] * z2;
  let x2 = up[0] * z1 - up[1] * z0;
  let xl = Math.hypot(x0, x1, x2) || 1;
  x0 /= xl;
  x1 /= xl;
  x2 /= xl;
  const y0 = z1 * x2 - z2 * x1;
  const y1 = z2 * x0 - z0 * x2;
  const y2 = z0 * x1 - z1 * x0;
  return new Float32Array([
    x0,
    y0,
    z0,
    0,
    x1,
    y1,
    z1,
    0,
    x2,
    y2,
    z2,
    0,
    -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]),
    -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]),
    -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]),
    1,
  ]);
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) * nf,
    -1,
    0,
    0,
    2 * far * near * nf,
    0,
  ]);
}

function mul4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return o;
}
