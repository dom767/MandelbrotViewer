/** Canvas → JPEG helpers for local save + ≤1080p share. */

export const LOCAL_JPEG_QUALITY = 0.85;
export const SHARE_JPEG_QUALITY = 0.7;
export const THUMB_SIZE = 256;
export const SHARE_MAX_W = 1920;
export const SHARE_MAX_H = 1080;
export const MAX_JPEG_BYTES = 2 * 1024 * 1024;

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

/** Alias for ScreenGrabber TAKE_SCREENSHOT_GUI pipeline. */
export function canvasToJpegBlob(canvas, quality = LOCAL_JPEG_QUALITY) {
  return canvasToBlob(canvas, "image/jpeg", quality);
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

/**
 * Render source with brightness/contrast applied, fitted within maxW × maxH.
 * @param {HTMLCanvasElement|HTMLImageElement|ImageBitmap} source
 * @param {object} [opts]
 * @param {number} [opts.brightness=100] percentage (50..150)
 * @param {number} [opts.contrast=100] percentage (50..150)
 * @param {number} [opts.maxWidth=1920]
 * @param {number} [opts.maxHeight=1080]
 * @returns {HTMLCanvasElement}
 */
export function renderAdjustedCanvas(
  source,
  {
    brightness = 100,
    contrast = 100,
    maxWidth = SHARE_MAX_W,
    maxHeight = SHARE_MAX_H,
  } = {}
) {
  const srcW = source.width || source.videoWidth;
  const srcH = source.height || source.videoHeight;
  const scale = Math.min(1, maxWidth / srcW, maxHeight / srcH);
  const outW = Math.max(1, Math.round(srcW * scale));
  const outH = Math.max(1, Math.round(srcH * scale));

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext("2d");
  ctx.filter = `brightness(${brightness}%) contrast(${contrast}%)`;
  ctx.drawImage(source, 0, 0, outW, outH);
  ctx.filter = "none";
  return out;
}

/** Scale down to fit 1920×1080; never upscale. */
export function fit1080Canvas(source) {
  return renderAdjustedCanvas(source, {
    brightness: 100,
    contrast: 100,
    maxWidth: SHARE_MAX_W,
    maxHeight: SHARE_MAX_H,
  });
}

/** Center cover-crop → square canvas. */
export function renderSquareThumbCanvas(adjustedCanvas, size = THUMB_SIZE) {
  const thumb = document.createElement("canvas");
  thumb.width = size;
  thumb.height = size;
  const ctx = thumb.getContext("2d");
  const srcW = adjustedCanvas.width;
  const srcH = adjustedCanvas.height;
  const side = Math.min(srcW, srcH);
  const sx = Math.round((srcW - side) / 2);
  const sy = Math.round((srcH - side) / 2);
  ctx.drawImage(adjustedCanvas, sx, sy, side, side, 0, 0, size, size);
  return thumb;
}

/** Center cover-crop → square JPEG blob. */
export async function squareThumbBlob(
  sourceCanvas,
  size = THUMB_SIZE,
  quality = SHARE_JPEG_QUALITY
) {
  return canvasToJpegBlob(renderSquareThumbCanvas(sourceCanvas, size), quality);
}

/**
 * Encode JPEG at 0.85; drop to 0.70 if over 2 MiB.
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Blob>}
 */
export async function encodeJpegUnderCap(canvas) {
  let blob = await canvasToJpegBlob(canvas, LOCAL_JPEG_QUALITY);
  if (blob.size > MAX_JPEG_BYTES) {
    blob = await canvasToJpegBlob(canvas, SHARE_JPEG_QUALITY);
  }
  return blob;
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
