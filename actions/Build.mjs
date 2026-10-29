#!/usr/bin/env node
// @ts-check
/**
 * Build — local packager only (no upload, no release-number claim).
 * Runs export-static.mjs, which refreshes the ScreenGrabber SDK before bundling.
 * See guidelines/repository-commands.md.
 */
import { runPackager } from "../scripts/repo-actions.mjs";

const manifest = runPackager({ release: false });
console.log("");
console.log(`Build complete: ${manifest.dir} (version ${manifest.version})`);
console.log(`Smoke-test: node actions/DeployLocal.mjs`);
