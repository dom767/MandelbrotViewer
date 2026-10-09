/**
 * Continuous-iteration helpers (CPU reference / docs parity).
 * GPU path implements the same formula in WGSL.
 */

export function smoothFromEscape(n, mag2) {
  if (n < 0) return -1;
  const logZn = Math.log2(mag2) * 0.5;
  return n + 1 - Math.log2(logZn);
}
