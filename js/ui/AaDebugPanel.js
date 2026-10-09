import { bakeLut, colourEscape, LUT_SIZE } from "../color/gradient.js";
import { BLEND_LEVELS, GRID } from "../debug/aaGpuProbe.js";

const CELL = 22; // device pixels per subpixel cell (room for iteration text)
const GRID_PX = GRID * CELL;

/**
 * Right-side panel showing GPU-readback 16×16 subpixel field and blend swatches.
 */
export class AaDebugPanel {
  /**
   * @param {HTMLElement} root
   */
  constructor(root) {
    this.root = root;
    this.enabled = false;
    this._lut = null;
    this._lutKey = "";
    this._build();
  }

  _build() {
    this.root.innerHTML = `
      <header class="aa-debug__header">
        <p class="eyebrow">Debug</p>
        <h2 class="aa-debug__title">AA subpixels</h2>
        <p class="aa-debug__note">GPU FP32 readback · cell = smooth iter</p>
      </header>
      <p class="aa-debug__hint">Click the fractal to set the probe</p>
      <p class="aa-debug__probe" id="aa-debug-probe">Probe —</p>
      <div class="aa-debug__grid-wrap">
        <span class="aa-debug__label">16×16 samples</span>
        <canvas id="aa-debug-grid" width="${GRID_PX}" height="${GRID_PX}" aria-label="16 by 16 GPU subpixel samples"></canvas>
        <p class="aa-debug__cpu-avg" id="aa-debug-cpu-avg">CPU avg (escaped) —</p>
      </div>
      <div class="aa-debug__blends">
        <span class="aa-debug__label">Blends (avg escape → colour)</span>
        <div class="aa-debug__swatches" id="aa-debug-swatches"></div>
      </div>
    `;

    this.gridCanvas = this.root.querySelector("#aa-debug-grid");
    this.gridCtx = this.gridCanvas.getContext("2d");
    this.probeEl = this.root.querySelector("#aa-debug-probe");
    this.cpuAvgEl = this.root.querySelector("#aa-debug-cpu-avg");
    this.swatchesEl = this.root.querySelector("#aa-debug-swatches");

    this.swatchCanvases = BLEND_LEVELS.map((aa) => {
      const wrap = document.createElement("div");
      wrap.className = "aa-debug__swatch";
      const label = document.createElement("span");
      label.className = "aa-debug__swatch-aa";
      label.textContent = `${aa}×${aa}`;
      const c = document.createElement("canvas");
      c.width = 48;
      c.height = 48;
      c.setAttribute("aria-label", `${aa} by ${aa} blend`);
      const value = document.createElement("span");
      value.className = "aa-debug__swatch-value";
      value.textContent = "—";
      wrap.append(label, c, value);
      this.swatchesEl.appendChild(wrap);
      return { aa, canvas: c, ctx: c.getContext("2d"), valueEl: value };
    });
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.root.classList.toggle("hidden", !this.enabled);
  }

  _ensureLut(gradId) {
    if (this._lutKey === gradId && this._lut) return this._lut;
    this._lut = bakeLut(gradId, LUT_SIZE);
    this._lutKey = gradId;
    return this._lut;
  }

  /**
   * @param {object} opts
   * @param {Float32Array} opts.samples
   * @param {Float32Array} opts.blends
   * @param {{x:number,y:number}} opts.probe
   * @param {{grad:string, goff:number, gdens:number}} opts.params
   */
  render({ samples, blends, probe, params }) {
    if (!this.enabled) return;
    const lut = this._ensureLut(params.grad);
    const colourOpts = {
      density: params.gdens,
      offset: params.goff,
      maxIter: params.maxIter,
      lut,
    };

    let min = Infinity;
    let max = -Infinity;
    let escaped = 0;
    let sum = 0;
    const uniqueBits = new Set();
    for (let i = 0; i < samples.length; i++) {
      const m = samples[i];
      uniqueBits.add(floatBitsKey(m));
      if (m >= 0) {
        escaped += 1;
        sum += m;
        if (m < min) min = m;
        if (m > max) max = m;
      }
    }
    const range =
      escaped > 0
        ? ` · iters ${fmtIter(min, 4)}–${fmtIter(max, 4)} (${escaped}/256 esc, ${uniqueBits.size} unique)`
        : ` · all interior (${uniqueBits.size} unique)`;
    this.probeEl.textContent = `Probe ${probe.x}, ${probe.y}${range}`;

    // CPU mean of the GPU 16×16 field (escaped-only) — target for the 16×16 blend swatch
    if (escaped > 0) {
      this.cpuAvgEl.textContent = `CPU avg (escaped) ${fmtIter(sum / escaped, 4)} · target for 16×16 blend`;
    } else {
      this.cpuAvgEl.textContent = "CPU avg (escaped) in · target for 16×16 blend";
    }

    const ctx = this.gridCtx;
    ctx.clearRect(0, 0, GRID_PX, GRID_PX);
    ctx.font = "600 7px \"JetBrains Mono\", ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let sy = 0; sy < GRID; sy++) {
      for (let sx = 0; sx < GRID; sx++) {
        const m = samples[sy * GRID + sx];
        const [r, g, b] = colourEscape(m, colourOpts);
        const R = Math.round(r * 255);
        const G = Math.round(g * 255);
        const B = Math.round(b * 255);
        const x0 = sx * CELL;
        const y0 = sy * CELL;
        ctx.fillStyle = `rgb(${R}, ${G}, ${B})`;
        ctx.fillRect(x0, y0, CELL, CELL);

        const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        ctx.fillStyle = luminance > 0.55 ? "#1c1812" : "#f6efe2";
        // Extra digits: subpixel Δnu is often ~0.003, so 2dp collapses neighbours
        ctx.fillText(fmtIter(m, 3), x0 + CELL / 2, y0 + CELL / 2);
      }
    }

    // Hairlines so equal-coloured neighbours stay distinct
    ctx.strokeStyle = "rgba(28, 24, 18, 0.35)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= GRID; i++) {
      const p = i * CELL + 0.5;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, GRID_PX);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(GRID_PX, p);
      ctx.stroke();
    }

    for (let i = 0; i < this.swatchCanvases.length; i++) {
      const { ctx: sctx, canvas, valueEl } = this.swatchCanvases[i];
      const m = blends[i];
      const [r, g, b] = colourEscape(m, colourOpts);
      sctx.fillStyle = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
      sctx.fillRect(0, 0, canvas.width, canvas.height);
      valueEl.textContent = fmtIter(m, 4);
    }
  }
}

function fmtIter(m, frac = 2) {
  if (!(m >= 0)) return "in";
  if (m >= 100) return m.toFixed(Math.min(frac, 1));
  if (m >= 10) return m.toFixed(Math.max(frac - 1, 1));
  return m.toFixed(frac);
}

function floatBitsKey(m) {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = m;
  return new Uint32Array(buf)[0];
}
