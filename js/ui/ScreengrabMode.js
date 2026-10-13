import { createBaffledScreenshots } from "../vendor/baffled-screenshots.js";
import { Fixed } from "../math/bigFixed.js";
import { aspectOf } from "../view.js";

const PIN_CSS = 56;
const ARROW_COLOR = "rgba(242, 165, 68, 0.95)";
const BOX_COLOR = "rgba(242, 165, 68, 0.85)";

/**
 * Overlay: viewport boxes + arrows + square thumb pins for shared Mandelbrot shots.
 */
export class ScreengrabMode {
  /**
   * @param {HTMLCanvasElement} canvas overlay canvas
   * @param {object} opts
   * @param {() => object} opts.getView
   * @param {() => { width: number, height: number }} opts.getCanvasSize
   * @param {(shot: object) => void} [opts.onSelect]
   * @param {object} [opts.shotsConfig]
   */
  constructor(canvas, { getView, getCanvasSize, onSelect, shotsConfig }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.getView = getView;
    this.getCanvasSize = getCanvasSize;
    this.onSelect = onSelect || (() => {});
    this.enabled = false;
    this.shots = [];
    this._pins = [];
    this._thumbCache = new Map();
    this._config = shotsConfig || {
      apiBase: "https://shots.baffledcat.com",
      appId: "mandelbrot",
      turnstileSiteKey: "",
      devBypassTurnstile: true,
    };
    this._client = createBaffledScreenshots(this._config);

    canvas.addEventListener("pointerdown", (e) => {
      if (!this.enabled) return;
      e.stopPropagation();
      const hit = this._hitTest(e);
      if (hit) this.onSelect(hit);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.enabled) return;
      this.canvas.style.cursor = this._hitTest(e) ? "pointer" : "default";
    });
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.canvas.classList.toggle("hidden", !this.enabled);
    this.canvas.style.pointerEvents = this.enabled ? "auto" : "none";
    if (this.enabled) void this.refresh();
    else this._clear();
  }

  async refresh() {
    if (!this.enabled) return;
    try {
      const data = await this._client.list({ limit: 80 });
      this.shots = data.shots || [];
      for (const s of this.shots) this._ensureThumb(s);
      this.draw();
    } catch (err) {
      console.warn("screengrab list failed", err);
      this.shots = [];
      this.draw();
    }
  }

  _ensureThumb(shot) {
    if (!shot.thumbUrl || this._thumbCache.has(shot.id)) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      this._thumbCache.set(shot.id, img);
      if (this.enabled) this.draw();
    };
    img.onerror = () => this._thumbCache.set(shot.id, null);
    img.src = shot.thumbUrl;
  }

  _clear() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._pins = [];
  }

  draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const ph = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, pw, ph);
    this._pins = [];
    if (!this.enabled) return;

    const { width: fw, height: fh } = this.getCanvasSize();
    if (fw < 1 || fh < 1) return;
    const view = this.getView();
    const sx = pw / fw;
    const sy = ph / fh;

    for (const shot of this.shots) {
      const geom = shotGeometry(shot, view, fw, fh);
      if (!geom) continue;

      const box = {
        x: geom.x0 * sx,
        y: geom.y0 * sy,
        w: (geom.x1 - geom.x0) * sx,
        h: (geom.y1 - geom.y0) * sy,
      };
      const cx = ((geom.x0 + geom.x1) / 2) * sx;
      const cy = ((geom.y0 + geom.y1) / 2) * sy;

      // Viewport outline
      ctx.save();
      ctx.strokeStyle = BOX_COLOR;
      ctx.lineWidth = Math.max(1.5, 2 * dpr);
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.setLineDash([]);

      // Pin position: above box if room, else offset
      const pinR = (PIN_CSS / 2) * dpr;
      let pinX = cx;
      let pinY = box.y - pinR - 10 * dpr;
      if (pinY < pinR + 4) pinY = box.y + box.h + pinR + 10 * dpr;

      // Arrow from pin to box center
      drawArrow(ctx, pinX, pinY, cx, cy, dpr);

      // Thumb pin
      const img = this._thumbCache.get(shot.id);
      ctx.beginPath();
      ctx.arc(pinX, pinY, pinR, 0, Math.PI * 2);
      ctx.fillStyle = "#1c1812";
      ctx.fill();
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = ARROW_COLOR;
      ctx.stroke();
      if (img) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(pinX, pinY, pinR - 2 * dpr, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(
          img,
          pinX - pinR + 2 * dpr,
          pinY - pinR + 2 * dpr,
          (pinR - 2 * dpr) * 2,
          (pinR - 2 * dpr) * 2
        );
        ctx.restore();
      }

      this._pins.push({
        shot,
        x: pinX,
        y: pinY,
        r: pinR + 4 * dpr,
        box,
      });
      ctx.restore();
    }
  }

  _hitTest(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x =
      ((e.clientX - rect.left) / Math.max(rect.width, 1)) * this.canvas.width;
    const y =
      ((e.clientY - rect.top) / Math.max(rect.height, 1)) * this.canvas.height;
    for (let i = this._pins.length - 1; i >= 0; i--) {
      const p = this._pins[i];
      const dx = x - p.x;
      const dy = y - p.y;
      if (dx * dx + dy * dy <= p.r * p.r) return p.shot;
    }
    return null;
  }
}

function drawArrow(ctx, x0, y0, x1, y1, dpr) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  // shorten so tip lands on box edge-ish
  const shrink = Math.min(20 * dpr, len * 0.25);
  const tx = x1 - (dx / len) * shrink;
  const ty = y1 - (dy / len) * shrink;
  ctx.strokeStyle = ARROW_COLOR;
  ctx.fillStyle = ARROW_COLOR;
  ctx.lineWidth = Math.max(1.5, 2 * dpr);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(tx, ty);
  ctx.stroke();

  const ah = 8 * dpr;
  const ang = Math.atan2(ty - y0, tx - x0);
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(
    tx - ah * Math.cos(ang - 0.4),
    ty - ah * Math.sin(ang - 0.4)
  );
  ctx.lineTo(
    tx - ah * Math.cos(ang + 0.4),
    ty - ah * Math.sin(ang + 0.4)
  );
  ctx.closePath();
  ctx.fill();
}

/**
 * Map a shot's stored viewport into current canvas pixel space.
 * @returns {{ x0:number, y0:number, x1:number, y1:number }|null}
 */
function shotGeometry(shot, view, width, height) {
  const meta = shot.meta || {};
  if (meta.cx == null || meta.cy == null || meta.scale == null) return null;

  const shotCx = Fixed.fromString(String(meta.cx), 0);
  const shotCy = Fixed.fromString(String(meta.cy), 0);
  const shotScale = Fixed.fromString(String(meta.scale), 3.5);
  const shotAspect =
    meta.shareWidth && meta.shareHeight
      ? meta.shareWidth / meta.shareHeight
      : meta.canvasWidth && meta.canvasHeight
        ? meta.canvasWidth / meta.canvasHeight
        : aspectOf(width, height);

  // Shot viewport corners in complex plane
  const halfW = shotScale.mul(Fixed.fromNumber(0.5));
  const halfH = shotScale
    .mul(Fixed.fromNumber(0.5))
    .mul(Fixed.fromNumber(1 / shotAspect));
  const left = shotCx.sub(halfW);
  const right = shotCx.add(halfW);
  const top = shotCy.add(halfH);
  const bottom = shotCy.sub(halfH);

  const p0 = complexToScreenFixed(view, left, top, width, height);
  const p1 = complexToScreenFixed(view, right, bottom, width, height);

  const x0 = Math.min(p0.x, p1.x);
  const x1 = Math.max(p0.x, p1.x);
  const y0 = Math.min(p0.y, p1.y);
  const y1 = Math.max(p0.y, p1.y);

  // Skip if entirely off-screen and tiny
  if (x1 < -width || x0 > width * 2 || y1 < -height || y0 > height * 2) {
    return null;
  }
  return { x0, y0, x1, y1 };
}

function complexToScreenFixed(view, cx, cy, width, height) {
  const aspect = aspectOf(width, height);
  const dx = cx.sub(view.centerX).div(view.scale);
  const dy = view.centerY
    .sub(cy)
    .div(view.scale.mul(Fixed.fromNumber(1 / aspect)));
  const u = 0.5 + dx.toNumber();
  const v = 0.5 + dy.toNumber();
  return {
    x: u * width - 0.5,
    y: v * height - 0.5,
  };
}
