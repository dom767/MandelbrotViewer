const PLOT_CSS = 280;
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
    this.canvas = this.root.querySelector("#orbit-plot");
    this.ctx = this.canvas.getContext("2d");
    this._resizeCanvas();
  }

  _resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._dpr = dpr;
    this.canvas.width = Math.round(PLOT_CSS * dpr);
    this.canvas.height = Math.round(PLOT_CSS * dpr);
    this.canvas.style.width = `${PLOT_CSS}px`;
    this.canvas.style.height = `${PLOT_CSS}px`;
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.root.classList.toggle("hidden", !this.enabled);
    if (this.enabled) this._resizeCanvas();
  }

  /**
   * @param {object} opts
   * @param {string} opts.cxStr
   * @param {string} opts.cyStr
   * @param {Float32Array} opts.zs interleaved Zx,Zy
   * @param {number} opts.len
   */
  render({ cxStr, cyStr, zs, len }) {
    if (!this.enabled) return;
    this.probeEl.textContent = `c ${cxStr} + ${cyStr}i`;
    this._draw(zs, Math.max(0, len | 0));
  }

  _draw(zs, len) {
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

    const c = toPx(0, 0);
    const rEdge = toPx(BAILOUT, 0);
    const rPx = Math.abs(rEdge.px - c.px);
    ctx.beginPath();
    ctx.arc(c.px, c.py, rPx, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(111, 184, 174, 0.35)";
    ctx.lineWidth = 1 * dpr;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (!(len > 0) || !zs || zs.length < 2) return;

    // Clip orbit so escaping points leave the frame
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, plot, plot);
    ctx.clip();

    ctx.beginPath();
    let started = false;
    for (let i = 0; i < len; i++) {
      const x = zs[i * 2];
      const y = zs[i * 2 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const { px, py } = toPx(x, y);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.strokeStyle = "rgba(242, 165, 68, 0.85)";
    ctx.lineWidth = 1.25 * dpr;
    ctx.lineJoin = "round";
    ctx.stroke();

    const rDot = 2.2 * dpr;
    for (let i = 0; i < len; i++) {
      const x = zs[i * 2];
      const y = zs[i * 2 + 1];
      if (!inView(x, y)) continue;
      const { px, py } = toPx(x, y);
      ctx.beginPath();
      ctx.arc(px, py, rDot, 0, Math.PI * 2);
      if (i === 0) {
        ctx.fillStyle = "#6fb8ae";
      } else if (i === len - 1) {
        ctx.fillStyle = "#f6efe2";
      } else {
        ctx.fillStyle = "rgba(242, 165, 68, 0.55)";
      }
      ctx.fill();
    }

    ctx.restore();

    if (inView(zs[0], zs[1])) {
      const z0 = toPx(zs[0], zs[1]);
      ctx.font = `500 ${10 * dpr}px "JetBrains Mono", ui-monospace, monospace`;
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "#6fb8ae";
      ctx.textAlign = "left";
      ctx.fillText("z₀", z0.px + 4 * dpr, z0.py - 2 * dpr);
    }
  }
}
