import { createBaffledScreenshots } from "../vendor/baffled-screenshots.js";
import {
  LOCAL_JPEG_QUALITY,
  SHARE_JPEG_QUALITY,
  canvasToBlob,
  snapshotTo2d,
  fit1080Canvas,
  squareThumbBlob,
  downloadBlob,
  shotFilename,
} from "./capture.js";
import { formatCenter, urlCenterDigits } from "../view.js";

/**
 * Shot dialog: always download native JPEG; optional share to baffledcat.com.
 */
export class ScreenshotUI {
  /**
   * @param {object} opts
   * @param {() => HTMLCanvasElement} opts.getCanvas
   * @param {() => object} opts.getView
   * @param {() => object} opts.getParams
   * @param {object} [opts.shotsConfig]
   */
  constructor({ getCanvas, getView, getParams, shotsConfig }) {
    this.getCanvas = getCanvas;
    this.getView = getView;
    this.getParams = getParams;
    this._shots = null;
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
    this.root = document.createElement("div");
    this.root.id = "shot-dialog";
    this.root.className = "shot-dialog hidden";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "Save screenshot");
    this.root.innerHTML = `
      <div class="shot-dialog__card">
        <header class="shot-dialog__header">
          <h2 class="shot-dialog__title">Screenshot</h2>
          <button type="button" class="shot-dialog__close" aria-label="Close">&times;</button>
        </header>
        <p class="shot-dialog__hint">A full-resolution copy will download to your device.</p>
        <label class="shot-dialog__share">
          <input type="checkbox" id="shot-share" />
          <span>Also share to baffledcat.com (≤1080p)</span>
        </label>
        <p class="shot-dialog__status" id="shot-status" hidden></p>
        <div class="shot-dialog__actions">
          <button type="button" class="shot-dialog__btn shot-dialog__btn--secondary" data-act="cancel">Cancel</button>
          <button type="button" class="shot-dialog__btn" data-act="save">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(this.root);

    this.shareEl = this.root.querySelector("#shot-share");
    this.statusEl = this.root.querySelector("#shot-status");
    this.root.querySelector(".shot-dialog__close").onclick = () => this.close();
    this.root.querySelector('[data-act="cancel"]').onclick = () => this.close();
    this.root.querySelector('[data-act="save"]').onclick = () => void this._save();
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
      e.stopPropagation();
    });
  }

  open() {
    this.shareEl.checked = false;
    this._setStatus("");
    this.root.classList.remove("hidden");
  }

  close() {
    this.root.classList.add("hidden");
  }

  _setStatus(text, isError = false) {
    if (!text) {
      this.statusEl.hidden = true;
      this.statusEl.textContent = "";
      return;
    }
    this.statusEl.hidden = false;
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("is-error", isError);
  }

  async _save() {
    const canvas = this.getCanvas();
    const view = this.getView();
    const params = this.getParams();
    if (!canvas || canvas.width < 1) {
      this._setStatus("Nothing to capture", true);
      return;
    }

    const saveBtn = this.root.querySelector('[data-act="save"]');
    saveBtn.disabled = true;
    try {
      this._setStatus("Encoding…");
      const snap = await snapshotTo2d(canvas);
      const localBlob = await canvasToBlob(
        snap,
        "image/jpeg",
        LOCAL_JPEG_QUALITY
      );
      downloadBlob(localBlob, shotFilename("mandelbrot"));

      if (!this.shareEl.checked) {
        this._setStatus("Saved to your device.");
        setTimeout(() => this.close(), 700);
        return;
      }

      this._setStatus("Uploading…");
      const shareCanvas = fit1080Canvas(snap);
      const [imageBlob, thumbBlob] = await Promise.all([
        canvasToBlob(shareCanvas, "image/jpeg", SHARE_JPEG_QUALITY),
        squareThumbBlob(shareCanvas),
      ]);

      const digits = urlCenterDigits(view.scale);
      const c = formatCenter(view, digits);
      const pageUrl = location.href;
      const meta = {
        cx: c.x,
        cy: c.y,
        scale: view.scale.toExponential(12),
        maxIter: params.maxIter,
        algo: params.algo,
        aa: params.aaMax,
        grad: params.grad,
        goff: params.goff,
        gdens: params.gdens,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        shareWidth: shareCanvas.width,
        shareHeight: shareCanvas.height,
      };

      const result = await this._client().upload({
        imageBlob,
        thumbBlob,
        pageUrl,
        meta,
      });

      this._setStatus(`Saved & shared · ${result.id}`);
      setTimeout(() => this.close(), 900);
    } catch (err) {
      console.error(err);
      this._setStatus(err.message || "Share failed", true);
    } finally {
      saveBtn.disabled = false;
    }
  }
}
