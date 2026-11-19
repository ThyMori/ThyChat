import fs from "node:fs";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const REPO = new URL("../dist", import.meta.url).pathname; // les tests s'exécutent sur le résultat du build
const html = fs.readFileSync(`${REPO}/index.html`, "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
const { window } = new JSDOM(html, { url: "https://thychat.thierry-morin.com/" });
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, Event: window.Event });
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
Object.defineProperty(globalThis, "history", { value: window.history, configurable: true });
const ok = (t) => console.log("ok  ", t);
const { clampCrop, cropRect, panCrop, cropPhoto } = await import(`${REPO}/js/recadrage.js`);

// logique pure : image 400 × 200 (paysage)
const base = { w: 400, h: 200, zoom: 1, cx: 200, cy: 100 };
assert.deepEqual(cropRect(base), { sx: 100, sy: 0, side: 200 }, "zoom 1 : carré central");
assert.equal(clampCrop({ ...base, zoom: 9 }).zoom, 4, "zoom limité à 4");
assert.equal(clampCrop({ ...base, zoom: 0.2 }).zoom, 1, "zoom minimum 1");
assert.equal(clampCrop({ ...base, cx: -50 }).cx, 100, "le cadre ne sort pas à gauche");
assert.equal(clampCrop({ ...base, cx: 999 }).cx, 300, "le cadre ne sort pas à droite");
const moved = panCrop(base, 50, 0, 100); // le doigt va à droite de 50 px sur un cadre de 100 px
assert.equal(moved.cx, 100, "l'image suit le doigt (le centre recule), limité au bord");
const z2 = panCrop({ ...base, zoom: 2 }, -20, 0, 100);
assert.equal(z2.cx, 200 + 20 * (100 / 100), "zoom 2 : 1 px d'écran = 1 px d'origine");
ok("recadrage : zoom, bords et glissement");

// fenêtre : valider rend un JPEG carré, annuler rend null
globalThis.createImageBitmap = async () => ({ width: 400, height: 200, close() {} });
const ctx = { clearRect() {}, drawImage() {} };
window.HTMLCanvasElement.prototype.getContext = () => ctx;
window.HTMLCanvasElement.prototype.toBlob = function (cb, type) { cb(new window.Blob(["x"], { type })); };
const file = new window.Blob(["img"], { type: "image/png" });
let done = cropPhoto(file);
await new Promise((r) => setTimeout(r, 20));
assert.ok(document.getElementById("dialog-crop").hasAttribute("open"));
document.getElementById("crop-ok").click();
const blob = await done;
assert.equal(blob.type, "image/jpeg");
assert.ok(!document.getElementById("dialog-crop").hasAttribute("open"));
done = cropPhoto(file);
await new Promise((r) => setTimeout(r, 20));
document.getElementById("crop-cancel").click();
assert.equal(await done, null);
ok("fenêtre de recadrage : valider donne un JPEG, annuler ne change rien");
