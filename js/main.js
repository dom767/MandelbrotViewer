import { initGpu } from "./gpu.js";
import { createView, screenToComplex, clampScale } from "./view.js";
import { RenderScheduler } from "./render/scheduler.js";
import { attachPointerInput } from "./input/pointer.js";
import { Hud } from "./ui/Hud.js";
import { AppChrome } from "./ui/AppChrome.js";
import { RenderStatus } from "./ui/RenderStatus.js";
import { OrbitPanel } from "./ui/OrbitPanel.js";
import { CloudPanel } from "./ui/CloudPanel.js";
import { TileHighlights } from "./ui/TileHighlights.js";
import { ScreenshotUI } from "./ui/ScreenshotUI.js";
import { ShotsPanel } from "./ui/ShotsPanel.js";
import { Fixed, computeReferenceOrbit } from "./math/bigFixed.js";
import { loadStateFromUrl, createUrlSync } from "./urlState.js";
import { getShotsConfig } from "./shotsConfig.js";
import "./iterators/registry.js";

const ORBIT_THROTTLE_MS = 80;
const CLOUD_THROTTLE_MS = 120;

async function boot() {
  const canvas = document.getElementById("fractal");
  const unsupported = document.getElementById("unsupported");

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

  const orbitPanel = new OrbitPanel(document.getElementById("orbit-panel"));
  orbitPanel.setEnabled(false);
  const cloudPanel = new CloudPanel(document.getElementById("cloud-panel"), {
    device,
    format,
  });
  cloudPanel.setEnabled(false);
  cloudPanel.onGridChange(() => scheduleCloud(true));
  const tileHighlights = new TileHighlights(document.getElementById("tile-highlights"));
  const shotsConfig = getShotsConfig();

  let shotsOn = false;
  const shotsPanel = new ShotsPanel(document.getElementById("shots-panel"), {
    shotsConfig,
    onSelect(shot) {
      flyToShot(shot);
    },
    onTakeScreenshot() {
      screenshotUI.open();
    },
  });
  shotsPanel.setEnabled(false);

  const screenshotUI = new ScreenshotUI({
    getCanvas: () => canvas,
    getView: () => view,
    getParams: () => scheduler.params,
    shotsConfig,
    onShared() {
      if (shotsOn) void shotsPanel.refresh();
    },
  });

  let orbitOn = false;
  let orbitHover = null; // device pixels of last hover
  let orbitTimer = null;
  let orbitDirty = false;

  let cloudOn = false;
  let cloudTimer = null;
  let cloudDirty = false;

  function flyToShot(shot) {
    const meta = shot?.meta;
    if (meta?.cx != null && meta?.cy != null && meta?.scale != null) {
      view.centerX = Fixed.fromString(String(meta.cx), -0.75);
      view.centerY = Fixed.fromString(String(meta.cy), 0);
      view.scale = clampScale(Fixed.fromString(String(meta.scale), 3.5));
      const partial = {};
      if (meta.maxIter != null) partial.maxIter = meta.maxIter;
      if (meta.algo) partial.algo = meta.algo;
      if (meta.aa != null) partial.aaMax = meta.aa;
      if (meta.grad) partial.grad = meta.grad;
      if (meta.goff != null) partial.goff = meta.goff;
      if (meta.gdens != null) partial.gdens = meta.gdens;
      if (Object.keys(partial).length) {
        scheduler.setParams(partial);
        hud.setState(scheduler.params);
      }
      scheduler.setView(view);
      urlSync.write(view, scheduler.params);
      hud.updateReadout(
        view,
        scheduler.getQualityLabel(),
        null,
        scheduler.getRenderTiming()
      );
      scheduleOrbit();
      scheduleCloud();
      return;
    }
    if (shot?.pageUrl) {
      try {
        const u = new URL(shot.pageUrl, location.href);
        if (u.origin === location.origin) {
          location.href = u.href;
          return;
        }
      } catch {
        /* ignore */
      }
      window.open(shot.pageUrl, "_blank", "noopener");
    }
  }

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
        scheduleOrbit();
        scheduleCloud();
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

  function setCloudEnabled(enabled) {
    cloudOn = enabled;
    cloudPanel.setEnabled(enabled);
    if (enabled) scheduleCloud(true);
  }

  function setShotsEnabled(enabled) {
    shotsOn = enabled;
    shotsPanel.setEnabled(enabled);
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
    scheduleOrbit();
    scheduleCloud();
  }

  const chrome = new AppChrome({
    nav: document.getElementById("app-nav"),
    hud: document.getElementById("hud"),
    scrim: document.getElementById("nav-scrim"),
    onHome: resetCameraHome,
    onOrbit: setOrbitEnabled,
    isOrbitOpen: () => orbitOn,
    onCloud: setCloudEnabled,
    isCloudOpen: () => cloudOn,
    onShots: setShotsEnabled,
    isShotsOpen: () => shotsOn,
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
      if (orbitHover) {
        orbitHover.x = Math.min(pw - 1, orbitHover.x);
        orbitHover.y = Math.min(ph - 1, orbitHover.y);
      }
      scheduleOrbit();
      scheduleCloud();
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

  function scheduleCloud(immediate = false) {
    if (!cloudOn) return;
    cloudDirty = true;
    if (cloudTimer != null) {
      if (!immediate) return;
      clearTimeout(cloudTimer);
      cloudTimer = null;
    }
    const delay = immediate ? 0 : CLOUD_THROTTLE_MS;
    cloudTimer = setTimeout(() => {
      cloudTimer = null;
      runCloud();
    }, delay);
  }

  function runCloud() {
    if (!cloudOn || !cloudDirty) return;
    cloudDirty = false;
    resize();
    cloudPanel.beginRebuild({
      view,
      canvasW: canvas.width,
      canvasH: canvas.height,
      params: scheduler.params,
    });
  }

  window.addEventListener("resize", () => {
    resize();
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
      scheduleOrbit();
      scheduleCloud();
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
