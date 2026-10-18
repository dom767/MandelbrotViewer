import { createView, clampScale, formatCenter, urlCenterDigits } from "./view.js";
import { Fixed } from "./math/bigFixed.js";
import { getIterator, defaultIteratorId } from "./iterators/registry.js";
import {
  getPreset,
  docFromPreset,
  cloneDoc,
  encodeStops,
  decodeStops,
  BLEND_RGB,
  BLEND_HSL,
  WRAP_REPEAT,
  WRAP_CLAMP,
  WRAP_MIRROR,
} from "./color/gradient.js";
import {
  SECONDARY_ANGLE,
  SECONDARY_STRIPES,
  SECONDARY_DE,
  SECONDARY_CODE,
  normalizeSecondary,
} from "./color/secondary.js";

const URL_THROTTLE_MS = 200;
const WRAP_OK = new Set([WRAP_REPEAT, WRAP_CLAMP, WRAP_MIRROR]);
const BLEND_OK = new Set([BLEND_RGB, BLEND_HSL]);

export function loadStateFromUrl() {
  const q = new URLSearchParams(location.search);
  const view = createView({
    centerX: fixedParam(q.get("cx"), -0.75),
    centerY: fixedParam(q.get("cy"), 0),
    scale: clampScale(fixedParam(q.get("scale"), 3.5)),
  });

  const algoRaw = q.get("algo") || defaultIteratorId();
  const algo = getIterator(algoRaw) ? algoRaw : defaultIteratorId();

  const gradId = getPreset(q.get("grad") || "classic").id;
  let gradDoc = docFromPreset(gradId);

  const blend = q.get("blend");
  if (BLEND_OK.has(blend)) gradDoc.blend = blend;
  const wrapU = q.get("wrapU");
  if (WRAP_OK.has(wrapU)) gradDoc.wrapU = wrapU;
  const wrapV = q.get("wrapV");
  if (WRAP_OK.has(wrapV)) gradDoc.wrapV = wrapV;

  const ustops = q.get("ustops");
  const vstops = q.get("vstops");
  if (ustops || vstops) {
    gradDoc = cloneDoc(gradDoc);
    if (ustops) gradDoc.uStops = decodeStops(ustops, gradDoc.uStops);
    if (vstops) gradDoc.vStops = decodeStops(vstops, gradDoc.vStops);
    gradDoc.custom = true;
  }

  const offU = clamp(num(q.get("offU") ?? q.get("goff"), 0), 0, 1);
  const densU = migrateGdens(num(q.get("densU") ?? q.get("gdens"), 12));

  const secRaw = q.get("sec") ?? q.get("secondary");
  let secondary = SECONDARY_ANGLE;
  if (secRaw && SECONDARY_CODE[secRaw] != null) {
    secondary = normalizeSecondary(secRaw);
  } else if (
    !secRaw &&
    (gradId === "stripes" || gradId === "stripesMono")
  ) {
    // Legacy: stripe gradients implied stripe iterate mode.
    secondary = SECONDARY_STRIPES;
  }

  const params = {
    algo,
    maxIter: clampInt(num(q.get("iter"), 200), 50, 2000),
    aaMax: [1, 2, 4, 8, 16].includes(Number(q.get("aa"))) ? Number(q.get("aa")) : 4,
    grad: gradId,
    gradDoc,
    offU,
    offV: clamp(num(q.get("offV"), 0), 0, 1),
    densU,
    densV: clamp(num(q.get("densV"), 1), 0.25, 16),
    goff: offU,
    gdens: densU,
    secondary,
    sfreq: clampInt(num(q.get("sfreq"), 5), 1, 16),
    swin: clampInt(num(q.get("swin"), 32), 4, 64),
    deGain: clamp(num(q.get("degain") ?? q.get("deGain"), 2), 0.25, 16),
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
    const c = formatCenter(view, urlCenterDigits(view.scale));
    q.set("cx", c.x);
    q.set("cy", c.y);
    q.set("scale", view.scale.toExponential(12));
    q.set("iter", String(params.maxIter));
    q.set("algo", params.algo);
    q.set("aa", String(params.aaMax));
    q.set("grad", params.grad);
    q.set("offU", String(params.offU ?? params.goff ?? 0));
    q.set("offV", String(params.offV ?? 0));
    q.set("densU", String(params.densU ?? params.gdens ?? 12));
    q.set("densV", String(params.densV ?? 1));

    const secondary = normalizeSecondary(params.secondary);
    if (secondary !== SECONDARY_ANGLE) q.set("sec", secondary);

    const doc = params.gradDoc || docFromPreset(params.grad);
    if (doc.blend && doc.blend !== BLEND_RGB) q.set("blend", doc.blend);
    if (doc.wrapU && doc.wrapU !== WRAP_REPEAT) q.set("wrapU", doc.wrapU);
    if (doc.wrapV && doc.wrapV !== WRAP_REPEAT) q.set("wrapV", doc.wrapV);
    if (doc.custom) {
      q.set("ustops", encodeStops(doc.uStops));
      q.set("vstops", encodeStops(doc.vStops));
    }
    if (secondary === SECONDARY_STRIPES) {
      q.set("sfreq", String(params.sfreq));
      q.set("swin", String(params.swin));
    }
    if (secondary === SECONDARY_DE && params.deGain != null && params.deGain !== 2) {
      q.set("degain", String(params.deGain));
    }
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
  if (v > 0 && v < 1) return clamp(v * 100, 1, 48);
  return clamp(v, 1, 48);
}
