#!/usr/bin/env node
// @ts-check
/**
 * Run Dev — serve the working tree (no build) on this machine.
 * Opens StartServer.cmd in its own window and returns, so the dashboard isn't left waiting;
 * closing that window stops the server (see guidelines/repository-commands.md).
 */
import fs from "node:fs";
import path from "node:path";
import { openWindow, root } from "./lib/build.mjs";

if (!fs.existsSync(path.join(root, "StartServer.cmd"))) {
  console.error("Run Dev: no StartServer.cmd at the repo root (see guidelines/start-scripts.md).");
  process.exit(1);
}
openWindow(`${path.basename(root)} dev server`, ".\\StartServer.cmd");
console.log(`Run Dev: started StartServer.cmd in a new window (${root}). Close that window to stop it.`);
