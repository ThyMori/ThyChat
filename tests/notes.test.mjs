import fs from "node:fs";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { makeFake } from "./fake.mjs";

const REPO = new URL("../dist", import.meta.url).pathname; // les tests s'exécutent sur le résultat du build
const html = fs.readFileSync(`${REPO}/index.html`, "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
const dom = new JSDOM(html, { url: "https://thychat.thierry-morin.com/" });
const { window } = dom;
window.confirm = () => true;
window.HTMLElement.prototype.scrollIntoView = function () {};
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, AbortController: window.AbortController });
Object.defineProperty(globalThis, "location", { value: window.location, configurable: true });
Object.defineProperty(globalThis, "history", { value: window.history, configurable: true });
document.getElementById("screen-app").hidden = false;
const { createChat } = await import(`${REPO}/js/messagerie.js`);
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (n) => console.log("  ✓", n) || passed++;

const me = { id: "u1", email: "me@x.fr", user_metadata: {} };
const f = makeFake(me);
f.db.workspaces.push({ id: "w1", name: "Cie A", created_by: "u1", theme: "violet" }, { id: "w2", name: "Cie B", created_by: "u1", theme: "teal" });
f.db.workspace_members.push({ workspace_id: "w1", user_id: "u1", role: "user" }, { workspace_id: "w2", user_id: "u1", role: "user" }, { workspace_id: "w1", user_id: "u2", role: "admin" });
const room = (id, ws, name) => ({ id, workspace_id: ws, name, description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
f.db.rooms.push(room("r1", "w1", "Hamlet"), room("r2", "w2", "Lear"), room("r3", "w1", "Médée"));
const ch = (id, ws, rm) => ({ id, workspace_id: ws, room_id: rm, name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
f.db.channels.push(ch("c1", "w1", "r1"), ch("c2", "w2", "r2"), ch("c3", "w1", "r3"));
// les notes d'un autre utilisateur : invisibles pour moi comme pour un administrateur
f.db.channels.push({ id: "n-other", workspace_id: "w1", room_id: "r1", name: "notes:z", kind: "notes", everyone: false, owner_id: "u3", description: null, created_at: "2026-11-01T00:00:00Z" });
f.db.messages.push({ id: "m-secret", channel_id: "n-other", user_id: "u3", body: "secret", attachments: [], created_at: "2026-11-02T00:00:00Z" });
const D = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
f.db.tour_tags.push(
  { id: "t1", room_id: "r1", label: "Lyon", start_date: D(20), end_date: D(22), shows: [] },
  { id: "t2", room_id: "r1", label: "Paris", start_date: D(5), end_date: D(6), shows: [] },
  { id: "t3", room_id: "r2", label: "Nice", start_date: D(-30), end_date: D(-28), shows: [] },
  { id: "t4", room_id: "r3", label: "Brest", start_date: D(-1), end_date: D(1), shows: [] },
);
const chat = createChat({ supabase: f, user: me });
await chat.start(); await tick(150);

// 1. bouton dans le menu, à côté de Calendrier ; les notes d'un autre n'apparaissent nulle part
assert.ok($("#open-notes")); assert.match($("#open-notes").textContent, /Mes notes/);
assert.equal($("#open-notes").previousElementSibling.id, "open-todos"); ok("bouton « Mes notes » dans le menu");
assert.ok($("#dialog-notes .help-close"), "croix de fermeture dans « Mes notes »");
assert.equal($$("#channel-list .channel-item").some((b) => b.dataset.id === "n-other"), false); ok("les notes d'un autre n'apparaissent pas");

// 2. sélecteur de spectacle avec recherche
$("#open-notes").click(); await tick(40);
assert.equal($("#dialog-notes").open, true);
assert.deepEqual($$("#notes-list [data-notes-room]").map((b) => b.dataset.notesRoom), ["r3", "r1", "r2"]); ok("classés : en cours, prochaine date, puis passés");
assert.match($$("#notes-list button")[0].textContent, /En cours/); assert.match($$("#notes-list button")[1].textContent, /Prochaine date/); assert.match($$("#notes-list button")[2].textContent, /Dernière date/);
$("#notes-search").value = "medee"; $("#notes-search").dispatchEvent(new window.Event("input", { bubbles: true })); await tick(20);
assert.deepEqual($$("#notes-list [data-notes-room]").map((b) => b.dataset.notesRoom), ["r3"]); ok("recherche insensible aux accents");
$("#notes-search").value = "zzz"; $("#notes-search").dispatchEvent(new window.Event("input", { bubbles: true })); await tick(20);
assert.equal($$("#notes-list [data-notes-room]").length, 0);
$("#notes-search").value = "lear"; $("#notes-search").dispatchEvent(new window.Event("input", { bubbles: true })); await tick(20);

// 3. ouverture d'un spectacle d'un AUTRE espace : création, bascule d'espace, en-tête
$("#notes-list [data-notes-room]").click(); await tick(200);
assert.equal($("#dialog-notes").open, false);
assert.ok(f.calls.rpc.some((c) => c[0] === "open_notes" && c[1].rm === "r2"));
assert.equal($("#channel-title").textContent, "Mes notes");
assert.match($("#channel-desc").textContent, /Lear/); assert.match($("#channel-desc").textContent, /Visible par toi seul/);
assert.match($("#channel-desc").textContent, /notes · 3 \/ 25 Mo/); ok("ouvre Mes notes d'un autre espace, en-tête + consommation");
assert.equal($("#channel-bell").hidden, true);
assert.equal($("#channel-people").hidden, true); ok("pas de sourdine ni de membres");

// 4. envoi d'un message dans mes notes
$("#composer-input").value = "penser aux gélatines"; $("#composer-send").click(); await tick(200);
const saved = f.db.messages.find((m) => m.body === "penser aux gélatines");
assert.ok(saved && saved.channel_id === "n-r2-u1"); ok("message enregistré dans mes notes");

// 5. entrée « Mes notes » dans le spectacle déplié, réutilise le salon existant
const before = f.calls.rpc.filter((c) => c[0] === "open_notes").length;
$("#channel-list .room-group .my-notes-item"); 
const item = $$("#channel-list .my-notes-item").find((b) => b.dataset.notesRoom === "r2");
assert.ok(item, "entrée par spectacle");
item.click(); await tick(120);
assert.equal(f.calls.rpc.filter((c) => c[0] === "open_notes").length, before, "pas de recréation");
assert.equal(state_ok(), true); ok("entrée par spectacle déplié, sans recréer");
function state_ok() { return $("#channel-title").textContent === "Mes notes"; }

// 5b. dates (#) héritées : sous-salon puis Mes notes de Médée (date en cours « Brest »)
f.db.channels.push({ id: "c3b", workspace_id: "w1", room_id: "r3", name: "Technique", kind: "channel", everyone: true, description: null, created_at: "2026-11-02T00:00:00Z" });
$("#open-notes").click(); await tick(30); $("#notes-list [data-notes-room=\"r3\"]").click(); await tick(250);
const open = async (sel) => { const b = $$("#channel-list .channel-item").find(sel); assert.ok(b); b.click(); await tick(150); };
const chev = $(`.room-chev[data-room="r3"]`); if (chev.getAttribute("aria-expanded") !== "true") { chev.click(); await tick(40); }
f.emit("channels", { eventType: "INSERT", new: {} }); await tick(600);
await open((b) => b.dataset.id === "c3b");
assert.equal($("#tag-bar").hidden, false, "sous-salon : barre de dates");
$("#composer-input").value = "dans le sous-salon"; $("#composer-send").click(); await tick(200);
assert.deepEqual(f.db.messages.find((m) => m.body === "dans le sous-salon").tag_ids, ["t4"]); ok("sous-salon : date en cours proposée d'office");
await open((b) => b.dataset.notesRoom === "r3");
assert.equal($("#channel-title").textContent, "Mes notes");
assert.equal($("#tag-bar").hidden, false, "Mes notes : barre de dates");
assert.equal($("#channel-dates").hidden, true, "pas de gestion des dates depuis Mes notes");
$("#composer-input").value = "note datée"; $("#composer-send").click(); await tick(200);
assert.deepEqual(f.db.messages.find((m) => m.body === "note datée").tag_ids, ["t4"]); ok("Mes notes : date en cours proposée d'office");

// 6. retour sur un spectacle normal, puis Mes notes d'un autre spectacle du même espace
$("#open-notes").click(); await tick(30); $("#notes-list [data-notes-room=\"r2\"]").click(); await tick(200);
$$("#channel-list .channel-item").find((b) => b.dataset.id === "c2").click(); await tick(100);
assert.equal($("#channel-title").textContent, "Lear");
assert.equal($("#channel-bell").hidden, false); ok("un sous-salon normal garde sa sourdine");
chat.stop();
console.log(`\n${passed} vérifications OK`);
process.exit(0);
