#!/usr/bin/env node
// Lance tous les fichiers *.test.mjs en parallèle (chacun dans son processus) et résume.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort();
const LIMIT = 6; // nombre de tests en même temps
let next = 0;
const failed = [];

function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, file)], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 115000);
    child.on("close", (code) => {
      clearTimeout(timer);
      console.log(`${code === 0 ? "ok  " : "ECHEC"} ${file}`);
      if (code !== 0) failed.push({ file, output });
      resolve();
    });
  });
}

await Promise.all(Array.from({ length: LIMIT }, async () => {
  while (next < files.length) await runOne(files[next++]);
}));

for (const f of failed) console.log(`\n--- ${f.file} ---\n${f.output.split("\n").filter((l) => !l.startsWith("Not implemented")).slice(-25).join("\n")}`);
console.log(`\n${files.length - failed.length}/${files.length} fichiers de test réussis`);
process.exit(failed.length ? 1 : 0);
