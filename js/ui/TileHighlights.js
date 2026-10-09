const FADE_MS = 140;

/**
 * 2D overlay that strokes tile rects as deeper AA levels update the fractal.
 */
export class TileHighlights {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /**
   * @param {{ x: number, y: number, w: number, h: number, t: number }[]} tiles
   * @param {number} canvasWidth fractal backing width
   * @param {number} canvasHeight fractal backing height
   */
  draw(tiles, canvasWidth, canvasHeight) {
    // Match overlay buffer to its CSS box in device pixels
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const ph = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!tiles.length || canvasWidth < 1 || canvasHeight < 1) return;

    const sx = this.canvas.width / canvasWidth;
    const sy = this.canvas.height / canvasHeight;
    const now = performance.now();

    for (const tile of tiles) {
      const age = now - tile.t;
      if (age >= FADE_MS) continue;
      const alpha = this.reducedMotion ? 0.85 : 1 - age / FADE_MS;
      const x = tile.x * sx;
      const y = tile.y * sy;
      const w = Math.max(1, tile.w * sx);
      const h = Math.max(1, tile.h * sy);

      // Cell-wide wash; short fade so deeper AA reads as a quick sweep
      ctx.fillStyle = `rgba(242, 165, 68, ${0.22 * alpha})`;
      ctx.fillRect(x, y, w, h);
    }
  }
}
