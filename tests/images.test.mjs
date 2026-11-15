import fs from "node:fs";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { makeFake } from "./fake.mjs";

const REPO = new URL("../dist", import.meta.url).pathname; // les tests s'exécutent sur le résultat du build
const html = fs.readFileSync(`${REPO}/index.html`, "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
const dom = new JSDOM(html, { url: "https://thychat.thierry-morin.com/" });
const { window } = dom;
window.confirm = () => true;
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, AbortController: window.AbortController });
Object.defineProperty(globalThis, "location", { value: window.location, configurable: true });
Object.defineProperty(globalThis, "history", { value: window.history, configurable: true });
document.getElementById("screen-app").hidden = false;

const { createChat } = await import(`${REPO}/js/messagerie.js`);
const { PALETTE, themeByKey, themeFor, pickUnusedTheme } = await import(`${REPO}/js/themes.js`);
const notify = await import(`${REPO}/js/notify.js`);

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const submit = (form) => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
const change = (node) => node.dispatchEvent(new window.Event("change", { bubbles: true }));
let passed = 0;
const ok = (name) => console.log("  ✓", name) || passed++;
const itemFor = (id) => $(`.channel-item[data-id="${id}"]`);
const names = (sel) => $$(sel).map((n) => n.querySelector(".channel-name").textContent);
const resetDom = () => {
  localStorage.clear();
  for (const d of $$("dialog")) d.removeAttribute("open");
  $("#messages").replaceChildren();
};
const msg = (id, channel, user, body, at) => ({
  id, channel_id: channel, user_id: user, parent_id: null, pinned: false, edited_at: null, body, created_at: at,
});




const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };

const thierry = { id: "u1", email: "me@x.fr", user_metadata: {} };
const f = makeFake(thierry);
f.db.workspaces.push({ id: "w1", name: "Compagnie", created_by: "u1", theme: "violet" });
f.db.workspace_members.push({ workspace_id: "w1", user_id: "u1", role: "admin" });
f.db.rooms.push({ id: "r1", workspace_id: "w1", name: "Hamlet", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
//, workspace_id: "w1", name: "Lear", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
f.db.channels.push({ id: "c1", workspace_id: "w1", room_id: "r1", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
//, workspace_id: "w1", room_id: "r2", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
const chat = createChat({ supabase: f, user: thierry });
await chat.start(); await openLast();
await tick(100);


// Simulations navigateur : image, canvas, URL d'aperçu
globalThis.createImageBitmap = async () => ({ width: 3200, height: 2400, close() {} });
window.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, drawImage() {}, set fillStyle(v) {} });
window.HTMLCanvasElement.prototype.toBlob = function (cb, type) { cb(new window.Blob([new Uint8Array(10)], { type })); };
let urlN = 0;
const revoked = [];
URL.createObjectURL = () => `blob:test/${++urlN}`;
URL.revokeObjectURL = (u) => revoked.push(u);
const png = () => new window.File([new Uint8Array(4)], "a.png", { type: "image/png" });

const pasteEvent = (files, text = "") => {
  const e = new window.Event("paste", { bubbles: true, cancelable: true });
  e.clipboardData = { files, getData: () => text };
  $("#composer-input").dispatchEvent(e);
  return e;
};

// menu « + »
assert.equal($("#attach-menu").hidden, true);
$("#composer-attach").click();
assert.equal($("#attach-menu").hidden, false);
assert.equal($("#composer-attach").getAttribute("aria-expanded"), "true");
assert.ok($("#attach-photo") && $("#attach-camera"));
$("#composer-attach").click();
assert.equal($("#attach-menu").hidden, true);
ok("bouton « + » : menu Photo / Prendre une photo");

// choix d'un fichier par l'input
Object.defineProperty($("#file-photo"), "files", { value: [png()], configurable: true });
change($("#file-photo"));
await tick(60);
assert.equal($$("#composer-images .pending-image").length, 1);
assert.equal($("#composer-extra").hidden, false);
ok("une photo choisie apparaît en miniature");

// collage d'une image
let e = pasteEvent([png()]);
await tick(60);
assert.equal(e.defaultPrevented, true);
assert.equal($$("#composer-images .pending-image").length, 2);
// collage de texte : comportement normal
e = pasteEvent([], "bonjour");
assert.equal(e.defaultPrevented, false);
ok("coller une image du presse-papier l'ajoute ; le texte reste normal");

// limite de 4
pasteEvent([png(), png(), png()]);
await tick(80);
assert.equal($$("#composer-images .pending-image").length, 4);
$("#composer-images .pending-image .icon-btn").click();
assert.equal($$("#composer-images .pending-image").length, 3);
assert.equal(revoked.length, 1);
ok("4 photos au plus ; la croix retire une photo");

// envoi photos seules (sans texte)
submit($("#composer"));
await tick(120);
const sent = f.db.messages[f.db.messages.length - 1];
assert.equal(sent.body, "");
assert.equal(sent.attachments.length, 3);
assert.ok(sent.attachments.every((a) => a.path.startsWith("c1/") && a.path.endsWith(".jpg") && a.w === 1600 && a.h === 1200));
assert.equal(f.storage.files.size, 3);
assert.equal($$("#composer-images .pending-image").length, 0);
assert.equal($("#composer-extra").hidden, true);
const imgs = $$("#messages .msg-images img");
assert.equal(imgs.length, 3);
assert.match(imgs[0].src, /object\/sign\/message-images\/c1\//);
ok("message à photos seules : réduit à 1600 px, envoyé, affiché");

// texte + photo, puis réponse à un message-photo
pasteEvent([png()]);
await tick(60);
$("#composer-input").value = "Voici le plan";
submit($("#composer"));
await tick(120);
assert.equal(f.db.messages[f.db.messages.length - 1].body, "Voici le plan");
$$("#messages .msg")[0].querySelector(".bubble").click();
await tick(30);
$("#messages [data-action='reply']").click();
assert.match($("#reply-excerpt").textContent, /📷 Photo/);
$("#reply-cancel").click();
ok("répondre à un message-photo cite « 📷 Photo »");

// agrandissement
imgs[0].click();
assert.ok($("#dialog-image").hasAttribute("open"));
assert.equal($("#lightbox-img").src, imgs[0].src);
$("#lightbox-close").click();
assert.ok(!$("#dialog-image").hasAttribute("open"));
ok("toucher une photo l'ouvre en grand");

// échec d'insertion : les fichiers envoyés sont retirés
const before = f.storage.files.size;
pasteEvent([png()]);
await tick(60);
const origInsert = f.from;
f.from = (t) => { const b = origInsert.call(f, t); if (t === "messages") { const i = b.insert; b.insert = () => { const q = i.call(b, { channel_id: "c-autre" }); return q; }; } return b; };
submit($("#composer"));
await tick(120);
f.from = origInsert;
assert.equal(f.storage.files.size, before, "fichiers orphelins nettoyés");
assert.equal($$("#composer-images .pending-image").length, 1, "la photo reste en attente");
ok("si l'envoi échoue, rien ne reste dans le stockage");

// suppression : fichiers retirés
const del = f.db.messages.find((m) => m.attachments && m.attachments.length === 3);
const n0 = f.storage.files.size;
$$("#messages .msg")[0].querySelector(".bubble").click();
await tick(30);
$("#messages .msg-del").click();
await tick(120);
assert.equal(f.storage.files.size, n0 - 3);
ok("supprimer le message supprime ses photos");

chat.stop();
console.log(`\n${passed} vérifications réussies`);
