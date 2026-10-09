const PLOT_CSS = 280;
const PAD = 28;
const BAILOUT = 2;

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
        <p class="eyebrow">Debug</p>
        <h2 class="orbit-panel__title">Orbit</h2>
        <p class="orbit-panel__note">Fixed-point ref · z<sub>n+1</sub> = z<sub>n</sub>² + c</p>
      </header>
      <p class="orbit-panel__hint">Move the mouse over the fractal</p>
      <p class="orbit-panel__probe" id="orbit-probe">c —</p>
      <p class="orbit-panel__status" id="orbit-status">—</p>
      <div class="orbit-panel__plot-wrap">
        <canvas id="orbit-plot" width="${PLOT_CSS}" height="${PLOT_CSS}" aria-label="Orbit in the complex plane"></canvas>
      </div>
    `;

    this.probeEl = this.root.querySelector("#orbit-probe");
    this.statusEl = this.root.querySelector("#orbit-status");
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
   * @param {boolean} opts.escaped
   * @param {number} opts.maxIter
   */
  render({ cxStr, cyStr, zs, len, escaped, maxIter }) {
    if (!this.enabled) return;

    this.probeEl.textContent = `c ${cxStr} + ${cyStr}i`;
    const n = Math.max(0, len | 0);
    if (escaped) {
      this.statusEl.textContent = `Escaped at n=${n - 1} · max ${maxIter}`;
    } else if (n > 0) {
      this.statusEl.textContent = `Interior · ${n} iters (max ${maxIter})`;
    } else {
      this.statusEl.textContent = "—";
    }

    this._draw(zs, n);
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

    if (!(len > 0) || !zs || zs.length < 2) {
      ctx.fillStyle = "#85795f";
      ctx.font = `${12 * dpr}px "JetBrains Mono", ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No orbit", W / 2, H / 2);
      return;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < len; i++) {
      const x = zs[i * 2];
      const y = zs[i * 2 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX)) {
      minX = -BAILOUT;
      maxX = BAILOUT;
      minY = -BAILOUT;
      maxY = BAILOUT;
    }

    // Always include origin and bailout circle extent for context.
    minX = Math.min(minX, -BAILOUT);
    maxX = Math.max(maxX, BAILOUT);
    minY = Math.min(minY, -BAILOUT);
    maxY = Math.max(maxY, BAILOUT);

    let spanX = maxX - minX;
    let spanY = maxY - minY;
    if (!(spanX > 0)) spanX = 1;
    if (!(spanY > 0)) spanY = 1;
    const span = Math.max(spanX, spanY);
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const half = span * 0.5 * 1.08; // padding
    const x0 = midX - half;
    const x1 = midX + half;
    const y0 = midY - half;
    const y1 = midY + half;

    const pad = PAD * dpr;
    const plot = Math.min(W, H) - pad * 2;
    const ox = (W - plot) / 2;
    const oy = (H - plot) / 2;

    const toPx = (x, y) => {
      const u = (x - x0) / (x1 - x0);
      const v = (y - y0) / (y1 - y0);
      return {
        px: ox + u * plot,
        py: oy + (1 - v) * plot, // +Im up
      };
    };

    // Bailout circle |z| = 2
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

    // Axes
    ctx.strokeStyle = "rgba(246, 239, 226, 0.18)";
    ctx.lineWidth = 1 * dpr;
    if (x0 < 0 && x1 > 0) {
      const a = toPx(0, y0);
      const b = toPx(0, y1);
      ctx.beginPath();
      ctx.moveTo(a.px, a.py);
      ctx.lineTo(b.px, b.py);
      ctx.stroke();
    }
    if (y0 < 0 && y1 > 0) {
      const a = toPx(x0, 0);
      const b = toPx(x1, 0);
      ctx.beginPath();
      ctx.moveTo(a.px, a.py);
      ctx.lineTo(b.px, b.py);
      ctx.stroke();
    }

    // Polyline
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

    // Dots
    const rDot = 2.2 * dpr;
    for (let i = 0; i < len; i++) {
      const x = zs[i * 2];
      const y = zs[i * 2 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
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

    // Labels for z0 / last
    ctx.font = `500 ${10 * dpr}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textBaseline = "bottom";
    const z0 = toPx(zs[0], zs[1]);
    ctx.fillStyle = "#6fb8ae";
    ctx.textAlign = "left";
    ctx.fillText("z₀", z0.px + 4 * dpr, z0.py - 2 * dpr);

    if (len > 1) {
      const zl = toPx(zs[(len - 1) * 2], zs[(len - 1) * 2 + 1]);
      ctx.fillStyle = "#f6efe2";
      ctx.textAlign = "right";
      ctx.fillText(`z${len - 1}`, zl.px - 4 * dpr, zl.py - 2 * dpr);
    }
  }
}
