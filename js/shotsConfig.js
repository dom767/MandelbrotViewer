/**
 * Shared screenshots API config for Mandelbrot.
 * Override via window.__BAFFLED_SHOTS__ before main loads if needed.
 */
const defaults = {
  apiBase: "https://shots.baffledcat.com",
  appId: "mandelbrot",
  /** Set your Turnstile site key in production. */
  turnstileSiteKey: "",
  /**
   * When true, SDK sends a bypass token — Worker must have DEV_BYPASS_TURNSTILE=1.
   * Keep true for local/dev until Turnstile keys are configured.
   */
  devBypassTurnstile: true,
};

export function getShotsConfig() {
  return { ...defaults, ...(window.__BAFFLED_SHOTS__ || {}) };
}
