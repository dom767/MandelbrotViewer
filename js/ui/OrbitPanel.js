import { bakeLut, colourEscape, LUT_SIZE } from "../color/gradient.js";

/** Fallback CSS size before the plot wrap has a measured width (matches Cloud). */
const PLOT_CSS = 420;
const PAD = 16;
const BAILOUT = 2;
/** Fixed complex-plane half-span so |z|=2 sits inside the frame with padding. */
const VIEW = 2.4;

/**
 * Right-side panel plotting the Mandelbrot orbit z_n for a probe point.
 */
export class OrbitPanel {
  /**
   * @param {HTMLElement} root
   */
  constructor(root) {
    this.root = root;
    this.enabled = false;
    this._dpr = 1;
    this._lut = null;
    this._lutKey = "";
    this._lastDraw = null;
    this._build();
  }

  _build() {
    this.root.innerHTML = `
      <header class="orbit-panel__header">
        <h2 class="orbit-panel__title">Orbit</h2>
      </header>
      <p class="orbit-panel__probe" id="orbit-probe">c —</p>
      <div class="orbit-panel__plot-wrap">
        <canvas id="orbit-plot" width="${PLOT_CSS}" height="${PLOT_CSS}" aria-label="Orbit in the complex plane"></canvas>
      </div>
    `;

    this.probeEl = this.root.querySelector("#orbit-probe");
    this.plotWrap = this.root.querySelector(".orbit-panel__plot-wrap");
    this.canvas = this.root.querySelector("#orbit-plot");
    this.ctx = this.canvas.getContext("2d");
    this._resizeCanvas();

    if (typeof ResizeObserver !== "undefined" && this.plotWrap) {
      this._ro = new ResizeObserver(() => {
        if (this.enabled) this._resizeCanvas();
      });
      this._ro.observe(this.plotWrap);
    }
  }

  _plotCssSize() {
    const avail = this.plotWrap?.clientWidth || 0;
    if (avail > 0) return Math.max(1, Math.floor(avail));
    return PLOT_CSS;
  }

  _resizeCanvas() {
    const css = this._plotCssSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._dpr = dpr;
    const w = Math.round(css * dpr);
    const h = Math.round(css * dpr);
    this.canvas.style.width = `${css}px`;
    this.canvas.style.height = `${css}px`;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      if (this.enabled && this._lastDraw) {
        this._draw(
          this._lastDraw.zs,
          this._lastDraw.len,
          this._lastDraw.params
        );
      }
    }
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.root.classList.toggle("hidden", !this.enabled);
    if (this.enabled) this._resizeCanvas();
  }

  _ensureLut(gradId) {
    if (this._lutKey === gradId && this._lut) return this._lut;
    this._lut = bakeLut(gradId, LUT_SIZE);
    this._lutKey = gradId;
    return this._lut;
  }

  /**
   * @param {object} opts
   * @param {string} opts.cxStr
   * @param {string} opts.cyStr
   * @param {Float32Array} opts.zs interleaved Zx,Zy
   * @param {number} opts.len
   * @param {{grad:string, goff:number, gdens:number, maxIter:number}} opts.params
   */
  render({ cxStr, cyStr, zs, len, params }) {
    if (!this.enabled) return;
    this.probeEl.textContent = `c ${cxStr} + ${cyStr}i`;
    const n = Math.max(0, len | 0);
    this._lastDraw = { zs, len: n, params };
    this._draw(zs, n, params);
  }

  _rgbCss(rgb, alpha = 1) {
    const r = Math.round(rgb[0] * 255);
    const g = Math.round(rgb[1] * 255);
    const b = Math.round(rgb[2] * 255);
    if (alpha >= 1) return `rgb(${r}, ${g}, ${b})`;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  _draw(zs, len, params) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const dpr = this._dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = "#1c1812";
    ctx.fillRect(0, 0, W, H);

    const pad = PAD * dpr;
    const plot = Math.min(W, H) - pad * 2;
    const ox = (W - plot) / 2;
    const oy = (H - plot) / 2;
    const x0 = -VIEW;
    const x1 = VIEW;
    const y0 = -VIEW;
    const y1 = VIEW;

    const toPx = (x, y) => {
      const u = (x - x0) / (x1 - x0);
      const v = (y - y0) / (y1 - y0);
      return {
        px: ox + u * plot,
        py: oy + (1 - v) * plot, // +Im up
      };
    };

    const inView = (x, y) =>
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      x >= x0 &&
      x <= x1 &&
      y >= y0 &&
      y <= y1;

    // Axes + bailout circle (always the same frame)
    ctx.strokeStyle = "rgba(246, 239, 226, 0.18)";
    ctx.lineWidth = 1 * dpr;
    {
      const a = toPx(0, y0);
      const b = toPx(0, y1);
      ctx.beginPath();
      ctx.moveTo(a.px, a.py);
      ctx.lineTo(b.px, b.py);
      ctx.stroke();
    }
    {
      const a = toPx(x0, 0);
      const b = toPx(x1, 0);
      ctx.beginPath();
      ctx.moveTo(a.px, a.py);
      ctx.lineTo(b.px, b.py);
      ctx.stroke();
    }

    const origin = toPx(0, 0);
    const rEdge = toPx(BAILOUT, 0);
    const rPx = Math.abs(rEdge.px - origin.px);
    ctx.beginPath();
    ctx.arc(origin.px, origin.py, rPx, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(111, 184, 174, 0.35)";
    ctx.lineWidth = 1 * dpr;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (!(len > 0) || !zs || zs.length < 2 || !params) return;

    const lut = this._ensureLut(params.grad);
    const colourOpts = {
      density: params.gdens,
      offset: params.goff,
      maxIter: params.maxIter,
      lut,
    };
    const colorAt = (i) => colourEscape(i, colourOpts);

    // Clip orbit so escaping points leave the frame
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, plot, plot);
    ctx.clip();

    ctx.lineWidth = 1.5 * dpr;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (let i = 0; i < len - 1; i++) {
      const x0p = zs[i * 2];
      const y0p = zs[i * 2 + 1];
      const x1p = zs[(i + 1) * 2];
      const y1p = zs[(i + 1) * 2 + 1];
      if (
        !Number.isFinite(x0p) ||
        !Number.isFinite(y0p) ||
        !Number.isFinite(x1p) ||
        !Number.isFinite(y1p)
      ) {
        continue;
      }
      const a = toPx(x0p, y0p);
      const b = toPx(x1p, y1p);
      ctx.beginPath();
      ctx.moveTo(a.px, a.py);
      ctx.lineTo(b.px, b.py);
      ctx.strokeStyle = this._rgbCss(colorAt(i), 0.9);
      ctx.stroke();
    }

    const rDot = 2.4 * dpr;
    for (let i = 0; i < len; i++) {
      const x = zs[i * 2];
      const y = zs[i * 2 + 1];
      if (!inView(x, y)) continue;
      const { px, py } = toPx(x, y);
      ctx.beginPath();
      ctx.arc(px, py, rDot, 0, Math.PI * 2);
      ctx.fillStyle = this._rgbCss(colorAt(i));
      ctx.fill();
    }

    ctx.restore();

    if (inView(zs[0], zs[1])) {
      const z0 = toPx(zs[0], zs[1]);
      ctx.font = `500 ${10 * dpr}px "JetBrains Mono", ui-monospace, monospace`;
      ctx.textBaseline = "bottom";
      ctx.fillStyle = this._rgbCss(colorAt(0));
      ctx.textAlign = "left";
      ctx.fillText("z₀", z0.px + 4 * dpr, z0.py - 2 * dpr);
    }
  }
}
