import { createBuffer, writeBuffer } from "../gpu.js";
import { aspectOf, cloneView } from "../view.js";
import { getIterator } from "../iterators/registry.js";
import { IteratePass } from "./iterate.js";
import { ColourPass } from "./color.js";

const TILE = 64;
/** Target frame time for tile work (~30 Hz). */
const FRAME_BUDGET_MS = 1000 / 30;
/** Leave headroom inside the budget for colour + blit. */
const PRESENT_RESERVE_MS = 4;
const IDLE_MS = 120;

/**
 * Progressive quality ladder + tiled iteration.
 * Qualities: 1/32 → … → 1/2 → full → 2×2 → … → up to aaMax×aaMax.
 * Initial preview is 1/16 of the old 0.5× start (i.e. 1/32 of full res).
 */

const AA_STEPS = [2, 4, 8, 16];

function buildLadder(aaMax) {
  const previewScales = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2];
  const steps = previewScales.map((resScale) => ({
    resScale,
    aa: 1,
    label: formatResLabel(resScale),
  }));
  steps.push({ resScale: 1, aa: 1, label: "1×" });
  for (const aa of AA_STEPS) {
    if (aa > aaMax) break;
    steps.push({ resScale: 1, aa, label: `${aa}×${aa}` });
  }
  return steps;
}

function formatResLabel(resScale) {
  const denom = Math.round(1 / resScale);
  return denom > 1 ? `1/${denom}` : "1×";
}

/** Highest ladder index allowed while the pointer is active (full res, no AA). */
function interactCapIndex(ladder) {
  const idx = ladder.findIndex((s) => s.resScale >= 1 && s.aa === 1);
  return idx >= 0 ? idx : Math.min(1, ladder.length - 1);
}

function makeTiles(width, height, tileSize) {
  const tiles = [];
  for (let y = 0; y < height; y += tileSize) {
    for (let x = 0; x < width; x += tileSize) {
      tiles.push({
        x,
        y,
        w: Math.min(tileSize, width - x),
        h: Math.min(tileSize, height - y),
      });
    }
  }
  return tiles;
}

export class RenderScheduler {
  constructor(device, context, canvasFormat) {
    this.device = device;
    this.context = context;
    this.iterate = new IteratePass(device);
    this.colour = new ColourPass(device, canvasFormat);

    this.canvasWidth = 0;
    this.canvasHeight = 0;

    this.view = null;
    this.params = {
      algo: "fp32",
      maxIter: 200,
      aaMax: 4,
      grad: "classic",
      goff: 0,
      /** Palette cycles across [0, maxIter] (not per-iteration). */
      gdens: 12,
    };

    this.generation = 0;
    this.ladder = [];
    this.qualityIndex = 0;
    this.tiles = [];
    this.tileIndex = 0;
    this.escapeBuffer = null;
    /** CPU-side escape image for runOnCpu iterators (uploaded per tile). */
    this.cpuEscape = null;
    this.bufWidth = 0;
    this.bufHeight = 0;
    this.interacting = false;
    this.idleTimer = null;
    this.needsIterate = true;
    this.needsColour = true;
    this.qualityLabel = "—";
    this._queueReady = Promise.resolve();
    this._waitGen = -1;
    /** @type {{ x: number, y: number, w: number, h: number, t: number }[]} canvas-space tile flashes */
    this.highlightTiles = [];
    /** EMA of GPU+queue ms per tile; null until first measured batch. */
    this._msPerTile = null;
    this._timingAa = 1;
    this._timingResScale = 1;
    /** Stopwatch: wall time from invalidate until full ladder completes. */
    this._renderStartedAt = null;
    this._renderElapsedMs = null;
  }

  setCanvasSize(width, height) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.canvasWidth && h === this.canvasHeight) return;
    this.canvasWidth = w;
    this.canvasHeight = h;
    this.invalidateIterate();
  }

  setView(view) {
    this.view = cloneView(view);
    this.invalidateIterate();
  }

  updateView(view) {
    this.view = cloneView(view);
    this.markInteracting();
    this.invalidateIterate();
  }

  setParams(partial) {
    const prev = { ...this.params };
    Object.assign(this.params, partial);

    const colourOnly =
      (partial.grad !== undefined ||
        partial.goff !== undefined ||
        partial.gdens !== undefined) &&
      partial.algo === undefined &&
      partial.maxIter === undefined &&
      partial.aaMax === undefined;

    if (partial.grad !== undefined) {
      this.colour.setGradient(this.params.grad);
    }

    if (colourOnly) {
      this.needsColour = true;
      return;
    }

    if (
      prev.algo !== this.params.algo ||
      prev.maxIter !== this.params.maxIter ||
      prev.aaMax !== this.params.aaMax
    ) {
      this.invalidateIterate();
    } else {
      this.needsColour = true;
    }
  }

  markInteracting() {
    this.interacting = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.interacting = false;
      if (!this.needsIterate && this.qualityIndex < this.ladder.length - 1) {
        this._startQuality(this.qualityIndex + 1);
        this.needsIterate = true;
      }
    }, IDLE_MS);
  }

  invalidateIterate() {
    this.generation += 1;
    this.needsIterate = true;
    this.needsColour = true;
    this.qualityIndex = 0;
    this.tileIndex = 0;
    this.tiles = [];
    this.highlightTiles = [];
    this._msPerTile = null;
    this._timingAa = 1;
    this._timingResScale = 1;
    this._queueReady = this.device.queue.onSubmittedWorkDone();
    this._renderStartedAt = performance.now();
    this._renderElapsedMs = null;
  }

  /**
   * Render stopwatch: running until the full quality ladder (incl. AA) finishes,
   * then frozen. Restarts on the next invalidate.
   * @returns {{ running: boolean, ms: number|null }}
   */
  getRenderTiming() {
    if (this._renderStartedAt == null) {
      return { running: false, ms: null };
    }
    const ladderDone =
      this.ladder.length > 0 && this.qualityIndex >= this.ladder.length - 1;
    const complete = !this.needsIterate && ladderDone;
    if (complete) {
      if (this._renderElapsedMs == null) {
        this._renderElapsedMs = performance.now() - this._renderStartedAt;
      }
      return { running: false, ms: this._renderElapsedMs };
    }
    this._renderElapsedMs = null;
    return { running: true, ms: performance.now() - this._renderStartedAt };
  }

  /**
   * Progressive completion by pixels rendered vs total pixels across the ladder
   * (each quality step contributes its buffer width×height; edge tiles use actual size).
   * @returns {{ fraction: number, complete: boolean, running: boolean, ms: number|null, label: string }}
   */
  getRenderProgress() {
    const timing = this.getRenderTiming();
    if (!timing.running && timing.ms != null) {
      return {
        fraction: 1,
        complete: true,
        running: false,
        ms: timing.ms,
        label: this.qualityLabel || "—",
      };
    }

    const cw = Math.max(this.canvasWidth, 1);
    const ch = Math.max(this.canvasHeight, 1);
    const ladder =
      this.ladder.length > 0 ? this.ladder : buildLadder(this.params.aaMax);

    let total = 0;
    for (const step of ladder) {
      const w = Math.max(1, Math.floor(cw * step.resScale));
      const h = Math.max(1, Math.floor(ch * step.resScale));
      total += w * h;
    }

    let done = 0;
    const qi = Math.min(this.qualityIndex, ladder.length);
    for (let i = 0; i < qi; i++) {
      const step = ladder[i];
      const w = Math.max(1, Math.floor(cw * step.resScale));
      const h = Math.max(1, Math.floor(ch * step.resScale));
      done += w * h;
    }

    if (this.tiles.length > 0 && qi < ladder.length) {
      for (let t = 0; t < this.tileIndex && t < this.tiles.length; t++) {
        const tile = this.tiles[t];
        done += tile.w * tile.h;
      }
    } else if (!this.needsIterate && ladder.length > 0) {
      done = total;
    }

    const fraction = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
    return {
      fraction,
      complete: false,
      running: !!timing.running,
      ms: timing.ms,
      label: this.qualityLabel || "—",
    };
  }

  _ensureEscape(width, height) {
    if (this.escapeBuffer && this.bufWidth === width && this.bufHeight === height) {
      return this.escapeBuffer;
    }
    if (this.escapeBuffer) {
      this.escapeBuffer.destroy();
    }
    this.escapeBuffer = createBuffer(
      this.device,
      width * height * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      "escape"
    );
    this.cpuEscape = new Float32Array(width * height);
    this.bufWidth = width;
    this.bufHeight = height;
    return this.escapeBuffer;
  }

  /** Upload one tile of cpuEscape into the GPU escape buffer (row by row). */
  _uploadCpuTile(tile) {
    const width = this.bufWidth;
    const row = new Float32Array(tile.w);
    for (let y = 0; y < tile.h; y++) {
      const src = (tile.y + y) * width + tile.x;
      row.set(this.cpuEscape.subarray(src, src + tile.w));
      writeBuffer(this.device, this.escapeBuffer, row, src * 4);
    }
  }

  _startQuality(index) {
    this.qualityIndex = index;
    this.tileIndex = 0;
    const step = this.ladder[index];
    const width = Math.max(1, Math.floor(this.canvasWidth * step.resScale));
    const height = Math.max(1, Math.floor(this.canvasHeight * step.resScale));
    this._ensureEscape(width, height);
    this.tiles = makeTiles(width, height, TILE);
    this.qualityLabel = step.label;

    // Scale prior tile-cost estimate for the new step.
    // AA work is O(aa²), so 2× → 4× → 8× → 16× each multiplies cost by ~4.
    // Resolution area scales as resScale².
    if (this._msPerTile != null) {
      const aaRatio = Math.max(step.aa, 1) / Math.max(this._timingAa, 1);
      const resRatio = step.resScale / Math.max(this._timingResScale, 1e-6);
      this._msPerTile *= aaRatio * aaRatio * resRatio * resRatio;
    }
    this._timingAa = step.aa;
    this._timingResScale = step.resScale;
  }

  async tick() {
    if (!this.view || this.canvasWidth < 1) return;

    if (this._waitGen !== this.generation) {
      await this._queueReady;
      this._waitGen = this.generation;
    }

    this.colour.setGradient(this.params.grad);

    if (this.needsIterate && this.tiles.length === 0) {
      this.ladder = buildLadder(this.params.aaMax);
      this._startQuality(0);
    }

    const iterator = getIterator(this.params.algo);
    if (!iterator) return;

    let qualityComplete = false;
    let tilesThisFrame = 0;
    let step = null;

    if (this.needsIterate && this.tiles.length > 0) {
      step = this.ladder[this.qualityIndex];
      const width = this.bufWidth;
      const height = this.bufHeight;
      const aspect = aspectOf(this.canvasWidth, this.canvasHeight);
      const iterateBudgetMs = FRAME_BUDGET_MS - PRESENT_RESERVE_MS;
      const now = performance.now();
      const sx = this.canvasWidth / Math.max(width, 1);
      const sy = this.canvasHeight / Math.max(height, 1);
      const batchStart = performance.now();

      if (iterator.runOnCpu) {
        // CPU path: wall-clock fills the budget (work is synchronous).
        while (
          this.tileIndex < this.tiles.length &&
          (tilesThisFrame === 0 ||
            performance.now() - batchStart < iterateBudgetMs)
        ) {
          const tile = this.tiles[this.tileIndex++];
          iterator.fillTile({
            escape: this.cpuEscape,
            width,
            height,
            view: this.view,
            aspect,
            tile,
            maxIter: this.params.maxIter,
            aa: step.aa,
          });
          this._uploadCpuTile(tile);
          if (step.aa > 1) {
            this.highlightTiles.push({
              x: tile.x * sx,
              y: tile.y * sy,
              w: tile.w * sx,
              h: tile.h * sy,
              t: now,
            });
          }
          tilesThisFrame += 1;
        }
      } else {
        // CPU reference orbit once per view/iter (perturbation); no-op otherwise.
        this.iterate.prepareReference(iterator, this.view, this.params.maxIter);

        // GPU: batch size from predicted cost (submit() returns immediately).
        let tileBudget = 1;
        if (this._msPerTile != null && this._msPerTile > 0) {
          tileBudget = Math.max(1, Math.floor(iterateBudgetMs / this._msPerTile));
        }

        while (
          tilesThisFrame < tileBudget &&
          this.tileIndex < this.tiles.length
        ) {
          const tile = this.tiles[this.tileIndex++];
          const enc = this.device.createCommandEncoder({ label: "iterate-tile" });
          const pass = enc.beginComputePass();
          this.iterate.encodeTile(pass, {
            iterator,
            escapeBuffer: this.escapeBuffer,
            view: this.view,
            resolution: { width, height },
            aspect,
            tile,
            maxIter: this.params.maxIter,
            aa: step.aa,
          });
          pass.end();
          this.device.queue.submit([enc.finish()]);

          if (step.aa > 1) {
            this.highlightTiles.push({
              x: tile.x * sx,
              y: tile.y * sy,
              w: tile.w * sx,
              h: tile.h * sy,
              t: now,
            });
          }
          tilesThisFrame += 1;
        }

        await this.device.queue.onSubmittedWorkDone();
      }

      if (tilesThisFrame > 0) {
        const sample = (performance.now() - batchStart) / tilesThisFrame;
        this._msPerTile =
          this._msPerTile == null ? sample : this._msPerTile * 0.7 + sample * 0.3;
        this._timingAa = step.aa;
        this._timingResScale = step.resScale;
      }

      if (this.tileIndex >= this.tiles.length) {
        qualityComplete = true;
      }
    }

    // Drop expired flashes
    const fadeMs = 140;
    const now = performance.now();
    this.highlightTiles = this.highlightTiles.filter((h) => now - h.t < fadeMs);

    const encoder = this.device.createCommandEncoder({ label: "present" });

    // During AA levels, recolour after each tile batch so updates are visible
    const progressiveAaColour = tilesThisFrame > 0 && step && step.aa > 1;
    if (
      qualityComplete ||
      progressiveAaColour ||
      (this.needsColour && this.escapeBuffer)
    ) {
      this.colour.encodeColour(encoder, {
        escapeBuffer: this.escapeBuffer,
        width: this.bufWidth,
        height: this.bufHeight,
        // Wrap `gdens` times from smooth-iter 0 → maxIter (stable vs iter count).
        density: this.params.gdens / Math.max(this.params.maxIter, 1),
        offset: this.params.goff,
      });
      this.needsColour = false;
    }

    this.colour.encodeBlit(encoder, this.context);
    this.device.queue.submit([encoder.finish()]);

    if (qualityComplete) {
      const maxIndex = this.interacting
        ? interactCapIndex(this.ladder)
        : this.ladder.length - 1;

      if (this.qualityIndex < maxIndex) {
        this._startQuality(this.qualityIndex + 1);
        this.needsIterate = true;
      } else {
        this.needsIterate = false;
      }
    }
  }

  getQualityLabel() {
    return this.qualityLabel;
  }

  /** Active tile flash rects in canvas backing-store pixels (for overlay). */
  getHighlightTiles() {
    return this.highlightTiles;
  }
}
