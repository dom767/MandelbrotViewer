/**
 * Probe points for cross-algorithm comparison.
 * Five bands × 4×4 grid (16 samples each) = 80 points.
 *
 * Regions:
 *  1. overview   — full-set framing (all algos should agree)
 *  2. medium     — seahorse valley, still comfortable for f32
 *  3. f32-edge   — mini-set where f32 mapping/iterate falls apart
 *  4. f48-edge   — ~48-bit depth (float-float of f32); f32 dead, f64 still OK
 *  5. f64-edge   — deeper still; f64 camera/iterate stressed, BigInt is truth
 */

/** @typedef {{ id: string, band: string, cx: number, cy: number, maxIter: number, refCx: number, refCy: number, scale: number }} Probe */

/**
 * @param {object} band
 * @returns {Probe[]}
 */
function gridProbes(band) {
  const { id, centerX, centerY, scale, maxIter, n = 4 } = band;
  /** @type {Probe[]} */
  const out = [];
  let k = 0;
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const u = (ix + 0.5) / n;
      const v = (iy + 0.5) / n;
      // Aspect 1 for tests — square window in the plane.
      const cx = centerX + (u - 0.5) * scale;
      const cy = centerY - (v - 0.5) * scale;
      out.push({
        id: `${id}-${String(k).padStart(2, "0")}`,
        band: id,
        cx,
        cy,
        maxIter,
        refCx: centerX,
        refCy: centerY,
        scale,
      });
      k += 1;
    }
  }
  return out;
}

/** Classic mini-set / seahorse neighborhood (same locus, deeper scales). */
const MINI = {
  centerX: -0.743643887037151,
  centerY: 0.13182590420533,
};

export const BANDS = [
  {
    id: "overview",
    label: "Standard zoom (full set)",
    centerX: -0.5,
    centerY: 0,
    scale: 3.0,
    maxIter: 200,
  },
  {
    id: "medium",
    label: "Greater zoom (seahorse)",
    centerX: -0.7435,
    centerY: 0.1314,
    scale: 0.02,
    maxIter: 500,
  },
  {
    id: "f32-edge",
    label: "Edge of 32-bit accuracy",
    ...MINI,
    scale: 5e-6,
    maxIter: 2000,
  },
  {
    // Past f32 (~1e-7), into float-float territory (~48-bit). At 1e-9 the
    // DD mirror starts to peel away from cpuRef while native f64 still tracks.
    id: "f48-edge",
    label: "Edge of ~48-bit (float-float) accuracy",
    ...MINI,
    scale: 1e-9,
    maxIter: 3000,
  },
  {
    id: "f64-edge",
    label: "Edge of 64-bit accuracy",
    ...MINI,
    scale: 1e-13,
    maxIter: 5000,
  },
];

/** All probes in band order (80 = 5 × 16). */
export function allProbes() {
  return BANDS.flatMap(gridProbes);
}
