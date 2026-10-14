import { createBaffledScreenshots } from "../vendor/baffled-screenshots.js";
import { Fixed } from "../math/bigFixed.js";
import { aspectOf } from "../view.js";

const PIN_COLOR = "#ea4335";
const PIN_STROKE = "#ffffff";
const BOX_COLOR = "rgba(242, 165, 68, 0.85)";
const ARROW_COLOR = "rgba(242, 165, 68, 0.95)";
/** Newest shared shots to keep in memory / draw from. */
export const MAX_SHOT_PINS = 500;
const LIST_PAGE = 100;

/**
 * Overlay: map-style pins for shared Mandelbrot shots.
 * Thumbnails appear only while hovering a pin.
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
    this.panelOpen = false;
    this.shots = [];
    this._pins = [];
    this._thumbCache = new Map();
    this._hoverId = null;
    this._config = shotsConfig || {
      apiBase: "https://shots.baffledcat.com",
      appId: "mandelbrot",
      turnstileSiteKey: "",
      devBypassTurnstile: true,
    };
    this._client = createBaffledScreenshots(this._config);
    this._refreshGen = 0;
  }

  /** Show overlay and load pins (call once at boot). */
  start() {
    this.canvas.classList.remove("hidden");
    this.canvas.setAttribute("aria-hidden", "false");
    this.canvas.style.pointerEvents = "none";
    void this.refresh();
  }

  /**
   * When the shots side panel is open, draw viewport boxes + arrows too.
   * @param {boolean} on
   */
  setPanelOpen(on) {
    this.panelOpen = !!on;
    if (this.panelOpen) void this.refresh();
    else this.draw();
  }

  async refresh() {
    const gen = ++this._refreshGen;
    try {
      const shots = await this._fetchNewest(MAX_SHOT_PINS);
      if (gen !== this._refreshGen) return;
      this.shots = shots;
      this.draw();
    } catch (err) {
      if (gen !== this._refreshGen) return;
      console.warn("screengrab list failed", err);
      this.shots = [];
      this.draw();
    }
  }

  /**
   * @param {number} max
   * @returns {Promise<object[]>}
   */
  async _fetchNewest(max) {
    const all = [];
    let cursor = null;
    while (all.length < max) {
      const page = Math.min(LIST_PAGE, max - all.length);
      const data = await this._client.list({ limit: page, cursor });
      const batch = data.shots || [];
      all.push(...batch);
      if (!data.nextCursor || batch.length === 0) break;
      cursor = data.nextCursor;
    }
    return all.slice(0, max);
  }

  _ensureThumb(shot) {
    if (!shot.thumbUrl || this._thumbCache.has(shot.id)) return;
    // Placeholder so we don't start duplicate loads.
    this._thumbCache.set(shot.id, undefined);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      this._thumbCache.set(shot.id, img);
      if (this._hoverId === shot.id) this.draw();
    };
    img.onerror = () => this._thumbCache.set(shot.id, null);
    img.src = shot.thumbUrl;
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

    const { width: fw, height: fh } = this.getCanvasSize();
    if (fw < 1 || fh < 1) return;
    const view = this.getView();
    const sx = pw / fw;
    const sy = ph / fh;

    let hoverPin = null;

    for (const shot of this.shots) {
      const geom = shotGeometry(shot, view, fw, fh);
      if (!geom) continue;

      const box = {
        x: geom.x0 * sx,
        y: geom.y0 * sy,
        w: (geom.x1 - geom.x0) * sx,
        h: (geom.y1 - geom.y0) * sy,
      };
      // Tip of the pin sits on the shot viewport center.
      const tipX = ((geom.x0 + geom.x1) / 2) * sx;
      const tipY = ((geom.y0 + geom.y1) / 2) * sy;

      ctx.save();

      if (this.panelOpen) {
        ctx.strokeStyle = BOX_COLOR;
        ctx.lineWidth = Math.max(1.5, 2 * dpr);
        ctx.setLineDash([6 * dpr, 4 * dpr]);
        ctx.strokeRect(box.x, box.y, box.w, box.h);
        ctx.setLineDash([]);
        drawArrow(ctx, tipX, tipY - 28 * dpr, tipX, tipY, dpr);
      }

      const metrics = drawMapPin(ctx, tipX, tipY, dpr, shot.id === this._hoverId);
      this._pins.push({
        shot,
        tipX,
        tipY,
        hitX: metrics.hitX,
        hitY: metrics.hitY,
        hitR: metrics.hitR,
        box,
      });

      if (shot.id === this._hoverId) hoverPin = this._pins[this._pins.length - 1];
      ctx.restore();
    }

    // Hover thumbnail on top of all pins.
    if (hoverPin) {
      this._ensureThumb(hoverPin.shot);
      const img = this._thumbCache.get(hoverPin.shot.id);
      if (img) {
        drawHoverThumb(ctx, hoverPin.tipX, hoverPin.tipY, img, dpr);
      }
    }
  }

  /**
   * Update hover from a pointer event; redraws only when the hovered pin changes.
   * @param {PointerEvent|MouseEvent} e
   * @returns {object|null} hovered shot, if any
   */
  setHoverFromEvent(e) {
    const pin = this._pinAtEvent(e);
    const nextId = pin?.shot?.id ?? null;
    if (nextId !== this._hoverId) {
      this._hoverId = nextId;
      if (pin) this._ensureThumb(pin.shot);
      this.draw();
    }
    return pin?.shot ?? null;
  }

  /**
   * Hit-test in fractal-canvas client coordinates (overlay is pointer-events: none).
   * @param {PointerEvent|MouseEvent} e
   * @returns {object|null}
   */
  hitTestEvent(e) {
    return this._pinAtEvent(e)?.shot ?? null;
  }

  _pinAtEvent(e) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const x = ((e.clientX - rect.left) / rect.width) * this.canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * this.canvas.height;
    for (let i = this._pins.length - 1; i >= 0; i--) {
      const p = this._pins[i];
      const dx = x - p.hitX;
      const dy = y - p.hitY;
      if (dx * dx + dy * dy <= p.hitR * p.hitR) return p;
    }
    return null;
  }
}

/**
 * Classic teardrop map pin; tip at (tipX, tipY).
 * @returns {{ hitX:number, hitY:number, hitR:number }}
 */
function drawMapPin(ctx, tipX, tipY, dpr, hovered) {
  const scale = hovered ? 1.12 : 1;
  const headR = 9 * dpr * scale;
  const tipLen = 14 * dpr * scale;
  const headCy = tipY - tipLen - headR * 0.15;

  ctx.beginPath();
  // Circle head
  ctx.arc(tipX, headCy, headR, Math.PI * 0.78, Math.PI * 2.22, false);
  // Point down to tip
  ctx.lineTo(tipX, tipY);
  ctx.closePath();

  ctx.fillStyle = PIN_COLOR;
  ctx.fill();
  ctx.lineWidth = Math.max(1.25, 1.5 * dpr);
  ctx.strokeStyle = PIN_STROKE;
  ctx.stroke();

  // Inner white/dot (Google-style)
  ctx.beginPath();
  ctx.arc(tipX, headCy - headR * 0.08, headR * 0.38, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();

  return {
    hitX: tipX,
    hitY: headCy,
    hitR: headR + 6 * dpr,
  };
}

function drawHoverThumb(ctx, tipX, tipY, img, dpr) {
  const size = 72 * dpr;
  const gap = 22 * dpr;
  const x = tipX - size / 2;
  let y = tipY - 28 * dpr - size - gap;
  if (y < 8 * dpr) y = tipY + 12 * dpr;

  const r = 8 * dpr;
  ctx.save();
  // Shadow
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 12 * dpr;
  ctx.shadowOffsetY = 3 * dpr;

  roundRectPath(ctx, x - 3 * dpr, y - 3 * dpr, size + 6 * dpr, size + 6 * dpr, r);
  ctx.fillStyle = "#1c1812";
  ctx.fill();
  ctx.shadowColor = "transparent";

  ctx.save();
  roundRectPath(ctx, x, y, size, size, r * 0.7);
  ctx.clip();
  ctx.drawImage(img, x, y, size, size);
  ctx.restore();

  ctx.lineWidth = Math.max(1.5, 2 * dpr);
  ctx.strokeStyle = ARROW_COLOR;
  roundRectPath(ctx, x, y, size, size, r * 0.7);
  ctx.stroke();
  ctx.restore();
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawArrow(ctx, x0, y0, x1, y1, dpr) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const shrink = Math.min(12 * dpr, len * 0.2);
  const tx = x1 - (dx / len) * shrink;
  const ty = y1 - (dy / len) * shrink;
  ctx.strokeStyle = ARROW_COLOR;
  ctx.fillStyle = ARROW_COLOR;
  ctx.lineWidth = Math.max(1.5, 2 * dpr);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(tx, ty);
  ctx.stroke();
}

/**
 * Map a shot's stored viewport into current canvas pixel space.
 * Only returns geometry that intersects the visible canvas.
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

  if (x1 < 0 || x0 > width || y1 < 0 || y0 > height) {
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
