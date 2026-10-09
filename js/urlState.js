import { createView, clampScale, formatCenter } from "./view.js";
import { Fixed } from "./math/bigFixed.js";
import { getIterator, defaultIteratorId } from "./iterators/registry.js";
import { getPreset } from "./color/gradient.js";

const URL_THROTTLE_MS = 200;

export function loadStateFromUrl() {
  const q = new URLSearchParams(location.search);
  const view = createView({
    centerX: fixedParam(q.get("cx"), -0.75),
    centerY: fixedParam(q.get("cy"), 0),
    scale: clampScale(fixedParam(q.get("scale"), 3.5)),
  });

  const algoRaw = q.get("algo") || defaultIteratorId();
  const algo = getIterator(algoRaw) ? algoRaw : defaultIteratorId();

  const params = {
    algo,
    maxIter: clampInt(num(q.get("iter"), 200), 50, 2000),
    aaMax: [1, 2, 4, 8, 16].includes(Number(q.get("aa"))) ? Number(q.get("aa")) : 4,
    grad: getPreset(q.get("grad") || "classic").id,
    goff: clamp(num(q.get("goff"), 0), 0, 1),
    gdens: migrateGdens(num(q.get("gdens"), 12)),
  };

  return { view, params };
}

export function createUrlSync() {
  let timer = null;
  let pending = null;

  function write(view, params) {
    pending = { view, params };
    if (timer != null) return;
    timer = setTimeout(flush, URL_THROTTLE_MS);
  }

  function flush() {
    timer = null;
    if (!pending) return;
    const { view, params } = pending;
    pending = null;
    const q = new URLSearchParams();
    const c = formatCenter(view, 48);
    q.set("cx", c.x);
    q.set("cy", c.y);
    q.set("scale", view.scale.toExponential(12));
    q.set("iter", String(params.maxIter));
    q.set("algo", params.algo);
    q.set("aa", String(params.aaMax));
    q.set("grad", params.grad);
    q.set("goff", String(params.goff));
    q.set("gdens", String(params.gdens));
    const url = `${location.pathname}?${q.toString()}${location.hash}`;
    history.replaceState(null, "", url);
  }

  return { write, flush };
}

function fixedParam(v, fallback) {
  if (v == null || v === "") return Fixed.fromNumber(fallback);
  return Fixed.fromString(v, fallback);
}

function num(v, fallback) {
  // Number(null) === 0, so missing params must be checked before coercing.
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function clampInt(n, lo, hi) {
  return Math.round(clamp(n, lo, hi));
}

/** Density is now "palette cycles over maxIter". Old URLs used 0.002–0.2. */
function migrateGdens(v) {
  if (!Number.isFinite(v)) return 12;
  if (v > 0 && v < 1) return clamp(v * 100, 1, 48); // 0.12 → 12
  return clamp(v, 1, 48);
}
