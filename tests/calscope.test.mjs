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
f.db.workspace_members.push({ workspace_id: "w1", user_id: "u1", role: "admin" }, { workspace_id: "w2", user_id: "u1", role: "admin" });
f.db.rooms.push({ id: "r1", workspace_id: "w1", name: "Hamlet", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" }, { id: "r2", workspace_id: "w2", name: "Lear", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
f.db.channels.push({ id: "c1", workspace_id: "w1", room_id: "r1", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" }, { id: "c2", workspace_id: "w2", room_id: "r2", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
const chat = createChat({ supabase: f, user: me });
await chat.start(); await tick(150);
$("#open-calendar").click(); await tick(60);
assert.equal($("#calendar").hidden, false);
assert.equal($("#cal-scope").value, "all");
assert.equal($("#cal-scope").selectedOptions[0].textContent, "Tous mes espaces"); ok("le calendrier s'ouvre sur « Tous mes espaces »");
// on choisit un spectacle, on quitte, on rouvre : retour à la vue de base
$("#cal-scope").value = "r1"; $("#cal-scope").dispatchEvent(new window.Event("change", { bubbles: true })); await tick(30);
assert.equal($("#cal-scope").value, "r1");
$(".channel-item.sub, #channel-list .channel-item").click(); await tick(120);
$("#open-calendar").click(); await tick(60);
assert.equal($("#cal-scope").value, "all"); ok("rouvert : toujours « Tous mes espaces »");
chat.stop();
console.log(`\n${passed} vérifications OK`);
process.exit(0);
