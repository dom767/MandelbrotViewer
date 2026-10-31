#!/usr/bin/env node
// @ts-check
/**
 * Deploy Local — serve the latest Build on this machine, as it will ship (no rebuild).
 * Stamps b<k>-local into a copy (Export/Build<k>-local), opens a static server on it in its own
 * window and returns. Closing that window stops it (see guidelines/repository-commands.md).
 */
import path from "node:path";
import { describe, exportRoot, latestBuild, openWindow, stampCopy } from "./lib/build.mjs";

// Mandelbrot's reserved port (ports.md), the same one StartServer.cmd uses.
const port = Number(process.env.PORT) || 10001;

try {
  const build = latestBuild();
  console.log(`Deploy Local: ${describe(build)}`);
  const dir = stampCopy(build.dir, path.join(exportRoot, `Build${build.build}-local`), `b${build.build}-local`, { replace: true });
  openWindow(`Build ${build.build} on port ${port}`, `npx --yes serve -l ${port} --no-port-switching "${dir}"`);
  console.log(`Serving ${dir} on http://127.0.0.1:${port}/ in a new window. Close it to stop.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
