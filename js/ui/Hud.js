import { listIterators } from "../iterators/registry.js";
import { listPresets } from "../color/gradient.js";
import {
  SECONDARY_OPTIONS,
  SECONDARY_STRIPES,
  SECONDARY_DE,
  normalizeSecondary,
} from "../color/secondary.js";
import { zoomFactor } from "../view.js";

export class Hud {
  /**
   * @param {object} els DOM element refs
   * @param {object} handlers callbacks
   */
  constructor(els, handlers) {
    this.els = els;
    this.handlers = handlers;
    this._fillSelects();
    this._bind();
  }

  _fillSelects() {
    const { algo, grad, secondary } = this.els;
    algo.replaceChildren();
    for (const it of listIterators()) {
      const opt = document.createElement("option");
      opt.value = it.id;
      opt.textContent = it.label;
      algo.appendChild(opt);
    }
    grad.replaceChildren();
    for (const p of listPresets()) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      grad.appendChild(opt);
    }
    if (secondary) {
      secondary.replaceChildren();
      for (const o of SECONDARY_OPTIONS) {
        const opt = document.createElement("option");
        opt.value = o.id;
        opt.textContent = o.label;
        secondary.appendChild(opt);
      }
    }
  }

  _bind() {
    const { algo, iter, aa, grad, colourEdit, secondary } = this.els;
    const h = this.handlers;

    algo.addEventListener("change", () => h.onParams({ algo: algo.value }));
    iter.addEventListener("input", () => {
      const maxIter = Number(iter.value);
      this.els.iterValue.textContent = String(maxIter);
      h.onParams({ maxIter });
    });
    aa.addEventListener("change", () => h.onParams({ aaMax: Number(aa.value) }));
    grad.addEventListener("change", () => h.onParams({ grad: grad.value }));
    colourEdit?.addEventListener("click", () => h.onColourEdit?.());
    secondary?.addEventListener("change", () => {
      this._syncSecondaryFields(secondary.value);
      h.onParams({ secondary: secondary.value });
    });
    const { sfreq, swin, degain } = this.els;
    sfreq?.addEventListener("input", () => {
      const sfreqVal = Number(sfreq.value);
      if (this.els.sfreqValue) this.els.sfreqValue.textContent = String(sfreqVal);
      h.onParams({ sfreq: sfreqVal });
    });
    swin?.addEventListener("input", () => {
      const swinVal = Number(swin.value);
      if (this.els.swinValue) this.els.swinValue.textContent = String(swinVal);
      h.onParams({ swin: swinVal });
    });
    degain?.addEventListener("input", () => {
      const g = Number(degain.value);
      if (this.els.degainValue) this.els.degainValue.textContent = String(g);
      h.onParams({ deGain: g });
    });
  }

  _syncSecondaryFields(secondaryId) {
    const s = normalizeSecondary(secondaryId);
    const stripes = s === SECONDARY_STRIPES;
    const de = s === SECONDARY_DE;
    if (this.els.sfreqField) this.els.sfreqField.hidden = !stripes;
    if (this.els.swinField) this.els.swinField.hidden = !stripes;
    if (this.els.degainField) this.els.degainField.hidden = !de;
  }

  setState(params) {
    const { algo, iter, aa, grad, iterValue, secondary } = this.els;
    if (params.algo != null) algo.value = params.algo;
    if (params.maxIter != null) {
      iter.value = String(params.maxIter);
      iterValue.textContent = String(params.maxIter);
    }
    if (params.aaMax != null) aa.value = String(params.aaMax);
    if (params.grad != null && listPresets().some((p) => p.id === params.grad)) {
      grad.value = params.grad;
    }
    if (params.secondary != null && secondary) {
      secondary.value = normalizeSecondary(params.secondary);
      this._syncSecondaryFields(params.secondary);
    } else if (params.secondary === undefined && secondary?.value) {
      this._syncSecondaryFields(secondary.value);
    }
    if (params.sfreq != null && this.els.sfreq) {
      this.els.sfreq.value = String(params.sfreq);
      if (this.els.sfreqValue) this.els.sfreqValue.textContent = String(params.sfreq);
    }
    if (params.swin != null && this.els.swin) {
      this.els.swin.value = String(params.swin);
      if (this.els.swinValue) this.els.swinValue.textContent = String(params.swin);
    }
    if (params.deGain != null && this.els.degain) {
      this.els.degain.value = String(params.deGain);
      if (this.els.degainValue) this.els.degainValue.textContent = String(params.deGain);
    }
  }

  updateReadout(view, qualityLabel, fps = null, renderTiming = null) {
    const { center, zoom, quality, fps: fpsEl, time: timeEl } = this.els;
    center.textContent = `${fmtFixed(view.centerX)} + ${fmtFixed(view.centerY)}i`;
    const z = zoomFactor(view);
    zoom.textContent = `${Number.isFinite(z) ? z.toExponential(3) : "—"}×`;
    quality.textContent = qualityLabel;
    if (fpsEl) {
      fpsEl.textContent = fps != null && Number.isFinite(fps) ? `${fps.toFixed(1)}` : "—";
    }
    if (timeEl) {
      if (renderTiming?.ms != null && Number.isFinite(renderTiming.ms)) {
        timeEl.textContent = fmtDuration(renderTiming.ms);
      } else {
        timeEl.textContent = "—";
      }
    }
  }
}

/** Format elapsed ms as a stopwatch readout. */
function fmtDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60_000);
  const s = (ms % 60_000) / 1000;
  return `${m}m ${s.toFixed(1)}s`;
}

function fmtFixed(v) {
  if (v && typeof v.toDecimalString === "function") {
    const s = v.toDecimalString(18);
    if (s.includes("e") || s.length > 24) return v.toExponential(6);
    return s;
  }
  const n = Number(v);
  const a = Math.abs(n);
  if (a !== 0 && (a >= 1e4 || a < 1e-3)) return n.toExponential(6);
  return n.toFixed(8);
}
