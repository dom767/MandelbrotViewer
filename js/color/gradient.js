/** Gradient presets and LUT baking for smooth Mandelbrot colouring. */

export const LUT_SIZE = 512;

export const PRESETS = {
  classic: {
    id: "classic",
    label: "Classic",
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
    stops: [
      [0.0, [0.08, 0.07, 0.05]],
      [0.5, [0.55, 0.5, 0.42]],
      [1.0, [0.96, 0.94, 0.88]],
    ],
  },
};

export function listPresets() {
  return Object.values(PRESETS);
}

export function getPreset(id) {
  return PRESETS[id] ?? PRESETS.classic;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function sampleStops(stops, t) {
  const x = ((t % 1) + 1) % 1;
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (x >= t0 && x <= t1) {
      const u = t1 === t0 ? 0 : (x - t0) / (t1 - t0);
      return [
        lerp(c0[0], c1[0], u),
        lerp(c0[1], c1[1], u),
        lerp(c0[2], c1[2], u),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

/** Bake RGBA8 LUT (sRGB-ish linear floats → 0–255). */
export function bakeLut(presetId, size = LUT_SIZE) {
  const preset = getPreset(presetId);
  const data = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const [r, g, b] = sampleStops(preset.stops, i / size);
    const o = i * 4;
    data[o] = Math.round(Math.min(1, Math.max(0, r)) * 255);
    data[o + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255);
    data[o + 2] = Math.round(Math.min(1, Math.max(0, b)) * 255);
    data[o + 3] = 255;
  }
  return data;
}

export function encodeGradientParams({ grad, goff, gdens }) {
  return { grad, goff, gdens };
}

const INTERIOR_RGB = [0.11, 0.094, 0.07];

/** Sample a baked RGBA8 LUT → RGB floats in 0–1. */
export function sampleLutRgb(lut, t, size = LUT_SIZE) {
  const x = ((t % 1) + 1) % 1;
  const i = Math.min(size - 1, Math.floor(x * size));
  const o = i * 4;
  return [lut[o] / 255, lut[o + 1] / 255, lut[o + 2] / 255];
}

/**
 * Colour a smooth-iter value the same way the GPU colour pass does.
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
