#!/usr/bin/env node
// @ts-check
/**
 * Build — make one unnumbered package in Export/Build<k> (no upload, no release-number claim).
 * Deploy Local and Deploy Prod both deploy this package; neither rebuilds.
 *
 * Refreshes js/vendor/baffled-screenshots.js from ScreenGrabber's master branch first and fails if
 * it can't, so a build never bundles a stale SDK. Then bundles js/main.js, minifies css/app.css
 * and rewrites index.html with ?v=__VERSION__ and self.__MANDELBROT_ASSET_VERSION__ = "__VERSION__"
 * for the deploys to stamp. See guidelines/repository-commands.md and export.md.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newBuildDir, PLACEHOLDER, root, writeLatest } from "./lib/build.mjs";
import { ensureNodeModules } from "../scripts/repo-actions.mjs";
import { sourceOf } from "../scripts/release-version.mjs";

const ASSET_GLOBAL = "__MANDELBROT_ASSET_VERSION__";
const SCREENSHOTS_SDK_URL =
  "https://raw.githubusercontent.com/dom767/ScreenGrabber/master/sdk/baffled-screenshots.js";
const SCREENSHOTS_SDK_PATH = join(root, "js", "vendor", "baffled-screenshots.js");

/**
 * Pull the ScreenGrabber SDK into js/vendor before bundling. Throws if it can't be fetched or
 * doesn't look like the SDK, rather than packaging whatever copy is checked in.
 */
async function refreshScreenshotsSdk() {
  console.log(`Refreshing ScreenGrabber SDK from ${SCREENSHOTS_SDK_URL}`);
  let text;
  try {
    const res = await fetch(SCREENSHOTS_SDK_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    text = await res.text();
  } catch (err) {
    throw new Error(
      `Couldn't refresh the ScreenGrabber SDK (${err.message}). Build stopped so a stale copy isn't shipped.`,
    );
  }
  if (!/export function createBaffledScreenshots\b/.test(text)) {
    throw new Error(`${SCREENSHOTS_SDK_URL} doesn't export createBaffledScreenshots. Build stopped.`);
  }

  // Compare ignoring line endings, so a CRLF checkout isn't rewritten for nothing.
  /** @param {string} s */
  const lf = (s) => s.replace(/\r\n/g, "\n");
  const current = existsSync(SCREENSHOTS_SDK_PATH) ? readFileSync(SCREENSHOTS_SDK_PATH, "utf8") : "";
  if (lf(current) === lf(text)) {
    console.log("ScreenGrabber SDK is up to date.");
    return;
  }
  const tmp = `${SCREENSHOTS_SDK_PATH}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, SCREENSHOTS_SDK_PATH);
  console.log("ScreenGrabber SDK updated: js/vendor/baffled-screenshots.js (commit it with this build).");
}

/** Point index.html at the bundles, leaving the version as the placeholder. @param {string} html */
function rewriteIndexHtml(html) {
  let out = html;

  out = out.replace(
    /<link\s+rel="stylesheet"\s+href="css\/app\.css"\s*\/?>/,
    `<link rel="stylesheet" href="app.bundle.min.css?v=${PLACEHOLDER}" />`,
  );

  out = out.replace(
    /<script\s+type="module"\s+src="js\/main\.js"\s*><\/script>/,
    [
      `<script>self.${ASSET_GLOBAL} = "${PLACEHOLDER}";</script>`,
      `<script type="module" src="app.bundle.min.js?v=${PLACEHOLDER}"></script>`,
    ].join("\n  "),
  );

  if (!out.includes("app.bundle.min.js") || !out.includes("app.bundle.min.css")) {
    throw new Error("Failed to rewrite index.html for production bundles (dev link/script not found).");
  }

  return out;
}

async function main() {
  ensureNodeModules();
  const { build, transform } = await import("esbuild");

  await refreshScreenshotsSdk();
  const source = sourceOf(root);
  const { build: k, dir } = newBuildDir();
  console.log(`Building ${dir}`);

  try {
    await build({
      entryPoints: [join(root, "js", "main.js")],
      bundle: true,
      minify: true,
      format: "esm",
      outfile: join(dir, "app.bundle.min.js"),
      platform: "browser",
      target: ["es2022"],
      logLevel: "info",
    });

    const cssSource = readFileSync(join(root, "css", "app.css"), "utf8");
    const css = await transform(cssSource, { loader: "css", minify: true });
    writeFileSync(join(dir, "app.bundle.min.css"), css.code, "utf8");

    const htmlSource = readFileSync(join(root, "index.html"), "utf8");
    writeFileSync(join(dir, "index.html"), rewriteIndexHtml(htmlSource), "utf8");

    const manifest = writeLatest({ build: k, dir, source });
    console.log("");
    console.log(`Build ${manifest.build} ready in ${manifest.dir}.`);
    console.log("Deploy it with Deploy Local (or Deploy Prod).");
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    console.error("Build failed — incomplete folder removed.");
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
