/**
 * Builds the Vite renderer at the repository root and copies the output into
 * desktop/renderer so electron-builder can package it.
 *
 *   node scripts/bundle-renderer.mjs
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..");
const distDir = path.join(repoRoot, "dist");
const rendererDir = path.join(desktopRoot, "renderer");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

console.log("[renderer] building the web app with vite…");
execFileSync(npm, ["run", "build"], { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" });

if (!existsSync(path.join(distDir, "index.html"))) {
  console.error(`[renderer] ${distDir}/index.html was not produced — check the vite build output.`);
  process.exit(1);
}

rmSync(rendererDir, { recursive: true, force: true });
cpSync(distDir, rendererDir, { recursive: true });
console.log(`[renderer] copied ${distDir} -> ${rendererDir}`);
