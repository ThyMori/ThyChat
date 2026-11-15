#!/usr/bin/env node
// Construit le site dans dist/ : chaque fichier de js/ (.js ou .ts) est transformé en JavaScript par esbuild,
// SANS regroupement et avec les mêmes noms (js/xxx.js) ; le reste est copié tel quel.
// Ainsi la liste SHELL de sw.js et la structure des modules ne changent pas.
//
//   node scripts/build.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist");

// Fichiers et dossiers copiés sans changement.
const STATIC = ["index.html", "sw.js", "manifest.webmanifest", "CNAME", "css", "fonts", "icons"];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "js"), { recursive: true });

for (const name of STATIC) {
  const from = path.join(root, name);
  if (!fs.existsSync(from)) {
    if (name === "CNAME") continue;
    throw new Error(`Fichier manquant : ${name}`);
  }
  fs.cpSync(from, path.join(out, name), { recursive: true });
}

let count = 0;
for (const file of fs.readdirSync(path.join(root, "js"))) {
  if (!/\.(js|ts)$/.test(file) || file.endsWith(".d.ts")) continue;
  const source = fs.readFileSync(path.join(root, "js", file), "utf8");
  const result = await transform(source, {
    loader: file.endsWith(".ts") ? "ts" : "js",
    format: "esm",
    target: "es2022",
    sourcefile: `js/${file}`,
  });
  fs.writeFileSync(path.join(out, "js", file.replace(/\.ts$/, ".js")), result.code);
  count++;
}
console.log(`Build : ${count} fichiers JavaScript dans dist/`);
