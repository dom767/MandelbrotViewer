#!/usr/bin/env node
// @ts-check
/**
 * Deploy Prod — claim VERSION, export with --release, S3 sync + verify at mandelbrot/.
 * Humans only (dashboard confirms). Agents must never run this.
 * ScreenGrabber SDK refresh is part of the packager run.
 * See guidelines/repository-commands.md.
 */
import {
  ensureAwsIdentity,
  resolveS3Target,
  runPackager,
  syncToS3,
} from "../scripts/repo-actions.mjs";

const { bucket, prefix } = resolveS3Target();
const manifest = runPackager({ release: true });

console.log("");
console.log(`Latest export: ${manifest.version} (${manifest.localDir})`);
console.log("");

ensureAwsIdentity();
await syncToS3({
  localDir: manifest.localDir,
  version: manifest.version,
  bucket,
  prefix,
});
