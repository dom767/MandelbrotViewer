import { initGpu } from "./gpu.js";
import { createView, screenToComplex } from "./view.js";
import { RenderScheduler } from "./render/scheduler.js";
import { attachPointerInput } from "./input/pointer.js";
import { Hud } from "./ui/Hud.js";
import { AppChrome } from "./ui/AppChrome.js";
import { RenderStatus } from "./ui/RenderStatus.js";
import { AaDebugPanel } from "./ui/AaDebugPanel.js";
import { OrbitPanel } from "./ui/OrbitPanel.js";
import { TileHighlights } from "./ui/TileHighlights.js";
import { AaGpuProbe } from "./debug/aaGpuProbe.js";
import { computeReferenceOrbit } from "./math/bigFixed.js";
import { loadStateFromUrl, createUrlSync } from "./urlState.js";
import "./iterators/registry.js";

const AA_DEBUG_THROTTLE_MS = 100;
const ORBIT_THROTTLE_MS = 80;
const TAP_SLOP_PX = 6;

async function boot() {
  const canvas = document.getElementById("fractal");
  const unsupported = document.getElementById("unsupported");
  const crosshair = document.getElementById("aa-crosshair");

  const gpu = await initGpu(canvas);
  if (!gpu) {
    unsupported.classList.remove("hidden");
    return;
  }

  const { device, context, format } = gpu;
  const loaded = loadStateFromUrl();
  const view = createView(loaded.view);
  const urlSync = createUrlSync();

  const scheduler = new RenderScheduler(device, context, format);
  scheduler.setParams(loaded.params);
  scheduler.setView(view);

  const aaProbe = new AaGpuProbe(device);
  const aaDebugPanel = new AaDebugPanel(document.getElementById("aa-debug"));
  aaDebugPanel.setEnabled(false);
  const orbitPanel = new OrbitPanel(document.getElementById("orbit-panel"));
  orbitPanel.setEnabled(false);
  const tileHighlights = new TileHighlights(document.getElementById("tile-highlights"));

  let aaDebugOn = false;
  let probe = null; // device pixels; null → canvas centre
  let aaDebugTimer = null;
  let aaDebugDirty = false;

  let orbitOn = false;
  let orbitHover = null; // device pixels of last hover
  let orbitTimer = null;
  let orbitDirty = false;

  const hud = new Hud(
    {
      algo: document.getElementById("algo"),
      iter: document.getElementById("iter"),
      iterValue: document.getElementById("iter-value"),
      aa: document.getElementById("aa"),
      grad: document.getElementById("grad"),
      goff: document.getElementById("goff"),
      gdens: document.getElementById("gdens"),
      gdensValue: document.getElementById("gdens-value"),
      aaDebug: document.getElementById("aa-debug-toggle"),
      center: document.getElementById("readout-center"),
      zoom: document.getElementById("readout-zoom"),
      quality: document.getElementById("readout-quality"),
      fps: document.getElementById("readout-fps"),
      time: document.getElementById("readout-time"),
    },
    {
      onParams(partial) {
        scheduler.setParams(partial);
        urlSync.write(view, scheduler.params);
        scheduleAaDebug();
        scheduleOrbit();
      },
      onAaDebug(enabled) {
        aaDebugOn = enabled;
        aaDebugPanel.setEnabled(enabled);
        crosshair.classList.toggle("hidden", !enabled);
        if (enabled) {
          if (!probe) {
            probe = {
              x: Math.floor(canvas.width / 2),
              y: Math.floor(canvas.height / 2),
            };
          }
          updateCrosshair();
          scheduleAaDebug(true);
        }
      },
    }
  );
  hud.setState(scheduler.params);
  hud.updateReadout(
    view,
    scheduler.getQualityLabel(),
    null,
    scheduler.getRenderTiming()
  );

  function setOrbitEnabled(enabled) {
    orbitOn = enabled;
    orbitPanel.setEnabled(enabled);
    if (enabled) {
      if (!orbitHover) {
        orbitHover = {
          x: Math.floor(canvas.width / 2),
          y: Math.floor(canvas.height / 2),
        };
      }
      scheduleOrbit(true);
    }
  }

  function resetCameraHome() {
    const home = createView();
    view.centerX = home.centerX;
    view.centerY = home.centerY;
    view.scale = home.scale;
    scheduler.setView(view);
    urlSync.write(view, scheduler.params);
    hud.updateReadout(
      view,
      scheduler.getQualityLabel(),
      null,
      scheduler.getRenderTiming()
    );
    scheduleAaDebug();
    scheduleOrbit();
  }

  const chrome = new AppChrome({
    nav: document.getElementById("app-nav"),
    hud: document.getElementById("hud"),
    scrim: document.getElementById("nav-scrim"),
    onHome: resetCameraHome,
    onOrbit: setOrbitEnabled,
    isOrbitOpen: () => orbitOn,
  });
  void chrome;

  const renderStatus = new RenderStatus(document.getElementById("render-status"));

  const frameTimes = [];
  const FPS_WINDOW = 30;
  let lastFrameMark = performance.now();

  function averageFps() {
    if (frameTimes.length < 2) return null;
    let sum = 0;
    for (const dt of frameTimes) sum += dt;
    const avgMs = sum / frameTimes.length;
    return avgMs > 0 ? 1000 / avgMs : null;
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const pw = Math.max(1, Math.floor(rect.width * dpr));
    const ph = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
      scheduler.setCanvasSize(pw, ph);
      if (probe) {
        probe.x = Math.min(pw - 1, probe.x);
        probe.y = Math.min(ph - 1, probe.y);
      }
      if (orbitHover) {
        orbitHover.x = Math.min(pw - 1, orbitHover.x);
        orbitHover.y = Math.min(ph - 1, orbitHover.y);
      }
      updateCrosshair();
      scheduleAaDebug();
      scheduleOrbit();
    }
  }

  function updateCrosshair() {
    if (!aaDebugOn || !probe) {
      crosshair.classList.add("hidden");
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width / Math.max(canvas.width, 1);
    const sy = rect.height / Math.max(canvas.height, 1);
    const app = document.getElementById("app").getBoundingClientRect();
    crosshair.classList.remove("hidden");
    crosshair.style.left = `${rect.left - app.left + (probe.x + 0.5) * sx}px`;
    crosshair.style.top = `${rect.top - app.top + (probe.y + 0.5) * sy}px`;
  }

  function scheduleAaDebug(immediate = false) {
    if (!aaDebugOn) return;
    aaDebugDirty = true;
    if (aaDebugTimer != null) {
      if (!immediate) return;
      clearTimeout(aaDebugTimer);
      aaDebugTimer = null;
    }
    const delay = immediate ? 0 : AA_DEBUG_THROTTLE_MS;
    aaDebugTimer = setTimeout(() => {
      aaDebugTimer = null;
      void runAaDebug();
    }, delay);
  }

  async function runAaDebug() {
    if (!aaDebugOn || !aaDebugDirty) return;
    aaDebugDirty = false;
    resize();
    if (!probe) {
      probe = {
        x: Math.floor(canvas.width / 2),
        y: Math.floor(canvas.height / 2),
      };
    }
    try {
      const result = await aaProbe.capture({
        view,
        width: canvas.width,
        height: canvas.height,
        probeX: probe.x,
        probeY: probe.y,
        maxIter: scheduler.params.maxIter,
      });
      if (!result || !aaDebugOn) return;
      aaDebugPanel.render({
        samples: result.samples,
        blends: result.blends,
        probe: result.probe,
        params: scheduler.params,
      });
      updateCrosshair();
    } catch (err) {
      console.error("AA debug probe failed:", err);
    }
  }

  function scheduleOrbit(immediate = false) {
    if (!orbitOn) return;
    orbitDirty = true;
    if (orbitTimer != null) {
      if (!immediate) return;
      clearTimeout(orbitTimer);
      orbitTimer = null;
    }
    const delay = immediate ? 0 : ORBIT_THROTTLE_MS;
    orbitTimer = setTimeout(() => {
      orbitTimer = null;
      runOrbit();
    }, delay);
  }

  function runOrbit() {
    if (!orbitOn || !orbitDirty) return;
    orbitDirty = false;
    resize();
    if (!orbitHover) {
      orbitHover = {
        x: Math.floor(canvas.width / 2),
        y: Math.floor(canvas.height / 2),
      };
    }
    const c = screenToComplex(
      view,
      orbitHover.x,
      orbitHover.y,
      canvas.width,
      canvas.height
    );
    const maxIter = scheduler.params.maxIter;
    const { zs, len } = computeReferenceOrbit(c.x, c.y, maxIter);
    orbitPanel.render({
      cxStr: fmtOrbitCoord(c.x),
      cyStr: fmtOrbitCoord(c.y),
      zs,
      len,
      params: scheduler.params,
    });
  }

  window.addEventListener("resize", () => {
    resize();
    updateCrosshair();
  });
  resize();

  attachPointerInput(canvas, view, {
    onViewChange() {
      scheduler.updateView(view);
      urlSync.write(view, scheduler.params);
      hud.updateReadout(
        view,
        scheduler.getQualityLabel(),
        null,
        scheduler.getRenderTiming()
      );
      scheduleAaDebug();
      scheduleOrbit();
    },
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!orbitOn) return;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / Math.max(rect.width, 1);
    const sy = canvas.height / Math.max(rect.height, 1);
    orbitHover = {
      x: Math.min(
        canvas.width - 1,
        Math.max(0, Math.floor((e.clientX - rect.left) * sx))
      ),
      y: Math.min(
        canvas.height - 1,
        Math.max(0, Math.floor((e.clientY - rect.top) * sy))
      ),
    };
    scheduleOrbit();
  });

  // Tap (no drag) sets AA probe when debug is on
  let tapStart = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (!aaDebugOn) return;
    tapStart = { x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!aaDebugOn || !tapStart || e.pointerId !== tapStart.id) return;
    const dx = e.clientX - tapStart.x;
    const dy = e.clientY - tapStart.y;
    tapStart = null;
    if (dx * dx + dy * dy > TAP_SLOP_PX * TAP_SLOP_PX) return;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / Math.max(rect.width, 1);
    const sy = canvas.height / Math.max(rect.height, 1);
    probe = {
      x: Math.min(
        canvas.width - 1,
        Math.max(0, Math.floor((e.clientX - rect.left) * sx))
      ),
      y: Math.min(
        canvas.height - 1,
        Math.max(0, Math.floor((e.clientY - rect.top) * sy))
      ),
    };
    updateCrosshair();
    scheduleAaDebug(true);
  });
  canvas.addEventListener("pointercancel", () => {
    tapStart = null;
  });

  let running = true;

  async function frame() {
    if (!running) return;
    const now = performance.now();
    frameTimes.push(now - lastFrameMark);
    lastFrameMark = now;
    if (frameTimes.length > FPS_WINDOW) frameTimes.shift();

    resize();
    try {
      await scheduler.tick();
    } catch (err) {
      console.error(err);
    }
    tileHighlights.draw(
      scheduler.getHighlightTiles(),
      canvas.width,
      canvas.height
    );
    const progress = scheduler.getRenderProgress();
    hud.updateReadout(
      view,
      scheduler.getQualityLabel(),
      averageFps(),
      progress
    );
    renderStatus.update(progress);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  window.addEventListener("pagehide", () => {
    running = false;
    urlSync.flush();
  });
}

function fmtOrbitCoord(v) {
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

boot();
