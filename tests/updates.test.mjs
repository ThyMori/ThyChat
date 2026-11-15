import assert from "node:assert/strict";
import { watchUpdates } from "../dist/js/updates.js";
let passed = 0;
const ok = (n) => console.log("  ✓", n) || passed++;
const mk = (controller) => {
  const sw = new EventTarget();
  sw.controller = controller;
  const reg = { calls: 0, update() { this.calls++; return Promise.resolve(); } };
  sw.ready = Promise.resolve(reg);
  return { sw, reg };
};
const mkDoc = () => { const d = new EventTarget(); d.visibilityState = "visible"; return d; };
const tick = () => new Promise((r) => setTimeout(r, 5));

{ // mise à jour : le nouveau service worker prend la main alors qu'un ancien contrôlait la page
  const { sw } = mk({}); const doc = mkDoc(); const win = new EventTarget(); let n = 0;
  watchUpdates({ sw, onUpdate: () => n++, doc, win, intervalMs: 1e9 });
  sw.dispatchEvent(new Event("controllerchange"));
  assert.equal(n, 1); ok("nouvelle version : le bandeau est demandé");
}
{ // première installation : pas de bandeau
  const { sw } = mk(null); const doc = mkDoc(); const win = new EventTarget(); let n = 0;
  watchUpdates({ sw, onUpdate: () => n++, doc, win, intervalMs: 1e9 });
  sw.dispatchEvent(new Event("controllerchange"));
  assert.equal(n, 0); ok("première installation : pas de bandeau");
  sw.dispatchEvent(new Event("controllerchange"));
  assert.equal(n, 1); ok("mise à jour suivante : bandeau");
}
{ // vérifications : retour au premier plan, retour en ligne, minuterie
  const { sw, reg } = mk({}); const doc = mkDoc(); const win = new EventTarget();
  const stop = watchUpdates({ sw, onUpdate() {}, doc, win, intervalMs: 20 });
  await tick();
  doc.dispatchEvent(new Event("visibilitychange")); assert.equal(reg.calls, 1); ok("retour sur l'application : vérifie");
  doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange")); assert.equal(reg.calls, 1); ok("en arrière-plan : ne vérifie pas");
  doc.visibilityState = "visible"; win.dispatchEvent(new Event("online")); assert.equal(reg.calls, 2); ok("retour en ligne : vérifie");
  await new Promise((r) => setTimeout(r, 60)); assert.ok(reg.calls >= 3); ok("vérification périodique");
  stop();
  const after = reg.calls; await new Promise((r) => setTimeout(r, 60)); assert.equal(reg.calls, after); ok("arrêt propre");
}
{ // sans service worker : rien ne plante
  const stop = watchUpdates({ sw: null, onUpdate() {} }); stop(); ok("sans service worker");
}
console.log(`\n${passed} vérifications OK`);
process.exit(0);
