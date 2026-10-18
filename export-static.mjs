#!/usr/bin/env node
/**
 * Versioned static export for Mandelbrot Zoomer.
 * Creates Export/VersionN with bundled JS/CSS and a production index.html.
 *
 * Usage: node export-static.mjs
 */
import { build, transform } from "esbuild";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const exportRoot = join(root, "Export");
const ASSET_GLOBAL = "__MANDELBROT_ASSET_VERSION__";

function nextVersion() {
  if (!existsSync(exportRoot)) return 1;
  let max = 0;
  for (const name of readdirSync(exportRoot)) {
    const m = /^Version(\d+)$/.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
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
  const version = nextVersion();
  const outDir = join(exportRoot, `Version${version}`);

  if (existsSync(outDir)) {
    throw new Error(`Refusing to overwrite existing ${outDir}`);
  }
  mkdirSync(outDir, { recursive: true });

  console.log(`Exporting Version${version} → ${outDir}`);

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
    dir: `Export/Version${version}`,
    exportedAt: new Date().toISOString(),
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
  console.log(`  npx --yes serve Export/Version${version} -p 8080`);
  console.log("");
  console.log("Manual S3 sync (replace bucket/prefix if needed):");
  printAwsCommands(version, "baffledcat.com", "mandelbrot/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
