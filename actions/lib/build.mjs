// @ts-check
/**
 * Shared by Build / Deploy Local / Deploy Prod (guidelines/repository-commands.md, export.md).
 * Build makes one unnumbered package in Export/Build<k>, with __VERSION__ left in its HTML.
 * Deploy Local and Deploy Prod never rebuild: they copy that package and stamp a version into it.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const exportRoot = path.join(root, "Export");
/** Left in the built HTML (`?v=__VERSION__`, the asset-version global); replaced when deploying. */
export const PLACEHOLDER = "__VERSION__";

/** @param {RegExp} re */
function highest(re) {
  if (!fs.existsSync(exportRoot)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(exportRoot)) {
    const m = re.exec(name);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return n;
}

/** The highest release folder (Export/VersionN): the floor for claimVersion, so a number is never reused. */
export function highestRelease() {
  return highest(/^Version(\d+)$/);
}

/** A new, empty Export/Build<k> for Build to fill. */
export function newBuildDir() {
  const build = highest(/^Build(\d+)$/) + 1;
  const dir = path.join(exportRoot, `Build${build}`);
  fs.mkdirSync(dir, { recursive: true });
  return { build, dir };
}

/**
 * Record a finished build as the latest (Export/latest.json).
 * @param {{build: number, dir: string, source?: unknown}} b  source: sourceOf() from scripts/release-version.mjs
 */
export function writeLatest(b) {
  const html = listFiles(b.dir).filter((f) => f.endsWith(".html"));
  if (!html.some((f) => fs.readFileSync(f, "utf8").includes(PLACEHOLDER))) {
    throw new Error(`No ${PLACEHOLDER} in the built HTML: leave the version as a placeholder for deploys to stamp.`);
  }
  const manifest = {
    build: b.build,
    dir: path.relative(root, b.dir).split(path.sep).join("/"),
    builtAt: new Date().toISOString(),
    source: b.source ?? null,
  };
  fs.writeFileSync(path.join(exportRoot, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

/** The latest build, or an error saying to run Build first. */
export function latestBuild() {
  const file = path.join(exportRoot, "latest.json");
  const manifest = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  const dir = manifest?.dir ? path.join(root, manifest.dir) : "";
  if (!manifest?.build || !dir || !fs.existsSync(dir)) throw new Error("No build yet: run Build first.");
  return { ...manifest, dir };
}

/**
 * One line saying which build this is, for the top of a deploy's log.
 * @param {{build: number, builtAt: string, source?: {commit?: string, uncommittedChanges?: boolean} | null}} b
 */
export function describe(b) {
  const s = b.source ?? {};
  const commit = s.commit ? ` from ${String(s.commit).slice(0, 7)}` : "";
  const dirty = s.uncommittedChanges ? " (with uncommitted changes)" : "";
  return `Build ${b.build}${commit}${dirty}, built ${b.builtAt}`;
}

/** @param {string} dir */
function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

/**
 * Copy a build to `to`, replacing the placeholder in its HTML with `version`. Everything else is
 * copied byte for byte, so what ships is what was built.
 * @param {string} from
 * @param {string} to
 * @param {string} version
 * @param {{replace?: boolean}} [o]  replace: overwrite `to` (local copies only; release folders never are)
 */
export function stampCopy(from, to, version, o = {}) {
  if (fs.existsSync(to)) {
    if (!o.replace) throw new Error(`Refusing to overwrite ${to}`);
    fs.rmSync(to, { recursive: true, force: true });
  }
  fs.cpSync(from, to, { recursive: true });
  for (const f of listFiles(to)) {
    if (!f.endsWith(".html")) continue;
    const html = fs.readFileSync(f, "utf8");
    if (html.includes(PLACEHOLDER)) fs.writeFileSync(f, html.split(PLACEHOLDER).join(version));
  }
  return to;
}

/**
 * Open a command in its own console window and return at once (the dashboard waits for an
 * action to exit). Closing the window stops it.
 * @param {string} title
 * @param {string} command  run by cmd /k in the repo root; no & | < > (the outer cmd would take them)
 */
export function openWindow(title, command) {
  const env = { ...process.env };
  delete env.AC_NO_PAUSE; // the new window is for a human: keep it open on errors
  const child = spawn("cmd.exe", ["/c", "start", `"${title}"`, "cmd", "/k", command], {
    cwd: root,
    env,
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
  });
  child.unref();
}
