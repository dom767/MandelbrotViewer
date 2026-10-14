/**
 * Shared screenshots API config for Mandelbrot.
 * Override via window.__BAFFLED_SHOTS__ before main loads if needed.
 */
const defaults = {
  apiBase: "https://shots.baffledcat.com",
  appId: "mandelbrot",
  /** Cloudflare Turnstile site key (public). */
  turnstileSiteKey: "0x4AAAAAAFWa6VDrVl29LSiw",
  /**
   * When true, SDK sends a bypass token - API must have DEV_BYPASS_TURNSTILE=1.
   * Keep false in production once TURNSTILE_SECRET is deployed.
   */
  devBypassTurnstile: false,
};

export function getShotsConfig() {
  return { ...defaults, ...(window.__BAFFLED_SHOTS__ || {}) };
}
