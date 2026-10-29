/**
 * Shared helpers for Build / Deploy Local / Deploy Prod (actions/*.mjs).
 * Packager is export-static.mjs (ScreenGrabber SDK refresh included).
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const root = dirname(dirname(fileURLToPath(import.meta.url)));

const DEFAULT_S3_BUCKET = "baffledcat.com";
const DEFAULT_S3_PREFIX = "mandelbrot/";
/** Mandelbrot reserved port when PORT is unset (see AgentController ports.md). */
const DEFAULT_SERVE_PORT = 10001;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".gif": "image/gif",
  ".txt": "text/plain; charset=utf-8",
  ".gz": "application/gzip",
};

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

/**
 * Run the packager. Local builds never claim a release number; --release does.
 * ScreenGrabber SDK refresh happens inside export-static.mjs before bundling.
 * @param {{ release?: boolean }} [opts]
 */
export function runPackager({ release = false } = {}) {
  ensureNodeModules();
  const args = [join(root, "export-static.mjs")];
  if (release) args.push("--release");
  console.log(`Running export-static.mjs${release ? " --release" : ""}...`);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  return readLatestManifest();
}

export function readLatestManifest() {
  const path = join(root, "Export", "latest.json");
  if (!existsSync(path)) {
    throw new Error("Export/latest.json missing after packager run");
  }
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const localDir = join(root, ...String(manifest.dir).replace(/\\/g, "/").split("/"));
  if (!existsSync(localDir)) {
    throw new Error(`Export folder missing: ${localDir}`);
  }
  return { ...manifest, localDir, version: String(manifest.version) };
}

/**
 * Serve a static export folder until the process is stopped.
 * @param {string} directory
 * @param {{ port?: number }} [opts]
 */
export function serveExport(directory, { port } = {}) {
  const listenPort = Number(port ?? process.env.PORT) || DEFAULT_SERVE_PORT;
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error("PORT must be between 1 and 65535.");
  }
  const docRoot = resolve(directory);
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      let file = resolve(docRoot, `.${pathname}`);
      if (file !== docRoot && !file.startsWith(docRoot + sep)) {
        response.writeHead(403).end();
        return;
      }
      if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
      const body = await readFile(file);
      response.writeHead(200, {
        "Content-Type": MIME[extname(file)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      response.writeHead(error instanceof URIError ? 400 : 404).end();
    }
  });
  server.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(listenPort, "127.0.0.1", () => {
    console.log(`Serving ${docRoot}`);
    console.log(`Preview: http://127.0.0.1:${listenPort}/`);
    console.log("Stop with Ctrl+C or close this window.");
  });
  return server;
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
