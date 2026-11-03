#!/usr/bin/env node
// @ts-check
/**
 * Deploy Local — package a fresh build into Export/Local stamped 0.0.C, serve it on this machine
 * in its own window, and return. Never claims a release number. See guidelines/export.md.
 *
 * packageBuild in actions/lib/build.mjs must be filled in by the app.
 */
import path from "node:path";
import {
  describe,
  exportRoot,
  openWindow,
  packageBuild,
  prepareDir,
  requireClean,
  root,
  writeManifest,
} from "./lib/build.mjs";
import { commitCount, formatVersion, sourceOf } from "../scripts/release-version.mjs";

// Change this to the app's reserved default port (ports.md), the same one StartServer.cmd uses.
const port = Number(process.env.PORT) || 10001;

const source = sourceOf(root);
requireClean(source);
const c = commitCount(root);
const version = formatVersion(0, c);
console.log(`Deploy Local: ${describe(version, source)}`);

const dir = prepareDir(path.join(exportRoot, "Local"), { replace: true });
await packageBuild({ dir, version });
writeManifest(dir, { version, n: 0, c, source });

openWindow(`Local ${version} on port ${port}`, `npx --yes serve -l ${port} --no-port-switching "${dir}"`);
console.log(`Serving ${dir} on http://127.0.0.1:${port}/ in a new window. Close it to stop.`);
