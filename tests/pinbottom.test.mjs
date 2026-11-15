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
f.db.profiles.push({ id: "u1", display_name: "Thierry" });
f.db.workspaces.push({ id: "w1", name: "Cie", created_by: "u1", theme: "violet" });
f.db.workspace_members.push({ workspace_id: "w1", user_id: "u1", role: "admin" });
f.db.rooms.push({ id: "r1", workspace_id: "w1", name: "Hamlet", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
f.db.channels.push({ id: "c1", workspace_id: "w1", room_id: "r1", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
for (let i = 0; i < 30; i++) f.db.messages.push({ id: "m" + i, channel_id: "c1", user_id: "u1", parent_id: null, pinned: false, edited_at: null, body: "Message " + i, created_at: new Date(Date.now() - (60 - i) * 60000).toISOString() });
// un message épinglé (le tout premier : très ancien dans le fil)
f.db.message_pins.push({ message_id: "m0", channel_id: "c1", pinned_by: "u1", pinned_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() });

// Mise en page simulée : la zone des messages perd la hauteur du bandeau quand il est visible (comme à l'écran).
const box = $("#messages");
let top = 0;
const CONTENT = 2000, FULL = 500, BAR = 90;
Object.defineProperty(box, "scrollHeight", { get: () => CONTENT, configurable: true });
Object.defineProperty(box, "clientHeight", { get: () => FULL - ($("#pin-bar").hidden ? 0 : BAR), configurable: true });
Object.defineProperty(box, "scrollTop", { get: () => top, set: (v) => { top = Math.min(v, CONTENT - (FULL - ($("#pin-bar").hidden ? 0 : BAR))); }, configurable: true });

const chat = createChat({ supabase: f, user: me });
await chat.start(); await tick(150);
const item = document.querySelector("#channel-list .channel-item"); item.click(); await tick(300);
assert.equal($("#pin-bar").hidden, false, "bandeau affiché");
const gap = () => CONTENT - box.scrollTop - box.clientHeight;
assert.ok(gap() < 5, "ouverture du fil : positionné tout en bas malgré le message épinglé (écart " + gap() + ")"); ok("fil ouvert avec un message épinglé : positionné en bas");
chat.stop();
console.log(`\n${passed} vérifications OK`);
process.exit(0);
