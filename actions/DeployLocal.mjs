#!/usr/bin/env node
// @ts-check
/**
 * Deploy Local — local export (no release claim) then serve Export/Version… here.
 * ScreenGrabber SDK refresh is part of the packager run.
 * See guidelines/repository-commands.md.
 */
import { runPackager, serveExport } from "../scripts/repo-actions.mjs";

const manifest = runPackager({ release: false });
console.log("");
console.log(`Latest export: ${manifest.version} (${manifest.localDir})`);
serveExport(manifest.localDir);
