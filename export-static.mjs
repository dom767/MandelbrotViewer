#!/usr/bin/env node
/**
 * Versioned static export for Mandelbrot Zoomer.
 * Creates Export/VersionN with bundled JS/CSS and a production index.html.
 *
 * Usage:
 *   node export-static.mjs            a local build: Export/Version<N>-local<k>, where N is the
 *                                     next release; it doesn't use up a release number
 *   node export-static.mjs --release  claims the next release number on GitHub (VERSION, see
 *                                     scripts/release-version.mjs) and builds Export/Version<N>
 *
 * Prefer Build.cmd / DeployLocal.cmd / DeployProd.cmd (actions/*.mjs) over calling this directly.
 * Both modes first refresh js/vendor/baffled-screenshots.js from ScreenGrabber's master branch and
 * fail if they can't, so an export never bundles a stale SDK.
 */
import { build, transform } from "esbuild";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { claimVersion, currentVersion, sourceOf } from "./scripts/release-version.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const exportRoot = join(root, "Export");
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
      `Couldn't refresh the ScreenGrabber SDK (${err.message}). Export stopped so a stale copy isn't shipped.`,
    );
  }
  if (!/export function createBaffledScreenshots\b/.test(text)) {
    throw new Error(
      `${SCREENSHOTS_SDK_URL} doesn't export createBaffledScreenshots. Export stopped.`,
    );
  }

  // Compare ignoring line endings, so a CRLF checkout isn't rewritten for nothing.
  const lf = (s) => s.replace(/\r\n/g, "\n");
  const current = existsSync(SCREENSHOTS_SDK_PATH) ? readFileSync(SCREENSHOTS_SDK_PATH, "utf8") : "";
  if (lf(current) === lf(text)) {
    console.log("ScreenGrabber SDK is up to date.");
    return;
  }
  const tmp = `${SCREENSHOTS_SDK_PATH}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, SCREENSHOTS_SDK_PATH);
  console.log("ScreenGrabber SDK updated: js/vendor/baffled-screenshots.js (commit it with this release).");
}

/** The highest release folder here (Export/VersionN), so a claim never reuses one. */
function highestLocalRelease() {
  if (!existsSync(exportRoot)) return 0;
  let max = 0;
  for (const name of readdirSync(exportRoot)) {
    const m = /^Version(\d+)$/.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * The version to stamp and the folder to build into. A release claims its number on GitHub;
 * a local build is "<next>-local<k>", never overwriting anything.
 * @param {boolean} release
 */
function pickVersion(release) {
  if (release) {
    const n = claimVersion(root, { floor: highestLocalRelease() });
    const outDir = join(exportRoot, `Version${n}`);
    rmSync(outDir, { recursive: true, force: true });
    return { version: String(n), name: `Version${n}` };
  }
  const next = currentVersion(root) + 1;
  for (let k = 1; ; k++) {
    const name = `Version${next}-local${k}`;
    if (!existsSync(join(exportRoot, name))) return { version: `${next}-local${k}`, name };
  }
}

async function minifyCss(source) {
  const result = await transform(source, {
    loader: "css",
    minify: true,
  });
  return result.code;
}

function rewriteIndexHtml(html, version) {
  let out = html;

  out = out.replace(
    /<link\s+rel="stylesheet"\s+href="css\/app\.css"\s*\/?>/,
    `<link rel="stylesheet" href="app.bundle.min.css?v=${version}" />`,
  );

  out = out.replace(
    /<script\s+type="module"\s+src="js\/main\.js"\s*><\/script>/,
    [
      `<script>self.${ASSET_GLOBAL} = "${version}";</script>`,
      `<script type="module" src="app.bundle.min.js?v=${version}"></script>`,
    ].join("\n  "),
  );

  if (!out.includes("app.bundle.min.js") || !out.includes("app.bundle.min.css")) {
    throw new Error(
      "Failed to rewrite index.html for production bundles (dev link/script not found).",
    );
  }

  return out;
}

function printAwsCommands(version, bucket, prefix) {
  const local = `Export/Version${version}`;
  const s3 = `s3://${bucket}/${prefix}`;
  console.log(`# 1. Long-cache assets`);
  console.log(
    `aws s3 sync "${local}" "${s3}" --delete --exclude index.html --exclude "*.json.gz" --cache-control "public, max-age=31536000, immutable"`,
  );
  console.log(`# 2. Short-cache entry`);
  console.log(
    `aws s3 cp "${local}/index.html" "${s3}index.html" --cache-control "public, max-age=60" --content-type "text/html; charset=utf-8"`,
  );
}

async function main() {
  const release = process.argv.includes("--release");
  // Before claiming a number, so a failed refresh doesn't use one up.
  await refreshScreenshotsSdk();
  const source = sourceOf(root);
  if (release && source.uncommittedChanges) {
    console.warn("Warning: this clone has uncommitted changes, so this release won't match any commit on GitHub.");
  }
  const { version, name } = pickVersion(release);
  const outDir = join(exportRoot, name);

  if (existsSync(outDir)) {
    throw new Error(`Refusing to overwrite existing ${outDir}`);
  }
  mkdirSync(outDir, { recursive: true });

  console.log(`Exporting ${release ? "release" : "local build"} ${version} → ${outDir}`);

  try {
    await build({
      entryPoints: [join(root, "js", "main.js")],
      bundle: true,
      minify: true,
      format: "esm",
      outfile: join(outDir, "app.bundle.min.js"),
      platform: "browser",
      target: ["es2022"],
      logLevel: "info",
    });

    const cssSource = readFileSync(join(root, "css", "app.css"), "utf8");
    writeFileSync(join(outDir, "app.bundle.min.css"), await minifyCss(cssSource), "utf8");

    const htmlSource = readFileSync(join(root, "index.html"), "utf8");
    writeFileSync(
      join(outDir, "index.html"),
      rewriteIndexHtml(htmlSource, version),
      "utf8",
    );
  } catch (err) {
    rmSync(outDir, { recursive: true, force: true });
    console.error("Export failed — incomplete folder removed.");
    throw err;
  }

  const manifest = {
    version,
    release,
    dir: `Export/${name}`,
    exportedAt: new Date().toISOString(),
    source,
  };
  writeFileSync(
    join(exportRoot, "latest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );

  console.log("");
  console.log(`Wrote ${manifest.dir}`);
  console.log(`Manifest Export/latest.json → version ${version}`);
  console.log("");
  console.log("Smoke-test:");
  console.log(`  npx --yes serve ${manifest.dir} -p 8080`);
  console.log("");
  console.log("Manual S3 sync (replace bucket/prefix if needed):");
  printAwsCommands(version, "baffledcat.com", "mandelbrot/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
