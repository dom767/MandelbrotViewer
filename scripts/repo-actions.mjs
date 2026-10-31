/**
 * Mandelbrot-specific helpers for the actions: the esbuild install for Build, and the S3 sync +
 * live-version check for Deploy Prod. Build/deploy bookkeeping is in actions/lib/build.mjs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = dirname(dirname(fileURLToPath(import.meta.url)));

const DEFAULT_S3_BUCKET = "baffledcat.com";
const DEFAULT_S3_PREFIX = "mandelbrot/";

export function ensureNodeModules() {
  if (existsSync(join(root, "node_modules", "esbuild"))) return;
  console.log("Installing npm dependencies (esbuild)...");
  const result = spawnSync("npm", ["install"], {
    cwd: root,
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) throw new Error("npm install failed");
}

function runAws(args, { inherit = true } = {}) {
  const result = spawnSync("aws", args, {
    cwd: root,
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    shell: true,
    encoding: "utf8",
  });
  return result;
}

export function ensureAwsIdentity() {
  let check = runAws(["sts", "get-caller-identity"], { inherit: false });
  if (check.status === 0) return;

  console.log("AWS credentials not ready; running 'aws login'...");
  const login = runAws(["login"]);
  if (login.status !== 0) throw new Error("aws login failed");

  check = runAws(["sts", "get-caller-identity"], { inherit: false });
  if (check.status !== 0) throw new Error("Still not authenticated after aws login");
}

/**
 * Sync Export/VersionN to S3 and verify the live asset version.
 * @param {{ localDir: string, version: string, bucket?: string, prefix?: string }} opts
 */
export async function syncToS3({
  localDir,
  version,
  bucket = DEFAULT_S3_BUCKET,
  prefix = DEFAULT_S3_PREFIX,
}) {
  let s3Prefix = prefix;
  if (!s3Prefix.endsWith("/")) s3Prefix += "/";
  const s3Root = `s3://${bucket}/${s3Prefix}`;

  console.log(`Uploading ${localDir} → ${s3Root}`);

  let result = runAws([
    "s3",
    "sync",
    localDir,
    s3Root,
    "--delete",
    "--exclude",
    "index.html",
    "--exclude",
    "*.json.gz",
    "--cache-control",
    "public, max-age=31536000, immutable",
  ]);
  if (result.status !== 0) throw new Error("s3 sync (assets) failed");

  const hasGzip = readdirSync(localDir).some((name) => name.endsWith(".json.gz"));
  if (hasGzip) {
    result = runAws([
      "s3",
      "sync",
      localDir,
      s3Root,
      "--exclude",
      "*",
      "--include",
      "*.json.gz",
      "--content-type",
      "application/gzip",
      "--cache-control",
      "public, max-age=31536000, immutable",
    ]);
    if (result.status !== 0) throw new Error("s3 sync (json.gz) failed");
  }

  result = runAws([
    "s3",
    "cp",
    join(localDir, "index.html"),
    `${s3Root}index.html`,
    "--cache-control",
    "public, max-age=60",
    "--content-type",
    "text/html; charset=utf-8",
  ]);
  if (result.status !== 0) throw new Error("s3 cp index.html failed");

  const publicUrl = `https://${bucket}/${s3Prefix}index.html`;
  console.log(`Verifying remote version at ${publicUrl} ...`);
  const response = await fetch(publicUrl, {
    headers: { "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Post-upload verification failed: HTTP ${response.status} for ${publicUrl}`);
  }
  const remoteHtml = await response.text();
  const versionRe = new RegExp(
    `__MANDELBROT_ASSET_VERSION__\\s*=\\s*["']${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
  );
  if (!versionRe.test(remoteHtml)) {
    throw new Error(
      `Post-upload verification failed: expected asset version ${version} in ${publicUrl}`,
    );
  }
  console.log(`Remote index.html reports asset version ${version}.`);
  console.log(`Live URL: https://${bucket}/${s3Prefix}`);
}

export function resolveS3Target(argv = process.argv.slice(2)) {
  let bucket = process.env.S3_BUCKET || DEFAULT_S3_BUCKET;
  let prefix = process.env.S3_PREFIX || DEFAULT_S3_PREFIX;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--bucket" && argv[i + 1]) bucket = argv[++i];
    else if (arg === "--prefix" && argv[i + 1]) prefix = argv[++i];
    else if (arg.startsWith("--bucket=")) bucket = arg.slice("--bucket=".length);
    else if (arg.startsWith("--prefix=")) prefix = arg.slice("--prefix=".length);
  }
  return { bucket, prefix };
}
