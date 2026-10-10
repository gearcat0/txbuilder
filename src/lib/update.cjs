// ── Updates: asked for, never assumed ────────────────────────────────────────
// TX Builder does not touch the network for its own sake unless the user
// asked, and that holds for its own updates too:
//
//   - Background checks run only after the user said yes (pref "on"). Until
//     they answer, the pref is "ask" and nothing is checked.
//   - Help → Check for Updates… is an explicit ask and always runs.
//   - Finding an update downloads nothing. The user sees the version and the
//     notes and decides; only then is the installer fetched.
//   - Installing restarts the app, so that is a separate yes too.
//
// The updater itself (electron-updater) is injected. This file holds only the
// consent and scheduling logic, so it is testable without Electron. Ported
// from souspli's src/shell/update.
//
// States (state.phase):
//   idle | checking | inactive (this build cannot update itself) |
//   current {checkedAt} | available {version, notes, canInstall} |
//   downloading {version, percent} | ready {version} | error {message}
//
// canInstall is false for a .deb, which electron-updater could only install
// unauthenticated through pkexec/sudo; those users get the release page.

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NOTES = 4000;
const PREFS = ["ask", "on", "off"];

/** Release notes arrive as HTML from the GitHub feed. The renderer never
 *  renders remote markup, so they are reduced to text here. */
function notesText(raw) {
  const parts = Array.isArray(raw)
    ? raw.map((n) => (typeof n === "object" && n !== null ? String(n.note ?? "") : String(n)))
    : [typeof raw === "string" ? raw : ""];
  const text = parts
    .join("\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h[1-6]|div)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > MAX_NOTES ? `${text.slice(0, MAX_NOTES)}…` : text;
}

function normalizePref(v) {
  return PREFS.includes(v) ? v : "ask";
}

class UpdateService {
  /**
   * @param {object} opts
   * @param {() => Promise<object>} opts.createUpdater  built on first use, so
   *   electron-updater is not even loaded before someone asks for a check
   * @param {() => string} opts.getPref
   * @param {(p: string) => void} opts.setPref
   * @param {boolean} opts.canInstall
   * @param {(state: object) => void} opts.onState
   */
  constructor(opts) {
    this.o = {
      firstCheckMs: 30_000,
      intervalMs: DAY_MS,
      now: Date.now,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t),
      ...opts,
    };
    this.state = { phase: "idle" };
    this.updater = null;
    this.timer = null;
  }

  pref() {
    return normalizePref(this.o.getPref());
  }

  status() {
    return { pref: this.pref(), state: this.state };
  }

  /** Begin background checks, if and only if the user turned them on. */
  start() {
    this.schedule(this.o.firstCheckMs);
  }

  stop() {
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = null;
  }

  setPref(p) {
    if (!PREFS.includes(p)) return;
    this.o.setPref(p);
    this.stop();
    // Turning checks on is itself the ask: check now rather than in a day.
    if (p === "on") this.check({ manual: false }).finally(() => this.schedule(this.o.intervalMs));
    else this.o.onState(this.state);
  }

  /** A background check does nothing unless checks are on. A manual one is an
   *  explicit ask and always runs. */
  async check({ manual }) {
    if (!manual && this.pref() !== "on") return this.state;
    const phase = this.state.phase;
    if (phase === "checking" || phase === "downloading") return this.state;
    // Already downloaded: nothing new to learn until it is installed.
    if (phase === "ready") return this.state;
    this.set({ phase: "checking" });
    try {
      const u = await this.getUpdater();
      const r = await u.checkForUpdates();
      // null: electron-updater declined to run (an unpackaged build with no
      // feed configured). isUpdateAvailable already refuses downgrades.
      if (r == null) return this.set({ phase: "inactive" });
      if (!r.isUpdateAvailable) return this.set({ phase: "current", checkedAt: this.o.now() });
      return this.set({
        phase: "available",
        version: r.updateInfo.version,
        notes: notesText(r.updateInfo.releaseNotes),
        canInstall: this.o.canInstall,
      });
    } catch (e) {
      return this.set({ phase: "error", message: e?.message ?? String(e) });
    }
  }

  /** Fetch the installer for the update the user was shown. */
  async download() {
    const s = this.state;
    if (s.phase !== "available" || !s.canInstall) return this.state;
    const u = await this.getUpdater();
    this.set({ phase: "downloading", version: s.version, percent: 0 });
    try {
      await u.downloadUpdate();
      return this.set({ phase: "ready", version: s.version });
    } catch (e) {
      return this.set({ phase: "error", message: e?.message ?? String(e) });
    }
  }

  /** Restart into the downloaded version. */
  install() {
    if (this.state.phase !== "ready" || !this.updater) return false;
    this.updater.quitAndInstall(false, true);
    return true;
  }

  async getUpdater() {
    if (this.updater) return this.updater;
    const u = await this.o.createUpdater();
    u.on("download-progress", (p) => {
      if (this.state.phase === "downloading") this.set({ ...this.state, percent: Math.round(p.percent) });
    });
    u.on("error", (e) => {
      // Errors during a check or download are returned by those calls; this
      // catches the rest (e.g. a failed install hand-off) so they are not lost.
      if (this.state.phase !== "checking" && this.state.phase !== "downloading") {
        this.set({ phase: "error", message: e?.message ?? String(e) });
      }
    });
    this.updater = u;
    return u;
  }

  schedule(ms) {
    this.stop();
    if (this.pref() !== "on") return;
    this.timer = this.o.setTimer(() => {
      this.timer = null;
      this.check({ manual: false }).finally(() => this.schedule(this.o.intervalMs));
    }, ms);
  }

  set(s) {
    this.state = s;
    this.o.onState(s);
    return s;
  }
}

module.exports = { UpdateService, notesText, normalizePref };
