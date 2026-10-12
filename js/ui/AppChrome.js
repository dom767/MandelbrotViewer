const DESKTOP_MQ = "(min-width: 768px)";

/**
 * Bottom nav chrome: Home, Settings (left HUD), Fullscreen, Orbit panel.
 */
export class AppChrome {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.nav
   * @param {HTMLElement} opts.hud
   * @param {HTMLElement} [opts.scrim]
   * @param {() => void} opts.onHome
   * @param {(open: boolean) => void} opts.onOrbit
   * @param {() => boolean} opts.isOrbitOpen
   */
  constructor({ nav, hud, scrim = null, onHome, onOrbit, isOrbitOpen }) {
    this.nav = nav;
    this.hud = hud;
    this.scrim = scrim;
    this.onHome = onHome;
    this.onOrbit = onOrbit;
    this.isOrbitOpen = isOrbitOpen;
    this.mq = window.matchMedia(DESKTOP_MQ);
    this.isWide = this.mq.matches;

    for (const btn of nav.querySelectorAll("[data-nav]")) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onNavClick(btn.dataset.nav);
      });
      btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    }

    if (scrim) {
      scrim.addEventListener("click", () => this.closeSettings());
      scrim.addEventListener("pointerdown", (e) => e.stopPropagation());
    }

    this.mq.addEventListener("change", () => {
      this.isWide = this.mq.matches;
      this.syncScrim();
    });

    document.addEventListener("fullscreenchange", () => this.syncFullscreenNav());
    document.addEventListener("webkitfullscreenchange", () => this.syncFullscreenNav());

    // Settings starts open on desktop so controls stay discoverable; closed on mobile.
    if (this.isWide) this.openSettings();
    else this.closeSettings();
    this.syncOrbitNav();
    this.syncFullscreenNav();
  }

  onNavClick(navId) {
    switch (navId) {
      case "home":
        this.onHome();
        break;
      case "settings":
        this.toggleSettings();
        break;
      case "fullscreen":
        void this.toggleFullscreen();
        break;
      case "orbit":
        this.toggleOrbit();
        break;
      default:
        break;
    }
  }

  isSettingsOpen() {
    return !this.hud.classList.contains("hidden");
  }

  openSettings() {
    this.hud.classList.remove("hidden");
    this.setNavActive("settings", true);
    this.syncScrim();
  }

  closeSettings() {
    this.hud.classList.add("hidden");
    this.setNavActive("settings", false);
    this.syncScrim();
  }

  toggleSettings() {
    if (this.isSettingsOpen()) this.closeSettings();
    else this.openSettings();
  }

  toggleOrbit() {
    const next = !this.isOrbitOpen();
    this.onOrbit(next);
    this.syncOrbitNav();
  }

  syncOrbitNav() {
    this.setNavActive("orbit", this.isOrbitOpen());
  }

  isFullscreen() {
    return !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement
    );
  }

  async toggleFullscreen() {
    try {
      if (this.isFullscreen()) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } else {
        const el = document.documentElement;
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      }
    } catch {
      // User gesture / permission failures — leave UI in sync via fullscreenchange.
    }
    this.syncFullscreenNav();
  }

  syncFullscreenNav() {
    const on = this.isFullscreen();
    const btn = this.nav.querySelector('[data-nav="fullscreen"]');
    if (!btn) return;
    this.setNavActive("fullscreen", on);
    btn.setAttribute("aria-label", on ? "Exit fullscreen" : "Enter fullscreen");
    const enter = btn.querySelector(".nav-icon--fs-enter");
    const exit = btn.querySelector(".nav-icon--fs-exit");
    const label = btn.querySelector(".nav-label");
    if (enter) enter.classList.toggle("hidden", on);
    if (exit) exit.classList.toggle("hidden", !on);
    if (label) label.textContent = on ? "Exit" : "Full";
  }

  /**
   * Toggle or force a single nav button's active state without clearing others
   * that can be independently active (settings + orbit + fullscreen).
   */
  setNavActive(navId, active) {
    const btn = this.nav.querySelector(`[data-nav="${navId}"]`);
    if (!btn) return;
    btn.classList.toggle("is-active", !!active);
    if (navId === "settings" || navId === "orbit" || navId === "fullscreen") {
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  syncScrim() {
    if (!this.scrim) return;
    const sheetOpen = !this.isWide && this.isSettingsOpen();
    this.scrim.classList.toggle("hidden", !sheetOpen);
    this.scrim.setAttribute("aria-hidden", sheetOpen ? "false" : "true");
  }
}
