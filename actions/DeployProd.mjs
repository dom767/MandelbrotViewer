#!/usr/bin/env node
// @ts-check
/**
 * Deploy Prod — ship the latest Build: claim VERSION, stamp it into Export/VersionN, sync that to
 * s3://baffledcat.com/mandelbrot/ and verify the live asset version. It never rebuilds, so what
 * goes live is what Deploy Local served.
 * Humans only (dashboard confirms). Agents must never run this.
 * Override the destination with --bucket / --prefix (or S3_BUCKET / S3_PREFIX).
 * See guidelines/repository-commands.md.
 */
import path from "node:path";
import { describe, exportRoot, highestRelease, latestBuild, root, stampCopy } from "./lib/build.mjs";
import { claimVersion } from "../scripts/release-version.mjs";
import { ensureAwsIdentity, resolveS3Target, syncToS3 } from "../scripts/repo-actions.mjs";

try {
  const { bucket, prefix } = resolveS3Target();
  const build = latestBuild();
  console.log(`Deploy Prod: ${describe(build)}`);
  if (build.source?.uncommittedChanges) console.warn("Warning: this build has uncommitted changes in it.");

  // Sign in before claiming a number, so a failed login doesn't use one up.
  ensureAwsIdentity();
  const n = claimVersion(root, { floor: highestRelease() });
  const dir = stampCopy(build.dir, path.join(exportRoot, `Version${n}`), String(n));
  console.log(`Stamped version ${n} into ${dir}`);
  console.log("");

  await syncToS3({ localDir: dir, version: String(n), bucket, prefix });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
