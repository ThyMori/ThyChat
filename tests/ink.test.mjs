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



const ctxStub = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) });
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
window.HTMLCanvasElement.prototype.toBlob = function (cb, type) { cb(new window.Blob([new Uint8Array(10)], { type })); };
let urlN = 0;
URL.createObjectURL = () => `blob:test/${++urlN}`;
URL.revokeObjectURL = () => {};
globalThis.createImageBitmap = async () => ({ width: 800, height: 600, close() {} });

const ptr = (type, id, x, y, pt = "touch") => {
  const e = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { pointerId: id, clientX: x, clientY: y, pointerType: pt, button: 0 });
  $("#ink-canvas").dispatchEvent(e);
};

// menu : entrée « Note manuscrite » avec logo
$("#composer-attach").click();
assert.ok($("#attach-ink svg.ink-logo"));
assert.match($("#attach-ink").textContent, /Note manuscrite/);
ok("menu + : entrée Note manuscrite");

$("#attach-ink").click();
assert.equal($("#attach-menu").hidden, true);
assert.ok($("#dialog-ink").hasAttribute("open"));
assert.equal($("#ink-send").disabled, true);
ok("la page s'ouvre, envoi désactivé tant que vide");

// un doigt : un trait
ptr("pointerdown", 1, 10, 10); ptr("pointermove", 1, 40, 40); ptr("pointermove", 1, 80, 30); ptr("pointerup", 1, 80, 30);
assert.equal($("#ink-send").disabled, false);
assert.equal($("#ink-undo").disabled, false);
ok("un doigt dessine un trait");

// deux doigts : pas de trait ajouté
ptr("pointerdown", 2, 100, 100); ptr("pointerdown", 3, 140, 100); ptr("pointermove", 3, 200, 100); ptr("pointerup", 3, 200, 100); ptr("pointerup", 2, 100, 100);
$("#ink-undo").click();
assert.equal($("#ink-send").disabled, true, "deux doigts n'ont pas dessiné : un seul trait, annulé");
$("#ink-redo").click();
assert.equal($("#ink-send").disabled, false);
ok("deux doigts déplacent/zooment sans dessiner ; annuler/rétablir");

// stylet puis doigt = déplacement seulement
ptr("pointerdown", 4, 20, 20, "pen"); ptr("pointermove", 4, 60, 60, "pen"); ptr("pointerup", 4, 60, 60, "pen");
$("#ink-undo").click();
assert.equal($("#ink-send").disabled, false, "le trait au stylet était le 2e");
$("#ink-undo").click();
assert.equal($("#ink-send").disabled, true);
$("#ink-redo").click(); $("#ink-redo").click();
ptr("pointerdown", 5, 20, 20); ptr("pointermove", 5, 90, 90); ptr("pointerup", 5, 90, 90);
$("#ink-undo").click(); $("#ink-undo").click();
assert.equal($("#ink-send").disabled, true, "le doigt après stylet n'a pas ajouté de trait");
$("#ink-redo").click(); $("#ink-redo").click();
ok("après le stylet, le doigt ne dessine plus");

// gomme
$("#ink-eraser").click();
ptr("pointerdown", 6, 10, 10, "pen"); ptr("pointerup", 6, 10, 10, "pen");
$("#ink-eraser").click();
ok("gomme sans erreur");

// couleur / épaisseur
$('[data-ink-color="#c62828"]').click();
$('[data-ink-width="9"]').click();
assert.equal($('[data-ink-color="#c62828"]').getAttribute("aria-pressed"), "true");
ptr("pointerdown", 7, 200, 200, "pen"); ptr("pointermove", 7, 260, 240, "pen"); ptr("pointerup", 7, 260, 240, "pen");
ok("couleur et épaisseur");

// envoi : image jointe au message
$("#ink-send").click();
await tick(100);
assert.equal($("#dialog-ink").hasAttribute("open"), false);
assert.equal(chatPending(), 1);
assert.equal($("#composer-images").hidden, false);
ok("Envoyer joint l'image au message");

function chatPending() { return $$("#composer-images .pending-image").length; }

// annuler une page vide
$("#composer-attach").click(); $("#attach-ink").click();
assert.equal($("#ink-send").disabled, true, "page neuve vide");
$("#ink-cancel").click();
assert.equal($("#dialog-ink").hasAttribute("open"), false);
ok("page neuve vide, annuler ferme");

console.log(`${passed} OK`);
process.exit(0);
