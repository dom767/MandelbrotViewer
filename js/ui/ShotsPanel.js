import { createBaffledScreenshots } from "../vendor/baffled-screenshots.js";

/**
 * Side panel: recent shared screenshots + Take Screenshot.
 */
export class ShotsPanel {
  /**
   * @param {HTMLElement} root
   * @param {object} opts
   * @param {object} [opts.shotsConfig]
   * @param {(shot: object) => void} [opts.onSelect]
   * @param {() => void} [opts.onTakeScreenshot]
   */
  constructor(root, { shotsConfig, onSelect, onTakeScreenshot } = {}) {
    this.root = root;
    this.onSelect = onSelect || (() => {});
    this.onTakeScreenshot = onTakeScreenshot || (() => {});
    this.enabled = false;
    this._config = shotsConfig || {
      apiBase: "https://shots.baffledcat.com",
      appId: "mandelbrot",
      turnstileSiteKey: "",
      devBypassTurnstile: true,
    };
    this._client = null;
    this._shots = [];
    this._build();
  }

  _api() {
    if (!this._client) {
      this._client = createBaffledScreenshots(this._config);
    }
    return this._client;
  }

  _build() {
    this.root.classList.add("shots-panel");
    this.root.innerHTML = `
      <header class="shots-panel__header">
        <h2 class="shots-panel__title">Shots</h2>
      </header>
      <button type="button" class="shots-panel__take" data-act="take">Take Screenshot</button>
      <p class="shots-panel__status" data-role="status" hidden></p>
      <div class="shots-panel__grid" data-role="grid"></div>
    `;

    this.statusEl = this.root.querySelector('[data-role="status"]');
    this.gridEl = this.root.querySelector('[data-role="grid"]');
    this.root.querySelector('[data-act="take"]').onclick = () => {
      this.onTakeScreenshot();
    };

    this.root.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.root.addEventListener("wheel", (e) => e.stopPropagation(), {
      passive: false,
    });
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.root.classList.toggle("hidden", !this.enabled);
    this.root.setAttribute("aria-hidden", this.enabled ? "false" : "true");
    if (this.enabled) void this.refresh();
  }

  async refresh() {
    if (!this.enabled) return;
    this._setStatus("Loading…");
    try {
      const data = await this._api().list({ limit: 10 });
      this._shots = data.shots || [];
      this._renderGrid();
      if (!this._shots.length) {
        this._setStatus("No shared shots yet.");
      } else {
        this._setStatus("");
      }
    } catch (err) {
      console.warn("shots list failed", err);
      this._shots = [];
      this._renderGrid();
      this._setStatus(err.message || "Could not load shots", true);
    }
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

  _renderGrid() {
    this.gridEl.innerHTML = "";
    for (const shot of this._shots) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "shots-panel__card";
      btn.title = shot.title || shot.appId || "Open shot";
      const img = document.createElement("img");
      img.src = shot.thumbUrl || shot.imageUrl;
      img.alt = "";
      img.loading = "lazy";
      btn.appendChild(img);
      btn.onclick = () => this.onSelect(shot);
      this.gridEl.appendChild(btn);
    }
  }
}
