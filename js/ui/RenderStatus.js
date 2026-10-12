/**
 * Bottom status chip: progress bar + render stopwatch (freezes when complete).
 * Sized like BifurcationDiagram's "Accumulating frame…" label.
 */
export class RenderStatus {
  /**
   * @param {HTMLElement} root
   */
  constructor(root) {
    this.root = root;
    this.fillEl = root.querySelector(".render-status__fill");
    this.textEl = root.querySelector(".render-status__text");
  }

  /**
   * @param {{ fraction: number, complete: boolean, running: boolean, ms: number|null, label: string }} progress
   */
  update(progress) {
    if (!progress) return;
    const { fraction, complete, running, ms, label } = progress;
    const pct = Math.round((fraction ?? 0) * 100);
    if (this.fillEl) {
      this.fillEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    }
    const time =
      ms != null && Number.isFinite(ms) ? fmtDuration(ms) : "—";
    if (complete) {
      this.textEl.textContent = `Done · ${time}`;
      this.root.classList.add("is-complete");
      this.root.classList.remove("is-running");
    } else if (running) {
      this.textEl.textContent = `Rendering ${label} · ${time}`;
      this.root.classList.add("is-running");
      this.root.classList.remove("is-complete");
    } else {
      this.textEl.textContent = time === "—" ? "—" : `Done · ${time}`;
      this.root.classList.toggle("is-complete", time !== "—");
      this.root.classList.remove("is-running");
    }
    this.root.setAttribute("aria-valuenow", String(pct));
  }
}

function fmtDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60_000);
  const s = (ms % 60_000) / 1000;
  return `${m}m ${s.toFixed(1)}s`;
}
