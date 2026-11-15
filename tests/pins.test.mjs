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
f.db.users.push({ id: "u2", email: "b@x.fr" });
f.db.profiles.push({ id: "u1", display_name: "Thierry" }, { id: "u2", display_name: "Bea" });
f.db.workspaces.push({ id: "w1", name: "Cie", created_by: "u1", theme: "violet" });
f.db.workspace_members.push({ workspace_id: "w1", user_id: "u1", role: "user" }, { workspace_id: "w1", user_id: "u2", role: "user" });
f.db.rooms.push({ id: "r1", workspace_id: "w1", name: "Hamlet", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
f.db.channels.push({ id: "c1", workspace_id: "w1", room_id: "r1", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
const m = (id, user, body, at, extra = {}) => ({ id, channel_id: "c1", user_id: user, parent_id: null, pinned: false, edited_at: null, body, created_at: at, ...extra });
const now = Date.now();
const at = (n) => new Date(now - n * 60000).toISOString();
f.db.messages.push(
  m("m1", "u2", "Rendez-vous 18h", at(50)),
  m("m2", "u1", "Plan de feu v3", at(40)),
  m("m3", "u2", "", at(30), { attachments: [{ path: "p/photo.jpg", w: 100, h: 80 }] }),
  m("m4", "u2", "Quatrième", at(20)),
  m("m5", "u1", "Dernier", at(10))
);
const chat = createChat({ supabase: f, user: me });
await chat.start(); await openLast(); await tick(150);
const open = async () => { const c = $$("#channel-list .channel-item, .channel-item").find((n) => n.textContent.includes("Tous")); if (c) c.click(); await tick(120); };
await open();

assert.equal($("#pin-bar").hidden, true); ok("aucun bandeau sans épingle");

const select = async (id) => { $(`.msg[data-id="${id}"] .bubble`).click(); await tick(); };
const act = (id, a) => $(`.msg[data-id="${id}"] [data-action="${a}"]`);

// épingler un texte (message d'un autre) : 7 jours
await select("m1");
assert.ok(act("m1", "pin"), "action Épingler"); assert.ok(!act("m1", "unpin"));
assert.equal(act("m1", "pin").title, "Épingler");
act("m1", "pin").click(); await tick();
assert.equal($("#dialog-pin").hasAttribute("open"), true);
assert.deepEqual($$("#pin-choices button").map((b) => b.textContent), ["24 heures", "7 jours", "30 jours"]);
$$("#pin-choices button")[1].click(); await tick(200);
assert.equal($("#pin-bar").hidden, false);
assert.match($("#pin-bar").textContent, /Message épinglé/);
assert.match($("#pin-bar").textContent, /Bea : Rendez-vous 18h/);
const pin = f.db.message_pins[0];
assert.equal(Math.round((new Date(pin.expires_at) - new Date(pin.pinned_at)) / 3600000), 168);
assert.ok($(`.msg[data-id="m1"]`).classList.contains("pinned")); ok("épingler un message pour 7 jours : bandeau + repère");

// photo
await select("m3"); act("m3", "pin").click(); await tick();
$$("#pin-choices button")[0].click(); await tick(200);
assert.match($("#pin-bar").textContent, /1\/2/); assert.match($("#pin-bar").textContent, /📷 Photo/);
ok("épingler une photo : bandeau 1/2 avec « Photo »");

// toucher le bandeau : va au message et passe à l'épingle suivante
$("#pin-bar").click(); await tick(100);
assert.match($("#pin-bar").textContent, /2\/2/);
assert.match($("#pin-bar").textContent, /Rendez-vous/);
ok("toucher le bandeau passe à l'épingle suivante");

// 4e épingle : la plus ancienne est détachée, max 3
await select("m2"); act("m2", "pin").click(); await tick();
assert.match($("#pin-note").textContent, /le plus ancien sera détaché|^Le message reste/);
$$("#pin-choices button")[2].click(); await tick(200);
await select("m4"); act("m4", "pin").click(); await tick();
assert.match($("#pin-note").textContent, /3 messages épinglés/);
$$("#pin-choices button")[1].click(); await tick(250);
assert.equal(f.db.message_pins.length, 3);
assert.ok(!f.db.message_pins.some((p) => p.message_id === "m1"), "la plus ancienne est partie");
assert.match($("#pin-bar").textContent, /1\/3/);
ok("trois épingles au plus : la plus ancienne est détachée");

// détacher
await select("m4");
assert.ok(act("m4", "unpin")); assert.equal(act("m4", "unpin").title, "Détacher");
act("m4", "unpin").click(); await tick(200);
assert.equal(f.db.message_pins.length, 2);
assert.ok(!$(`.msg[data-id="m4"]`).classList.contains("pinned"));
assert.match($("#pin-bar").textContent, /\/2/);
ok("détacher un message");

// expiration côté client
f.db.message_pins[0].expires_at = new Date(Date.now() - 1000).toISOString();
await f.rpc("unpin_message", { msg: "m4" }); await tick(400); // déclenche un rechargement temps réel
assert.doesNotMatch($("#pin-bar").textContent, /\//);
assert.equal(f.db.message_pins.length, 2);
assert.equal($$(".msg.pinned").length, 1); ok("une épingle expirée disparaît");

// temps réel : une autre personne épingle
f.db.message_pins.push({ message_id: "m5", channel_id: "c1", pinned_by: "u2", pinned_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() });
f.db.message_pins = f.db.message_pins.filter((p) => p.expires_at > new Date().toISOString());
await f.rpc("unpin_message", { msg: "m4" }); await tick(400);
assert.ok($(`.msg[data-id="m5"]`).classList.contains("pinned")); ok("épingle posée par une autre personne visible");

// accessibilité du bandeau + vue calendrier
assert.equal($("#pin-bar").tagName, "BUTTON");
chat.stop();
console.log(`\n${passed} vérifications OK`);
process.exit(0);
