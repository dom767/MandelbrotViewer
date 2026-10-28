import { createBaffledScreenshots } from "../vendor/baffled-screenshots.js";
import {
  encodeJpegUnderCap,
  canvasToJpegBlob,
  renderAdjustedCanvas,
  renderSquareThumbCanvas,
  downloadBlob,
  shotFilename,
  SHARE_JPEG_QUALITY,
} from "./capture.js";
import { formatCenter, urlCenterDigits } from "../view.js";

const PREVIEW_MAX_W = 480;
const PREVIEW_MAX_H = 270;

/**
 * Take Screenshot panel: snapshot on open, adjust brightness/contrast,
 * always download JPEG; optionally upload via ScreenGrabber.
 */
export class ScreenshotUI {
  /**
   * @param {object} opts
   * @param {() => Promise<HTMLCanvasElement>} opts.getSnapshot
   *   Fractal pixels as a 2D canvas (GPU readback — not the WebGPU swapchain).
   * @param {() => object} opts.getView
   * @param {() => object} opts.getParams
   * @param {object} [opts.shotsConfig]
   * @param {(result: object) => void} [opts.onShared]
   */
  constructor({ getSnapshot, getView, getParams, shotsConfig, onShared }) {
    this.getSnapshot = getSnapshot;
    this.getView = getView;
    this.getParams = getParams;
    this.onShared = onShared || null;
    this._shots = null;
    this._snap = null;
    this._busy = false;
    this._config = shotsConfig || {
      apiBase: "https://shots.baffledcat.com",
      appId: "mandelbrot",
      turnstileSiteKey: "",
      devBypassTurnstile: true,
    };
    this._build();
  }

  _client() {
    if (!this._shots) {
      this._shots = createBaffledScreenshots(this._config);
    }
    return this._shots;
  }

  _build() {
    this.dialog = document.createElement("dialog");
    this.dialog.id = "screenshot-panel";
    this.dialog.className = "bc-shot-dialog";
    this.dialog.setAttribute("aria-labelledby", "screenshot-panel-title");
    this.dialog.innerHTML = `
      <form method="dialog" class="bc-shot-panel" id="screenshot-form">
        <header class="bc-shot-panel__head">
          <h2 id="screenshot-panel-title" class="bc-shot-panel__title">Take screenshot</h2>
          <button type="button" class="bc-shot-panel__close" id="screenshot-close-btn" aria-label="Close">
            &times;
          </button>
        </header>

        <div class="bc-shot-panel__preview-wrap">
          <canvas id="screenshot-preview" class="bc-shot-panel__preview" width="480" height="270"></canvas>
        </div>

        <div class="bc-shot-panel__controls">
          <div class="bc-shot-field">
            <div class="bc-shot-field__label-row">
              <label for="screenshot-brightness" class="bc-shot-field__label">Brightness</label>
              <output for="screenshot-brightness" id="screenshot-brightness-val" class="bc-shot-field__value">100%</output>
            </div>
            <input
              type="range"
              id="screenshot-brightness"
              min="50"
              max="150"
              step="1"
              value="100"
            />
          </div>

          <div class="bc-shot-field">
            <div class="bc-shot-field__label-row">
              <label for="screenshot-contrast" class="bc-shot-field__label">Contrast</label>
              <output for="screenshot-contrast" id="screenshot-contrast-val" class="bc-shot-field__value">100%</output>
            </div>
            <input
              type="range"
              id="screenshot-contrast"
              min="50"
              max="150"
              step="1"
              value="100"
            />
          </div>

          <label class="bc-shot-checkbox">
            <input type="checkbox" id="screenshot-upload-check" />
            <span>Upload to baffledcat.com</span>
          </label>
        </div>

        <p id="screenshot-status" class="bc-shot-panel__status" role="status" aria-live="polite" hidden></p>

        <footer class="bc-shot-panel__actions">
          <button type="button" class="bc-btn bc-btn--secondary" id="screenshot-reset-btn">
            Reset
          </button>
          <div class="bc-shot-panel__actions-right">
            <button type="button" class="bc-btn bc-btn--secondary" id="screenshot-cancel-btn">
              Cancel
            </button>
            <button type="button" class="bc-btn bc-btn--primary" id="screenshot-capture-btn">
              Capture
            </button>
          </div>
        </footer>
      </form>
    `;
    document.body.appendChild(this.dialog);

    this.previewEl = this.dialog.querySelector("#screenshot-preview");
    this.brightnessEl = this.dialog.querySelector("#screenshot-brightness");
    this.contrastEl = this.dialog.querySelector("#screenshot-contrast");
    this.brightnessVal = this.dialog.querySelector("#screenshot-brightness-val");
    this.contrastVal = this.dialog.querySelector("#screenshot-contrast-val");
    this.uploadEl = this.dialog.querySelector("#screenshot-upload-check");
    this.statusEl = this.dialog.querySelector("#screenshot-status");
    this.captureBtn = this.dialog.querySelector("#screenshot-capture-btn");
    this.form = this.dialog.querySelector("#screenshot-form");

    this.dialog.querySelector("#screenshot-close-btn").onclick = () => this.close();
    this.dialog.querySelector("#screenshot-cancel-btn").onclick = () => this.close();
    this.dialog.querySelector("#screenshot-reset-btn").onclick = () => this._resetAdjustments();
    this.captureBtn.onclick = () => void this._capture();

    this.brightnessEl.addEventListener("input", () => this._onAdjust());
    this.contrastEl.addEventListener("input", () => this._onAdjust());

    this.form.addEventListener("submit", (e) => e.preventDefault());

    this.dialog.addEventListener("cancel", (e) => {
      if (this._busy) {
        e.preventDefault();
        return;
      }
      this._snap = null;
    });

    this.dialog.addEventListener("click", (e) => {
      if (this._busy) return;
      const rect = this.dialog.getBoundingClientRect();
      const outside =
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom;
      if (outside) this.close();
    });

    // Keep legacy id for any callers that looked up #shot-dialog
    this.root = this.dialog;
  }

  async open() {
    if (this._busy) return;
    this.uploadEl.checked = false;
    this._resetAdjustments(false);
    this._setStatus("Capturing…");
    this.captureBtn.disabled = true;
    this._snap = null;
    this._clearPreview();

    if (!this.dialog.open) {
      this.dialog.showModal();
    }

    try {
      const snap = await this.getSnapshot();
      if (!snap || snap.width < 1) {
        this._setStatus("Nothing to capture", true);
        this.captureBtn.disabled = true;
        return;
      }
      this._snap = snap;
      this._setStatus("");
      this.captureBtn.disabled = false;
      this._updatePreview();
    } catch (err) {
      console.error(err);
      this._setStatus(err.message || "Capture failed", true);
      this.captureBtn.disabled = true;
    }
  }

  close() {
    if (this._busy) return;
    this._snap = null;
    if (this.dialog.open) this.dialog.close();
  }

  _resetAdjustments(updatePreview = true) {
    this.brightnessEl.value = "100";
    this.contrastEl.value = "100";
    this.brightnessVal.textContent = "100%";
    this.contrastVal.textContent = "100%";
    if (updatePreview) this._updatePreview();
  }

  _onAdjust() {
    this.brightnessVal.textContent = `${this.brightnessEl.value}%`;
    this.contrastVal.textContent = `${this.contrastEl.value}%`;
    this._updatePreview();
  }

  _brightness() {
    return Number(this.brightnessEl.value) || 100;
  }

  _contrast() {
    return Number(this.contrastEl.value) || 100;
  }

  _clearPreview() {
    const ctx = this.previewEl.getContext("2d");
    ctx.clearRect(0, 0, this.previewEl.width, this.previewEl.height);
  }

  _updatePreview() {
    if (!this._snap) return;
    const preview = renderAdjustedCanvas(this._snap, {
      brightness: this._brightness(),
      contrast: this._contrast(),
      maxWidth: PREVIEW_MAX_W,
      maxHeight: PREVIEW_MAX_H,
    });
    this.previewEl.width = preview.width;
    this.previewEl.height = preview.height;
    const ctx = this.previewEl.getContext("2d");
    ctx.clearRect(0, 0, preview.width, preview.height);
    ctx.drawImage(preview, 0, 0);
  }

  _setStatus(text, isError = false) {
    if (!text) {
      this.statusEl.hidden = true;
      this.statusEl.textContent = "";
      this.statusEl.removeAttribute("data-error");
      return;
    }
    this.statusEl.hidden = false;
    this.statusEl.textContent = text;
    this.statusEl.dataset.error = isError ? "true" : "false";
  }

  _buildMeta(snap, shareCanvas) {
    const view = this.getView();
    const params = this.getParams();
    const digits = urlCenterDigits(view.scale);
    const c = formatCenter(view, digits);
    return {
      cx: c.x,
      cy: c.y,
      scale: view.scale.toExponential(12),
      maxIter: params.maxIter,
      algo: params.algo,
      aa: params.aaMax,
      grad: params.grad,
      offU: params.offU ?? params.goff,
      offV: params.offV ?? 0,
      densU: params.densU ?? params.gdens,
      densV: params.densV ?? 1,
      goff: params.offU ?? params.goff,
      gdens: params.densU ?? params.gdens,
      secondary: params.secondary,
      trapShape: params.trapShape,
      sfreq: params.sfreq,
      swin: params.swin,
      deGain: params.deGain,
      blend: params.gradDoc?.blend,
      wrapU: params.gradDoc?.wrapU,
      wrapV: params.gradDoc?.wrapV,
      canvasWidth: snap.width,
      canvasHeight: snap.height,
      shareWidth: shareCanvas.width,
      shareHeight: shareCanvas.height,
      brightness: this._brightness(),
      contrast: this._contrast(),
    };
  }

  async _capture() {
    if (this._busy || !this._snap) return;
    const snap = this._snap;
    const shouldUpload = this.uploadEl.checked;
    this._busy = true;
    this.captureBtn.disabled = true;
    this.brightnessEl.disabled = true;
    this.contrastEl.disabled = true;
    this.uploadEl.disabled = true;

    try {
      this._setStatus("Capturing…");
      const adjusted = renderAdjustedCanvas(snap, {
        brightness: this._brightness(),
        contrast: this._contrast(),
      });

      let imageBlob = await encodeJpegUnderCap(adjusted);
      downloadBlob(imageBlob, shotFilename(this._config.appId || "mandelbrot"));

      if (!shouldUpload) {
        this._setStatus("Saved to your device.");
        setTimeout(() => {
          this._busy = false;
          this._enableControls();
          this.close();
        }, 700);
        return;
      }

      this._setStatus("Uploading…");
      const thumbBlob = await canvasToJpegBlob(
        renderSquareThumbCanvas(adjusted, 256),
        SHARE_JPEG_QUALITY
      );

      const result = await this._client().upload({
        imageBlob,
        thumbBlob,
        pageUrl: location.href,
        meta: this._buildMeta(snap, adjusted),
      });

      if (this.onShared) this.onShared(result);
      this._setStatus(`Saved & uploaded · ${result.id}`);
      setTimeout(() => {
        this._busy = false;
        this._enableControls();
        this.close();
      }, 900);
    } catch (err) {
      console.error(err);
      const fallback = shouldUpload ? "Upload failed" : "Capture failed";
      this._setStatus(err.message || fallback, true);
      this._busy = false;
      this._enableControls();
    }
  }

  _enableControls() {
    this.captureBtn.disabled = !this._snap;
    this.brightnessEl.disabled = false;
    this.contrastEl.disabled = false;
    this.uploadEl.disabled = false;
  }
}
