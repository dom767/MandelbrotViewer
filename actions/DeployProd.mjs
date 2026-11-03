#!/usr/bin/env node
// @ts-check
/** Humans only: claim N, package 0.N.C, upload assets then HTML and verify live version. */
import path from "node:path";
import {
  compareToLocal, describe, exportRoot, highestRelease, packageBuild, prepareDir,
  requireClean, root, writeManifest,
} from "./lib/build.mjs";
import { assertHeadOnUpstream, claimVersion, commitCount, formatVersion, sourceOf } from "../scripts/release-version.mjs";
import { ensureAwsIdentity, resolveS3Target, syncToS3 } from "../scripts/repo-actions.mjs";

try {
  const source = sourceOf(root);
  requireClean(source);
  assertHeadOnUpstream(root);
  const c = commitCount(root);
  const { bucket, prefix } = resolveS3Target();
  ensureAwsIdentity();
  const n = claimVersion(root, { floor: highestRelease() });
  const version = formatVersion(n, c);
  console.log(`Deploy Prod: ${describe(version, source)}`);
  const dir = prepareDir(path.join(exportRoot, `Version${n}`));
  await packageBuild({ dir, version });
  const manifest = writeManifest(dir, { version, n, c, source });
  compareToLocal(manifest);
  await syncToS3({ localDir: dir, version, bucket, prefix });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
