#!/usr/bin/env node
// Writes dist/build-info.json after `tsc`: the commit this build is from and when it was built.
// The commit is BUILD_SHA or CI_COMMIT_SHA when set (CI, `docker build --build-arg BUILD_SHA=...`), else
// `git rev-parse HEAD` when this is a git checkout, else null. No dependencies.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clean = (v) => (typeof v === "string" && /^[0-9a-f]{7,40}$/i.test(v.trim()) ? v.trim().toLowerCase() : null);

function git() {
  try {
    return clean(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }));
  } catch {
    return null;
  }
}

const commit = clean(process.env.BUILD_SHA) ?? clean(process.env.CI_COMMIT_SHA) ?? git();
const info = { commit, built_at: new Date().toISOString() };
mkdirSync(path.join(root, "dist"), { recursive: true });
writeFileSync(path.join(root, "dist", "build-info.json"), JSON.stringify(info, null, 2) + "\n");
console.log(`build-info: commit ${commit ?? "unknown"}, built ${info.built_at}`);
