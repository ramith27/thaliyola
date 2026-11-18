#!/usr/bin/env node
// pnpm version:bump <major|minor|patch|x.y.z> [--no-changelog] [--dry-run] [--root <dir>]
//
// Sets Thaliyola's one product version in package.json, apps/server/package.json and apps/web/package.json, and
// starts the new version's section in CHANGELOG.md: what is under "## Unreleased" moves under "## x.y.z (today)",
// and an empty "## Unreleased" stays on top for what comes next. A version that already has a section is left alone,
// so running it twice changes nothing the second time. No dependencies.
//
// Cutting the version the packages are already at (they're set while it's prepared): pass that version, e.g.
// `pnpm version:bump 1.0.0`. Bumping past a version whose notes are still under "Unreleased" is refused, so they
// aren't filed under the wrong version.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const PACKAGES = ["package.json", "apps/server/package.json", "apps/web/package.json"];

function fail(message) {
  console.error(`version:bump: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--") && a !== "--root"));
const rootAt = args.indexOf("--root");
const root = rootAt >= 0 ? path.resolve(args[rootAt + 1] ?? ".") : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--root");
for (const f of flags) if (!["--no-changelog", "--dry-run"].includes(f)) fail(`unknown option ${f}`);
if (!target) fail("usage: pnpm version:bump <major|minor|patch|x.y.z> [--no-changelog] [--dry-run]");

const parse = (v) => {
  const m = SEMVER.exec(String(v ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const read = (rel) => {
  const file = path.join(root, rel);
  if (!existsSync(file)) fail(`${rel} not found under ${root}`);
  return { file, text: readFileSync(file, "utf8") };
};

const pkgs = PACKAGES.map((rel) => ({ rel, ...read(rel) })).map((p) => ({ ...p, json: JSON.parse(p.text) }));
// The root's version leads; before it had one, the server's did.
const currentText = pkgs.find((p) => parse(p.json.version))?.json.version ?? "0.0.0";
const current = parse(currentText);

let next;
if (target === "major") next = [current[0] + 1, 0, 0];
else if (target === "minor") next = [current[0], current[1] + 1, 0];
else if (target === "patch") next = [current[0], current[1], current[2] + 1];
else {
  next = parse(target);
  if (!next) fail(`'${target}' is not major, minor, patch or a version like 1.2.3`);
}
const version = next.join(".");
const same = compare(next, current) === 0;
if (compare(next, current) < 0) fail(`${version} is older than the current version ${currentText}`);

const dry = flags.has("--dry-run");
const changed = [];

const changelogFile = path.join(root, "CHANGELOG.md");
const changelogBefore = flags.has("--no-changelog") ? null : existsSync(changelogFile) ? readFileSync(changelogFile, "utf8") : "# Changelog\n";
if (changelogBefore !== null && !same && hasUnreleasedNotes(changelogBefore) && !hasSection(changelogBefore, currentText)) {
  fail(
    `CHANGELOG.md's Unreleased notes belong to ${currentText}, which has no section yet. Cut it first with ` +
      `\`pnpm version:bump ${currentText}\`, then bump to ${version}.`,
  );
}

/** Sets "version" (right after "name" when the file had none), keeping the file's two-space layout. */
function withVersion(json) {
  if (json.version === version) return json;
  if ("version" in json) return { ...json, version };
  const out = {};
  for (const [k, v] of Object.entries(json)) {
    out[k] = v;
    if (k === "name") out.version = version;
  }
  if (!("version" in out)) return { version, ...json };
  return out;
}

for (const p of pkgs) {
  const json = withVersion(p.json);
  if (json === p.json) continue;
  const text = JSON.stringify(json, null, 2) + "\n";
  if (!dry) writeFileSync(p.file, text);
  changed.push(p.rel);
}

function hasSection(changelog, v) {
  const re = new RegExp(`^##\\s+\\[?v?${v.replace(/\./g, "\\.")}\\]?(\\s|$)`, "i");
  return changelog.split("\n").some((l) => re.test(l));
}

/** Whether "## Unreleased" has anything under it. */
function hasUnreleasedNotes(changelog) {
  const lines = changelog.split("\n");
  const at = lines.findIndex((l) => /^##\s+\[?unreleased\]?\s*$/i.test(l));
  if (at < 0) return false;
  const end = lines.findIndex((l, i) => i > at && /^##\s+/.test(l));
  return lines.slice(at + 1, end < 0 ? lines.length : end).some((l) => l.trim() !== "");
}

/** "## Unreleased" becomes "## x.y.z (date)" under a fresh, empty "## Unreleased". */
export function startSection(changelog, v, today) {
  const lines = changelog.split("\n");
  const heading = (l) => /^##\s+/.test(l);
  if (hasSection(changelog, v)) return changelog;
  const unreleased = lines.findIndex((l) => /^##\s+\[?unreleased\]?\s*$/i.test(l));
  if (unreleased >= 0) {
    lines.splice(unreleased, 1, "## Unreleased", "", `## ${v} (${today})`);
    return lines.join("\n");
  }
  // No Unreleased section: a new, empty section above the newest one (or after the title).
  const first = lines.findIndex(heading);
  const at = first >= 0 ? first : lines.length;
  lines.splice(at, 0, "## Unreleased", "", `## ${v} (${today})`, "");
  return lines.join("\n");
}

if (changelogBefore !== null) {
  const after = startSection(changelogBefore, version, new Date().toISOString().slice(0, 10));
  if (after !== changelogBefore) {
    if (!dry) writeFileSync(changelogFile, after);
    changed.push("CHANGELOG.md");
  }
}

if (same && !changed.length) console.log(`Already at ${version}; nothing to change.`);
else if (same) console.log(`${dry ? "Would cut" : "Cut"} ${version}: ${changed.join(", ")}`);
else console.log(`${dry ? "Would set" : "Set"} Thaliyola ${currentText} → ${version}${changed.length ? `: ${changed.join(", ")}` : ""}`);
