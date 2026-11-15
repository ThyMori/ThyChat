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
let passed = 0; const ok = (n) => console.log("  ✓", n) || passed++;
const me = { id: "u1", email: "u1@x.fr", user_metadata: {} };

const f = makeFake(me);
f.db.profiles.find((p) => p.id === "u1").is_super_admin = true;
f.db.workspaces.push({ id: "w1", name: "Ma Cie", created_by: "u1", theme: "violet" }, { id: "w2", name: "Cie Orpheline", created_by: "u2", theme: "teal" }, { id: "w3", name: "Cie B", created_by: "u2", theme: "teal" });
f.db.workspace_members.push({ workspace_id: "w1", user_id: "u1", role: "admin" }, { workspace_id: "w3", user_id: "u2", role: "admin" }, { workspace_id: "w2", user_id: "u3", role: "member" });
f.db.rooms.push({ id: "r1", workspace_id: "w1", name: "Hamlet", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" }, { id: "r3", workspace_id: "w3", name: "Secret", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
f.db.channels.push({ id: "c1", workspace_id: "w1", room_id: "r1", name: "Général", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" }, { id: "c3", workspace_id: "w3", room_id: "r3", name: "Général", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
f.db.messages.push({ id: "m3", channel_id: "c3", user_id: "u2", body: "confidentiel", attachments: [], created_at: "2026-11-02T00:00:00Z" });

const chat = createChat({ supabase: f, user: me });
await chat.start(); await tick(200);

// 1. le super-administrateur ne voit plus que ses espaces, et rien des autres
const mine = (await f.from("channels").select("id")).data.map((c) => c.id);
assert.deepEqual(mine, ["c1"]); ok("ne lit plus les sous-salons des autres espaces");
const msgs = (await f.from("messages").select("id")).data;
assert.equal(msgs.some((m) => m.id === "m3"), false); ok("ne lit plus leurs messages");

// 2. Plateforme : liste des autres espaces, orphelin signalé
$("#workspace-button").click(); await tick(250);
assert.equal($("#platform-section").hidden, false);
const rows = $$("#platform-list .platform-row");
assert.equal(rows.length, 2, "2 autres espaces : " + rows.length);
assert.ok(rows.find((r) => r.textContent.includes("Cie Orpheline")).classList.contains("orphan")); ok("Plateforme : liste des autres espaces, orphelin signalé");
assert.ok(!rows.find((r) => r.textContent.includes("Cie B")).classList.contains("orphan"));

// 3. Rejoindre l'espace orphelin
rows.find((r) => r.textContent.includes("Cie Orpheline")).querySelector("[data-join-support]").click(); await tick(300);
assert.equal(f.db.workspace_members.some((m) => m.workspace_id === "w2" && m.user_id === "u1" && m.role === "admin"), true); ok("rejoindre comme administrateur");
// 4. pastille Support : seulement dans l'espace rejoint, pas dans celui que j'ai créé
const open = async (name) => { $("#workspace-button").click(); await tick(60); [...document.querySelectorAll("#ws-list .ws-row")].find((b) => b.textContent.includes(name)).click(); await tick(250); $("#open-members").click(); await tick(250); const names = [...document.querySelectorAll("#members-list .member")].map((m) => m.textContent); $("#dialog-members").removeAttribute("open"); return names; };
const joined = await open("Cie Orpheline");
assert.ok(joined.some((t) => /Support/.test(t))); ok("espace rejoint : pastille Support");
const own = await open("Ma Cie");
assert.ok(!own.some((t) => /Support/.test(t))); ok("espace créé : pas de pastille Support");
chat.stop();
console.log(`\n${passed} vérifications OK`);
process.exit(0);
