/** Canvas → JPEG helpers for local save + ≤1080p share. */

export const LOCAL_JPEG_QUALITY = 0.85;
export const SHARE_JPEG_QUALITY = 0.7;
export const THUMB_SIZE = 256;
export const SHARE_MAX_W = 1920;
export const SHARE_MAX_H = 1080;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {string} type
 * @param {number} quality
 * @returns {Promise<Blob>}
 */
export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))),
      type,
      quality
    );
  });
}

/**
 * Snapshot a 2D (or readable) canvas into a fresh 2D canvas for encode/download.
 * Do not use this on a WebGPU swapchain canvas — it often yields black.
 * Prefer GPU texture readback (see RenderScheduler.snapshotTo2d).
 * @param {HTMLCanvasElement} source
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function snapshotTo2d(source) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, source.width);
  c.height = Math.max(1, source.height);
  const ctx = c.getContext("2d");
  try {
    const bmp = await createImageBitmap(source);
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
  } catch {
    ctx.drawImage(source, 0, 0);
  }
  return c;
}

/** Scale down to fit 1920×1080; never upscale. */
export function fit1080Canvas(source) {
  const scale = Math.min(
    1,
    SHARE_MAX_W / source.width,
    SHARE_MAX_H / source.height
  );
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(source, 0, 0, w, h);
  return c;
}

/** Center cover-crop → square JPEG blob. */
export async function squareThumbBlob(
  sourceCanvas,
  size = THUMB_SIZE,
  quality = SHARE_JPEG_QUALITY
) {
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  const side = Math.min(sw, sh);
  const sx = (sw - side) / 2;
  const sy = (sh - side) / 2;
  const out = document.createElement("canvas");
  out.width = out.height = size;
  out
    .getContext("2d")
    .drawImage(sourceCanvas, sx, sy, side, side, 0, 0, size, size);
  return canvasToBlob(out, "image/jpeg", quality);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function shotFilename(prefix = "mandelbrot") {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;
}
