import { listIterators } from "../iterators/registry.js";
import { listPresets } from "../color/gradient.js";
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
    const { algo, grad } = this.els;
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
  }

  _bind() {
    const { algo, iter, aa, grad, goff, gdens, aaDebug, orbit } = this.els;
    const h = this.handlers;

    algo.addEventListener("change", () => h.onParams({ algo: algo.value }));
    iter.addEventListener("input", () => {
      const maxIter = Number(iter.value);
      this.els.iterValue.textContent = String(maxIter);
      h.onParams({ maxIter });
    });
    aa.addEventListener("change", () => h.onParams({ aaMax: Number(aa.value) }));
    grad.addEventListener("change", () => h.onParams({ grad: grad.value }));
    goff.addEventListener("input", () => h.onParams({ goff: Number(goff.value) }));
    gdens.addEventListener("input", () => {
      const gdensVal = Number(gdens.value);
      if (this.els.gdensValue) this.els.gdensValue.textContent = fmtCycles(gdensVal);
      h.onParams({ gdens: gdensVal });
    });
    if (aaDebug) {
      aaDebug.addEventListener("change", () => {
        h.onAaDebug?.(aaDebug.checked);
      });
    }
    if (orbit) {
      orbit.addEventListener("change", () => {
        h.onOrbit?.(orbit.checked);
      });
    }
  }

  setState(params) {
    const { algo, iter, aa, grad, goff, gdens, iterValue } = this.els;
    if (params.algo != null) algo.value = params.algo;
    if (params.maxIter != null) {
      iter.value = String(params.maxIter);
      iterValue.textContent = String(params.maxIter);
    }
    if (params.aaMax != null) aa.value = String(params.aaMax);
    if (params.grad != null) grad.value = params.grad;
    if (params.goff != null) goff.value = String(params.goff);
    if (params.gdens != null) {
      gdens.value = String(params.gdens);
      if (this.els.gdensValue) this.els.gdensValue.textContent = fmtCycles(params.gdens);
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

function fmtCycles(n) {
  return Number.isFinite(n) ? String(n) : "—";
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
    // Prefer compact scientific when the decimal form is long / tiny / huge.
    if (s.includes("e") || s.length > 24) return v.toExponential(6);
    return s;
  }
  const n = Number(v);
  const a = Math.abs(n);
  if (a !== 0 && (a >= 1e4 || a < 1e-3)) return n.toExponential(6);
  return n.toFixed(8);
}
