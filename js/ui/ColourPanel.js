import {
  LUT_WIDTH,
  LUT_HEIGHT,
  bakeLut2d,
  docFromPreset,
  cloneDoc,
  rgbToHex,
  hexToRgb,
  BLEND_RGB,
  BLEND_HSL,
  WRAP_REPEAT,
  WRAP_CLAMP,
  WRAP_MIRROR,
  DEFAULT_SCHEME_MAPPING,
  migratePresetId,
} from "../color/gradient.js";
import { clearScheme } from "../color/schemeStore.js";

/**
 * Side panel: 2D LUT preview, U/V stop editors, mapping / blend / wrap.
 */
export class ColourPanel {
  /**
   * @param {HTMLElement} root
   * @param {{ onChange?: (partial: object) => void, onClose?: () => void }} handlers
   */
  constructor(root, handlers = {}) {
    this.root = root;
    this.onChange = handlers.onChange || (() => {});
    this.onClose = handlers.onClose || (() => {});
    this.enabled = false;
    this.doc = docFromPreset("classic");
    this._axis = "u"; // selected axis for stop editing
    this._sel = 0;
    this._drag = null;
    this._build();
  }

  _build() {
    this.root.classList.add("colour-panel");
    this.root.innerHTML = `
      <header class="colour-panel__header">
        <h2 class="colour-panel__title">Colour</h2>
        <button type="button" class="colour-panel__close" data-act="close" aria-label="Close colour panel">&times;</button>
      </header>

      <div class="colour-panel__preview-wrap">
        <canvas class="colour-panel__preview" width="${LUT_WIDTH}" height="${LUT_HEIGHT}" aria-label="2D colour lookup texture"></canvas>
      </div>

      <div class="colour-panel__axes">
        <div class="colour-panel__axis" data-axis="u">
          <div class="colour-panel__axis-label">U · iteration</div>
          <div class="colour-panel__bar-wrap">
            <canvas class="colour-panel__bar" data-bar="u" height="28" aria-label="U gradient stops"></canvas>
            <div class="colour-panel__handles" data-handles="u"></div>
          </div>
        </div>
        <div class="colour-panel__axis" data-axis="v">
          <div class="colour-panel__axis-label">V · secondary</div>
          <div class="colour-panel__bar-wrap">
            <canvas class="colour-panel__bar" data-bar="v" height="28" aria-label="V gradient stops"></canvas>
            <div class="colour-panel__handles" data-handles="v"></div>
          </div>
        </div>
      </div>

      <div class="colour-panel__stop-edit">
        <label class="colour-panel__color-field">
          <span>Stop colour</span>
          <input type="color" data-role="stop-color" value="#ffffff" />
        </label>
        <button type="button" class="colour-panel__btn" data-act="add-stop">Add stop</button>
        <button type="button" class="colour-panel__btn colour-panel__btn--danger" data-act="del-stop">Delete</button>
      </div>

      <div class="colour-panel__grid">
        <label class="field">
          <span class="field__label">Offset X <span data-val="offU" class="field__value">0</span></span>
          <input data-param="offU" class="field__control" type="range" min="0" max="1" step="0.001" value="0" />
        </label>
        <label class="field">
          <span class="field__label">Offset Y <span data-val="offV" class="field__value">0</span></span>
          <input data-param="offV" class="field__control" type="range" min="0" max="1" step="0.001" value="0" />
        </label>
        <label class="field">
          <span class="field__label">Density X <span data-val="densU" class="field__value">12</span></span>
          <input data-param="densU" class="field__control" type="range" min="1" max="48" step="0.5" value="12" title="Palette cycles from iter 0 to max iterations" />
        </label>
        <label class="field">
          <span class="field__label">Density Y <span data-val="densV" class="field__value">1</span></span>
          <input data-param="densV" class="field__control" type="range" min="0.25" max="16" step="0.25" value="1" title="Cycles across the V (secondary) axis" />
        </label>
        <div class="colour-panel__row">
          <label class="field">
            <span class="field__label">Blend</span>
            <select data-doc="blend" class="field__control">
              <option value="${BLEND_RGB}">RGB</option>
              <option value="${BLEND_HSL}">HSL</option>
            </select>
          </label>
          <label class="field">
            <span class="field__label">Wrap U</span>
            <select data-doc="wrapU" class="field__control">
              <option value="${WRAP_REPEAT}">Repeat</option>
              <option value="${WRAP_CLAMP}">Clamp</option>
              <option value="${WRAP_MIRROR}">Mirror</option>
            </select>
          </label>
          <label class="field">
            <span class="field__label">Wrap V</span>
            <select data-doc="wrapV" class="field__control">
              <option value="${WRAP_REPEAT}">Repeat</option>
              <option value="${WRAP_CLAMP}">Clamp</option>
              <option value="${WRAP_MIRROR}">Mirror</option>
            </select>
          </label>
        </div>
      </div>

      <div class="colour-panel__actions">
        <button type="button" class="colour-panel__btn" data-act="reset-default">
          Reset to Default
        </button>
        <button type="button" class="colour-panel__btn colour-panel__btn--muted" data-act="load-image" disabled title="Coming soon">
          Load image…
        </button>
      </div>
      <p class="colour-panel__hint">2D lookup = U × V colour multiply. Row v=0 is the 1D (Flat) palette. Edits are saved per scheme in this browser.</p>
    `;

    this.preview = this.root.querySelector(".colour-panel__preview");
    this.previewCtx = this.preview.getContext("2d");
    this.stopColor = this.root.querySelector('[data-role="stop-color"]');
    this.barU = this.root.querySelector('[data-bar="u"]');
    this.barV = this.root.querySelector('[data-bar="v"]');
    this.handlesU = this.root.querySelector('[data-handles="u"]');
    this.handlesV = this.root.querySelector('[data-handles="v"]');

    this.root.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.root.addEventListener("wheel", (e) => e.stopPropagation(), { passive: false });

    for (const input of this.root.querySelectorAll("[data-param]")) {
      input.addEventListener("input", () => {
        const key = input.dataset.param;
        const val = Number(input.value);
        const label = this.root.querySelector(`[data-val="${key}"]`);
        if (label) label.textContent = fmtNum(val);
        this.onChange({ [key]: val });
      });
    }

    for (const sel of this.root.querySelectorAll("[data-doc]")) {
      sel.addEventListener("change", () => {
        const key = sel.dataset.doc;
        this.doc = cloneDoc(this.doc);
        this.doc[key] = sel.value;
        this.doc.custom = true;
        this._paint();
        this.onChange({ gradDoc: cloneDoc(this.doc), grad: this.doc.presetId });
      });
    }

    this.stopColor.addEventListener("input", () => {
      const stops = this._stops();
      if (!stops[this._sel]) return;
      this.doc = cloneDoc(this.doc);
      const list = this._axis === "u" ? this.doc.uStops : this.doc.vStops;
      list[this._sel][1] = hexToRgb(this.stopColor.value);
      this.doc.custom = true;
      this._paint();
      this.onChange({ gradDoc: cloneDoc(this.doc), grad: this.doc.presetId });
    });

    this.root.querySelector('[data-act="add-stop"]').addEventListener("click", () => {
      this.doc = cloneDoc(this.doc);
      const list = this._axis === "u" ? this.doc.uStops : this.doc.vStops;
      const t = list.length ? Math.min(1, (list[this._sel]?.[0] ?? 0.5) + 0.08) : 0.5;
      list.push([t, hexToRgb(this.stopColor.value)]);
      list.sort((a, b) => a[0] - b[0]);
      this._sel = list.findIndex(([x]) => x === t);
      this.doc.custom = true;
      this._paint();
      this.onChange({ gradDoc: cloneDoc(this.doc), grad: this.doc.presetId });
    });

    this.root.querySelector('[data-act="del-stop"]').addEventListener("click", () => {
      const list = this._axis === "u" ? this.doc.uStops : this.doc.vStops;
      if (list.length <= 2) return;
      this.doc = cloneDoc(this.doc);
      const next = this._axis === "u" ? this.doc.uStops : this.doc.vStops;
      next.splice(this._sel, 1);
      this._sel = Math.min(this._sel, next.length - 1);
      this.doc.custom = true;
      this._paint();
      this.onChange({ gradDoc: cloneDoc(this.doc), grad: this.doc.presetId });
    });

    this.root.querySelector('[data-act="close"]').addEventListener("click", () => {
      this.onClose();
    });

    this.root.querySelector('[data-act="reset-default"]').addEventListener("click", () => {
      const id = migratePresetId(this.doc.presetId || "classic");
      clearScheme(id);
      this.doc = docFromPreset(id);
      this._sel = 0;
      this._axis = "u";
      const map = { ...DEFAULT_SCHEME_MAPPING };
      for (const [key, val] of Object.entries(map)) {
        const input = this.root.querySelector(`[data-param="${key}"]`);
        if (input) input.value = String(val);
        const label = this.root.querySelector(`[data-val="${key}"]`);
        if (label) label.textContent = fmtNum(val);
      }
      const blend = this.root.querySelector('[data-doc="blend"]');
      const wrapU = this.root.querySelector('[data-doc="wrapU"]');
      const wrapV = this.root.querySelector('[data-doc="wrapV"]');
      if (blend) blend.value = this.doc.blend || BLEND_RGB;
      if (wrapU) wrapU.value = this.doc.wrapU || WRAP_REPEAT;
      if (wrapV) wrapV.value = this.doc.wrapV || WRAP_REPEAT;
      this._syncAxisActive();
      this._paint();
      this.onChange({
        grad: id,
        gradDoc: cloneDoc(this.doc),
        ...map,
        goff: map.offU,
        gdens: map.densU,
        resetScheme: true,
      });
    });

    for (const axis of ["u", "v"]) {
      const wrap = this.root.querySelector(`[data-handles="${axis}"]`);
      wrap.addEventListener("pointerdown", (e) => this._onBarPointer(axis, e));
      this.root.querySelector(`[data-axis="${axis}"]`).addEventListener("click", () => {
        this._axis = axis;
        this._syncAxisActive();
        this._syncStopColor();
      });
    }

    window.addEventListener("pointermove", (e) => this._onDragMove(e));
    window.addEventListener("pointerup", () => {
      this._drag = null;
    });
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.root.classList.toggle("hidden", !this.enabled);
    this.root.setAttribute("aria-hidden", this.enabled ? "false" : "true");
    if (this.enabled) {
      this._resizeBars();
      this._paint();
    }
  }

  /**
   * Sync from scheduler params.
   * @param {object} params
   */
  setState(params) {
    if (params.gradDoc) {
      this.doc = cloneDoc(params.gradDoc);
    } else if (params.grad) {
      this.doc = docFromPreset(params.grad);
    }
    const map = {
      offU: params.offU ?? params.goff ?? 0,
      offV: params.offV ?? 0,
      densU: params.densU ?? params.gdens ?? 12,
      densV: params.densV ?? 1,
    };
    for (const [key, val] of Object.entries(map)) {
      const input = this.root.querySelector(`[data-param="${key}"]`);
      if (input) {
        input.value = String(val);
        const label = this.root.querySelector(`[data-val="${key}"]`);
        if (label) label.textContent = fmtNum(val);
      }
    }
    const blend = this.root.querySelector('[data-doc="blend"]');
    const wrapU = this.root.querySelector('[data-doc="wrapU"]');
    const wrapV = this.root.querySelector('[data-doc="wrapV"]');
    if (blend) blend.value = this.doc.blend || BLEND_RGB;
    if (wrapU) wrapU.value = this.doc.wrapU || WRAP_REPEAT;
    if (wrapV) wrapV.value = this.doc.wrapV || WRAP_REPEAT;
    this._sel = Math.min(this._sel, this._stops().length - 1);
    if (this.enabled) this._paint();
  }

  _stops() {
    return this._axis === "u" ? this.doc.uStops : this.doc.vStops;
  }

  _syncAxisActive() {
    for (const el of this.root.querySelectorAll(".colour-panel__axis")) {
      el.classList.toggle("is-active", el.dataset.axis === this._axis);
    }
  }

  _syncStopColor() {
    const s = this._stops()[this._sel];
    if (s) this.stopColor.value = rgbToHex(s[1]);
  }

  _resizeBars() {
    for (const canvas of [this.barU, this.barV]) {
      const wrap = canvas.parentElement;
      const w = Math.max(120, Math.floor(wrap.clientWidth || 240));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(28 * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = "28px";
    }
  }

  _paint() {
    this._resizeBars();
    this._paintPreview();
    this._paintBar(this.barU, this.doc.uStops);
    this._paintBar(this.barV, this.doc.vStops);
    this._renderHandles("u", this.doc.uStops, this.handlesU);
    this._renderHandles("v", this.doc.vStops, this.handlesV);
    this._syncAxisActive();
    this._syncStopColor();
  }

  _paintPreview() {
    const data = bakeLut2d(this.doc);
    const img = this.previewCtx.createImageData(LUT_WIDTH, LUT_HEIGHT);
    img.data.set(data);
    this.previewCtx.putImageData(img, 0, 0);
  }

  _paintBar(canvas, stops) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const doc = {
      ...this.doc,
      uStops: stops,
      vStops: [
        [0, [1, 1, 1]],
        [1, [1, 1, 1]],
      ],
    };
    const row = bakeLut2d(doc, w, 1);
    const img = ctx.createImageData(w, 1);
    img.data.set(row);
    // Stretch to bar height.
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = 1;
    tmp.getContext("2d").putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, w, h);
  }

  _renderHandles(axis, stops, host) {
    host.replaceChildren();
    const active = axis === this._axis;
    stops.forEach((stop, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "colour-panel__handle";
      if (active && i === this._sel) btn.classList.add("is-selected");
      btn.style.left = `${stop[0] * 100}%`;
      btn.style.background = rgbToHex(stop[1]);
      btn.dataset.axis = axis;
      btn.dataset.index = String(i);
      btn.setAttribute("aria-label", `${axis.toUpperCase()} stop ${i + 1}`);
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._axis = axis;
        this._sel = i;
        this._drag = { axis, index: i, el: host };
        btn.setPointerCapture?.(e.pointerId);
        this._syncAxisActive();
        this._syncStopColor();
        this._renderHandles(axis, stops, host);
      });
      host.appendChild(btn);
    });
  }

  _onBarPointer(axis, e) {
    if (e.target.classList?.contains("colour-panel__handle")) return;
    const host = e.currentTarget;
    const rect = host.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    this._axis = axis;
    this.doc = cloneDoc(this.doc);
    const list = axis === "u" ? this.doc.uStops : this.doc.vStops;
    list.push([t, hexToRgb(this.stopColor.value)]);
    list.sort((a, b) => a[0] - b[0]);
    this._sel = list.findIndex(([x]) => Math.abs(x - t) < 1e-6);
    this.doc.custom = true;
    this._drag = { axis, index: this._sel, el: host };
    this._paint();
    this.onChange({ gradDoc: cloneDoc(this.doc), grad: this.doc.presetId });
  }

  _onDragMove(e) {
    if (!this._drag) return;
    const { axis, index, el } = this._drag;
    const rect = el.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    this.doc = cloneDoc(this.doc);
    const list = axis === "u" ? this.doc.uStops : this.doc.vStops;
    if (!list[index]) return;
    list[index][0] = t;
    list.sort((a, b) => a[0] - b[0]);
    this._sel = list.findIndex((s) => s === list.find((x) => x[0] === t) || s[0] === t);
    // After sort, find by colour+approx t
    this._sel = list.reduce(
      (best, s, i) => (Math.abs(s[0] - t) < Math.abs(list[best][0] - t) ? i : best),
      0
    );
    this._drag.index = this._sel;
    this.doc.custom = true;
    this._paint();
    this.onChange({ gradDoc: cloneDoc(this.doc), grad: this.doc.presetId });
  }
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return "—";
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}
