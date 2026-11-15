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

const chat = createChat({ supabase: f, user: me });
await chat.start(); await openLast(); await tick(150);
const dlg = $("#dialog-help");
dlg.getBoundingClientRect = () => ({ left: 50, right: 350, top: 100, bottom: 500 });
const ev = (type, x, y, target = dlg) => target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
const tap = (x, y, target = dlg) => { ev("pointerdown", x, y, target); ev("click", x, y, target); };

$("#open-help").click(); await tick(40);
assert.ok(dlg.hasAttribute("open"));
tap(200, 300); await tick(10);
assert.ok(dlg.hasAttribute("open"), "appui dans la fenêtre : reste ouverte"); ok("appui à l'intérieur : la fenêtre reste ouverte");
const inner = dlg.querySelector("h3");
tap(10, 10, inner); await tick(10);
assert.ok(dlg.hasAttribute("open"), "appui sur un enfant : reste ouverte"); ok("appui sur un élément de la fenêtre : reste ouverte");
ev("pointerdown", 200, 300); ev("click", 10, 10); await tick(10);
assert.ok(dlg.hasAttribute("open"), "geste commencé dedans : reste ouverte"); ok("glisser de l'intérieur vers l'extérieur : reste ouverte");
tap(10, 10); await tick(10);
assert.equal(dlg.hasAttribute("open"), false, "appui à l'extérieur : fermée"); ok("appui à l'extérieur : la fenêtre se ferme");

// une To-Do ouverte se referme de la même façon
f.db.postits.push({ id: "t1", channel_id: "c1", user_id: "u1", kind: "todo", body: "Liste", items: [{ t: "A", done: false }], created_at: "2026-11-14T08:00:00.000Z" });
chat.stop();
const again = createChat({ supabase: f, user: me });
await again.start(); await openLast(); await tick(150);
const c = [...document.querySelectorAll(".channel-item")].find((n) => n.textContent.includes("Tous")); if (c) c.click(); await tick(150);
$('#postit-wall [data-id="t1"]').click(); await tick(450);
const read = $("#dialog-postit-read");
assert.ok(read.hasAttribute("open"));
read.getBoundingClientRect = () => ({ left: 40, right: 360, top: 80, bottom: 520 });
tap(5, 5, read); await tick(60);
assert.equal(read.hasAttribute("open"), false); ok("la feuille To-Do / Post-it se ferme par un appui à l'extérieur");
again.stop();
console.log(`\n${passed} vérifications OK`);
process.exit(0);
