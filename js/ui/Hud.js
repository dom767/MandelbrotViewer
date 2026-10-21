import { listIterators } from "../iterators/registry.js";
import { listPresets } from "../color/gradient.js";
import {
  SECONDARY_OPTIONS,
  SECONDARY_STRIPES,
  SECONDARY_DE,
  SECONDARY_TRAP,
  TRAP_SHAPE_OPTIONS,
  normalizeSecondary,
  normalizeTrapShape,
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
    const { algo, grad, secondary, trapShape } = this.els;
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
    if (trapShape) {
      trapShape.replaceChildren();
      for (const o of TRAP_SHAPE_OPTIONS) {
        const opt = document.createElement("option");
        opt.value = o.id;
        opt.textContent = o.label;
        trapShape.appendChild(opt);
      }
    }
  }

  _bind() {
    const { algo, iter, aa, grad, colourEdit, secondary, trapShape } = this.els;
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
    trapShape?.addEventListener("change", () => {
      h.onParams({ trapShape: trapShape.value });
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
    const trap = s === SECONDARY_TRAP;
    if (this.els.sfreqField) this.els.sfreqField.hidden = !stripes;
    if (this.els.swinField) this.els.swinField.hidden = !stripes;
    if (this.els.degainField) this.els.degainField.hidden = !de;
    if (this.els.trapShapeField) this.els.trapShapeField.hidden = !trap;
    if (this.els.vOptions) this.els.vOptions.hidden = !(stripes || de || trap);
  }

  setState(params) {
    const { algo, iter, aa, grad, iterValue, secondary, trapShape } = this.els;
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
    if (params.trapShape != null && trapShape) {
      trapShape.value = normalizeTrapShape(params.trapShape);
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

  updateReadout(view, _qualityLabel, fps = null, renderTiming = null) {
    const { zoom, fps: fpsEl, time: timeEl } = this.els;
    const z = zoomFactor(view);
    if (zoom) {
      zoom.textContent = `${Number.isFinite(z) ? z.toExponential(3) : "—"}×`;
    }
    if (fpsEl) {
      fpsEl.textContent =
        fps != null && Number.isFinite(fps) ? `${fps.toFixed(1)}` : "—";
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
