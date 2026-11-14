#!/usr/bin/env node
// Incrémente la version de ThyChat de façon cohérente (version.js, sw.js, CHANGELOG.md).
//
//   node scripts/bump-version.mjs major   "Description"   -> X+1.0.0   changement majeur
//   node scripts/bump-version.mjs feature "Description"   -> X.Y+1.0   nouvelle fonction
//   node scripts/bump-version.mjs fix     "Description"   -> X.Y.Z+1   correction esthétique / petit correctif
//   node scripts/bump-version.mjs --check                 vérifie que les trois fichiers sont d'accord
//
// Plusieurs points dans une même livraison : séparer par « ; » dans la description.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES = { version: "js/version.js", sw: "sw.js", changelog: "CHANGELOG.md" };
const read = (name) => fs.readFileSync(path.join(root, FILES[name]), "utf8");
const write = (name, text) => fs.writeFileSync(path.join(root, FILES[name]), text);

const VERSION_RE = /export const VERSION = "(\d+)\.(\d+)\.(\d+)";/;
const SW_RE = /const VERSION = "(\d+\.\d+\.\d+)";/;
const CHANGELOG_TOP_RE = /^## (\d+\.\d+\.\d+) — /m;

function fail(message) {
  console.error("Erreur : " + message);
  process.exit(1);
}

function currentVersion() {
  const match = read("version").match(VERSION_RE);
  if (!match) fail(`version introuvable dans ${FILES.version}`);
  return match.slice(1, 4).map(Number);
}

function check() {
  const main = currentVersion().join(".");
  const sw = (read("sw").match(SW_RE) || [])[1];
  const top = (read("changelog").match(CHANGELOG_TOP_RE) || [])[1];
  const problems = [];
  if (sw !== main) problems.push(`sw.js : ${sw ?? "absente"} (attendu ${main})`);
  if (top !== main) problems.push(`CHANGELOG.md : première entrée ${top ?? "absente"} (attendu ${main})`);
  if (problems.length) fail("versions incohérentes — " + problems.join(" ; "));
  console.log(`Versions cohérentes : ${main}`);
}

function bump(kind, description) {
  if (!["major", "feature", "fix"].includes(kind)) fail("type attendu : major, feature ou fix");
  if (!description) fail("ajoute une description entre guillemets");

  const [major, feature, fix] = currentVersion();
  const next =
    kind === "major" ? [major + 1, 0, 0] : kind === "feature" ? [major, feature + 1, 0] : [major, feature, fix + 1];
  const version = next.join(".");

  write("version", read("version").replace(VERSION_RE, `export const VERSION = "${version}";`));
  if (!SW_RE.test(read("sw"))) fail(`constante VERSION introuvable dans ${FILES.sw}`);
  write("sw", read("sw").replace(SW_RE, `const VERSION = "${version}";`));

  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Paris" }).format(new Date());
  const items = description
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `- ${part}`)
    .join("\n");
  const entry = `## ${version} — ${date}\n${items}\n\n`;
  const changelog = read("changelog");
  const index = changelog.search(CHANGELOG_TOP_RE);
  write("changelog", index === -1 ? changelog.trimEnd() + "\n\n" + entry : changelog.slice(0, index) + entry + changelog.slice(index));

  console.log(`Version : ${currentVersion().join(".")} (${kind})`);
  check();
}

const [first, ...rest] = process.argv.slice(2);
if (first === "--check") check();
else bump(first, rest.join(" ").trim());
