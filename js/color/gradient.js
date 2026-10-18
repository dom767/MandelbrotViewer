/** Gradient presets, GradientDocument, and LUT baking for Mandelbrot colouring. */

/** Iter axis (u). Kept as LUT_SIZE for Orbit/Cloud 1D helpers. */
export const LUT_SIZE = 512;
export const LUT_WIDTH = LUT_SIZE;
/** Angle / stripe axis (v). */
export const LUT_HEIGHT = 64;

/** Iterate-pass colour modes (what the escape buffer's y channel holds). */
export const COLOUR_MODE_ANGLE = 0;
export const COLOUR_MODE_STRIPE = 1;

export const WRAP_REPEAT = "repeat";
export const WRAP_CLAMP = "clamp";
export const WRAP_MIRROR = "mirror";

export const WRAP_MODE = {
  [WRAP_REPEAT]: 0,
  [WRAP_CLAMP]: 1,
  [WRAP_MIRROR]: 2,
};

export const BLEND_RGB = "rgb";
export const BLEND_HSL = "hsl";

const WHITE_STOPS = [
  [0, [1, 1, 1]],
  [1, [1, 1, 1]],
];

/** Stripe V shading approximating former contrast-stretch × shade curve. */
const STRIPE_V_STOPS = [
  [0, [0.15, 0.15, 0.15]],
  [0.2, [0.28, 0.28, 0.28]],
  [0.5, [0.675, 0.675, 0.675]],
  [0.8, [1, 1, 1]],
  [1, [1, 1, 1]],
];

/** Hue wheel for angleHue V axis (full sat/value). */
const HUE_V_STOPS = [
  [0, [1, 0, 0]],
  [1 / 6, [1, 1, 0]],
  [2 / 6, [0, 1, 0]],
  [3 / 6, [0, 1, 1]],
  [4 / 6, [0, 0, 1]],
  [5 / 6, [1, 0, 1]],
  [1, [1, 0, 0]],
];

/** Value/sat stand-in for angleHue U (grayscale ramp). */
const ANGLE_U_STOPS = [
  [0, [0.12, 0.12, 0.12]],
  [0.25, [0.45, 0.45, 0.45]],
  [0.5, [0.85, 0.85, 0.85]],
  [0.75, [0.55, 0.55, 0.55]],
  [1, [0.95, 0.95, 0.95]],
];

export const PRESETS = {
  classic: {
    id: "classic",
    label: "Classic",
    kind: "strip",
    stops: [
      [0.0, [0.02, 0.02, 0.08]],
      [0.16, [0.05, 0.12, 0.45]],
      [0.42, [0.15, 0.55, 0.85]],
      [0.65, [0.95, 0.85, 0.45]],
      [0.85, [0.95, 0.45, 0.15]],
      [1.0, [0.15, 0.02, 0.05]],
    ],
  },
  fire: {
    id: "fire",
    label: "Fire",
    kind: "strip",
    stops: [
      [0.0, [0.05, 0.01, 0.02]],
      [0.2, [0.45, 0.05, 0.02]],
      [0.45, [0.9, 0.35, 0.05]],
      [0.7, [1.0, 0.85, 0.25]],
      [1.0, [1.0, 0.98, 0.9]],
    ],
  },
  ocean: {
    id: "ocean",
    label: "Ocean",
    kind: "strip",
    stops: [
      [0.0, [0.01, 0.04, 0.08]],
      [0.25, [0.02, 0.25, 0.4]],
      [0.5, [0.1, 0.65, 0.7]],
      [0.75, [0.55, 0.9, 0.75]],
      [1.0, [0.95, 0.95, 0.85]],
    ],
  },
  mono: {
    id: "mono",
    label: "Mono",
    kind: "strip",
    stops: [
      [0.0, [0.08, 0.07, 0.05]],
      [0.5, [0.55, 0.5, 0.42]],
      [1.0, [0.96, 0.94, 0.88]],
    ],
  },
  angleHue: {
    id: "angleHue",
    label: "Angle hue",
    kind: "angleHue",
  },
  stripes: {
    id: "stripes",
    label: "Stripes",
    kind: "stripe",
    base: "classic",
  },
  stripesMono: {
    id: "stripesMono",
    label: "Stripes (mono)",
    kind: "stripe",
    base: "mono",
  },
};

export function listPresets() {
  return Object.values(PRESETS);
}

export function getPreset(id) {
  return PRESETS[id] ?? PRESETS.classic;
}

/** @deprecated iterate secondary is independent of gradient presets */
export function presetMode(_id) {
  return COLOUR_MODE_ANGLE;
}

/** @deprecated iterate secondary is independent of gradient presets */
export function docMode(_doc) {
  return COLOUR_MODE_ANGLE;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function cloneStops(stops) {
  return stops.map(([t, c]) => [t, c.slice()]);
}

function sortStops(stops) {
  return [...stops].sort((a, b) => a[0] - b[0]);
}

/** Map t into [0,1] according to wrap mode (for bake sampling). */
export function wrap01(t, wrap = WRAP_REPEAT) {
  if (wrap === WRAP_CLAMP) return Math.min(1, Math.max(0, t));
  if (wrap === WRAP_MIRROR) {
    const x = t < 0 ? -t : t;
    const period = Math.floor(x);
    const f = x - period;
    return period % 2 === 0 ? f : 1 - f;
  }
  return t - Math.floor(t);
}

function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) * 0.5;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0);
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    default:
      h = (r - g) / d + 4;
      break;
  }
  return [h / 6, s, l];
}

function hue2rgb(p, q, t) {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}

/** Shortest-path hue lerp in [0,1). */
function lerpHue(a, b, t) {
  let d = b - a;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return wrap01(a + d * t, WRAP_REPEAT);
}

/**
 * Sample a stop list at t. `blend` is rgb|hsl; `wrap` maps t before lookup.
 */
export function sampleStops(stops, t, blend = BLEND_RGB, wrap = WRAP_REPEAT) {
  if (!stops?.length) return [0, 0, 0];
  const sorted = sortStops(stops);
  const x = wrap01(t, wrap);
  if (sorted.length === 1) return sorted[0][1].slice();

  // Extend endpoints for clamp-like behaviour inside the stop domain.
  if (x <= sorted[0][0]) return sorted[0][1].slice();
  if (x >= sorted[sorted.length - 1][0]) return sorted[sorted.length - 1][1].slice();

  for (let i = 0; i < sorted.length - 1; i++) {
    const [t0, c0] = sorted[i];
    const [t1, c1] = sorted[i + 1];
    if (x >= t0 && x <= t1) {
      const u = t1 === t0 ? 0 : (x - t0) / (t1 - t0);
      if (blend === BLEND_HSL) {
        const h0 = rgbToHsl(c0[0], c0[1], c0[2]);
        const h1 = rgbToHsl(c1[0], c1[1], c1[2]);
        return hslToRgb(
          lerpHue(h0[0], h1[0], u),
          lerp(h0[1], h1[1], u),
          lerp(h0[2], h1[2], u)
        );
      }
      return [
        lerp(c0[0], c1[0], u),
        lerp(c0[1], c1[1], u),
        lerp(c0[2], c1[2], u),
      ];
    }
  }
  return sorted[sorted.length - 1][1].slice();
}

/** HSV → RGB, h in [0,1), s/v in [0,1]. */
function hsvToRgb(h, s, v) {
  const hh = ((h % 1) + 1) % 1;
  const i = Math.floor(hh * 6);
  const f = hh * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

function writeRgb(data, o, rgb) {
  data[o] = Math.round(Math.min(1, Math.max(0, rgb[0])) * 255);
  data[o + 1] = Math.round(Math.min(1, Math.max(0, rgb[1])) * 255);
  data[o + 2] = Math.round(Math.min(1, Math.max(0, rgb[2])) * 255);
  data[o + 3] = 255;
}

/**
 * Create a GradientDocument from a named preset.
 */
export function docFromPreset(presetId) {
  const preset = getPreset(presetId);
  const base = {
    source: "stops",
    presetId: preset.id,
    custom: false,
    blend: BLEND_RGB,
    wrapU: WRAP_REPEAT,
    wrapV: preset.kind === "stripe" ? WRAP_CLAMP : WRAP_REPEAT,
  };

  if (preset.kind === "stripe") {
    const basePreset = getPreset(preset.base);
    return {
      ...base,
      uStops: cloneStops(basePreset.stops),
      vStops: cloneStops(STRIPE_V_STOPS),
    };
  }
  if (preset.kind === "angleHue") {
    return {
      ...base,
      blend: BLEND_HSL,
      wrapV: WRAP_REPEAT,
      uStops: cloneStops(ANGLE_U_STOPS),
      vStops: cloneStops(HUE_V_STOPS),
    };
  }
  return {
    ...base,
    uStops: cloneStops(preset.stops),
    vStops: cloneStops(WHITE_STOPS),
  };
}

export function cloneDoc(doc) {
  return {
    ...doc,
    uStops: cloneStops(doc.uStops || WHITE_STOPS),
    vStops: cloneStops(doc.vStops || WHITE_STOPS),
  };
}

/** Sample RGB from a GradientDocument at (u, v). Multiply combine. */
export function sampleDocRgb(doc, u, v) {
  if (doc?.source === "image") {
    return [0, 0, 0];
  }
  const blend = doc.blend === BLEND_HSL ? BLEND_HSL : BLEND_RGB;
  const cu = sampleStops(doc.uStops, u, blend, WRAP_REPEAT);
  const cv = sampleStops(doc.vStops, v, blend, WRAP_REPEAT);
  return [cu[0] * cv[0], cu[1] * cv[1], cu[2] * cv[2]];
}

/**
 * Sample RGB at (u, v) for a preset (legacy helper / Orbit).
 */
export function samplePresetRgb(preset, u, v) {
  return sampleDocRgb(docFromPreset(preset.id || preset), u, v);
}

/** Bake a 1D RGBA8 strip from U stops (Orbit / Cloud). */
export function bakeLut(presetIdOrDoc, size = LUT_SIZE) {
  const doc =
    typeof presetIdOrDoc === "string"
      ? docFromPreset(presetIdOrDoc)
      : presetIdOrDoc;
  const data = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    writeRgb(data, i * 4, sampleDocRgb(doc, i / size, 0.5));
  }
  return data;
}

/**
 * Bake a 2D RGBA8 LUT from a GradientDocument (or preset id).
 * u = iter (columns), v = angle/stripe (rows). Combine = U × V multiply.
 */
export function bakeLut2d(
  presetIdOrDoc,
  width = LUT_WIDTH,
  height = LUT_HEIGHT
) {
  const doc =
    typeof presetIdOrDoc === "string"
      ? docFromPreset(presetIdOrDoc)
      : presetIdOrDoc;
  if (doc.source === "image" && doc.imageData instanceof Uint8Array) {
    return doc.imageData;
  }
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      writeRgb(data, (y * width + x) * 4, sampleDocRgb(doc, u, v));
    }
  }
  return data;
}

/** Compact stop encoding for URL: t as 0–999, rgb as 0–255 hex. */
export function encodeStops(stops) {
  return sortStops(stops)
    .map(([t, c]) => {
      const ti = Math.round(Math.min(1, Math.max(0, t)) * 999);
      const r = Math.round(Math.min(1, Math.max(0, c[0])) * 255);
      const g = Math.round(Math.min(1, Math.max(0, c[1])) * 255);
      const b = Math.round(Math.min(1, Math.max(0, c[2])) * 255);
      return `${ti.toString(16)}.${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
    })
    .join("_");
}

export function decodeStops(s, fallback) {
  if (!s) return cloneStops(fallback);
  try {
    const parts = s.split("_").filter(Boolean);
    if (!parts.length) return cloneStops(fallback);
    const stops = parts.map((p) => {
      const [ts, cs] = p.split(".");
      const t = parseInt(ts, 16) / 999;
      const n = parseInt(cs, 16);
      return [
        t,
        [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255],
      ];
    });
    return sortStops(stops);
  } catch {
    return cloneStops(fallback);
  }
}

export function encodeGradientParams({ grad, goff, gdens }) {
  return { grad, goff, gdens };
}

const INTERIOR_RGB = [0.11, 0.094, 0.07];

/** Sample a baked RGBA8 1D LUT → RGB floats in 0–1. */
export function sampleLutRgb(lut, t, size = LUT_SIZE) {
  const x = ((t % 1) + 1) % 1;
  const i = Math.min(size - 1, Math.floor(x * size));
  const o = i * 4;
  return [lut[o] / 255, lut[o + 1] / 255, lut[o + 2] / 255];
}

/**
 * Colour a smooth-iter value the same way a strip (1D) LUT does.
 * `density` is palette cycles across [0, maxIter]; pass maxIter to match the viewer.
 */
export function colourEscape(m, { density, offset, lut, maxIter }) {
  if (m < 0) return INTERIOR_RGB.slice();
  const scale =
    maxIter != null && maxIter > 0 ? density / maxIter : density;
  const t = m * scale + offset;
  const wrapped = t - Math.floor(t);
  return sampleLutRgb(lut, wrapped);
}

/** rgb float → #rrggbb */
export function rgbToHex(rgb) {
  const r = Math.round(Math.min(1, Math.max(0, rgb[0])) * 255);
  const g = Math.round(Math.min(1, Math.max(0, rgb[1])) * 255);
  const b = Math.round(Math.min(1, Math.max(0, rgb[2])) * 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
