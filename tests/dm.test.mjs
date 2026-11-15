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
f.db.workspaces.push({ id: "w2", name: "Studio", created_by: "u1", theme: "bleu" });
f.db.workspace_members.push({ workspace_id: "w2", user_id: "u1", role: "member" });
f.db.profiles.push({ id: "u2", display_name: "Camille", avatar_url: null, is_super_admin: false });
f.db.workspace_members.push({ workspace_id: "w1", user_id: "u2", role: "member" }, { workspace_id: "w2", user_id: "u2", role: "member" });
f.db.rooms.push({ id: "r9", workspace_id: "w2", name: "Cabaret", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
f.db.channels.push({ id: "c9", workspace_id: "w2", room_id: "r9", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });

const chat = createChat({ supabase: f, user: thierry });
await chat.start();
await tick(100);



// discussion privée ouverte depuis l'espace Compagnie
$("#new-dm").click(); await tick(60);
$$("#dm-pick .pick-button").find((b) => b.textContent.includes("Camille")).click();
await tick(120);
const dm = f.db.channels.find((c) => c.kind === "dm");
assert.ok(dm);
assert.equal(dm.workspace_id, "w1");
f.incoming({ id: "m1", channel_id: dm.id, user_id: "u2", parent_id: null, pinned: false, edited_at: null, body: "Coucou", created_at: "2026-11-14T10:00:00.000Z", attachments: [], tag_ids: [] });
await tick(60);

// passage dans l'autre espace : la discussion est toujours là
const goto = async (id) => { $("#workspace-button").click(); await tick(30); $(`.ws-row[data-id="${id}"]`).click(); await tick(150); };
await goto("w2");
assert.match($("#ws-name")?.textContent || document.body.textContent, /Studio/);
assert.equal($("#dm-list").hidden, false);
assert.equal($$("#dm-list .channel-item").length, 1);
assert.match($("#dm-list").textContent, /Camille/);
$("#dm-list .channel-item").click(); await tick(150);
assert.match($("#messages").textContent, /Coucou/);
assert.doesNotMatch($("#channel-desc").textContent, /Compagnie/);
assert.equal($("#channel-delete-dm").hidden, false);
ok("une discussion privée est visible dans tous les espaces communs");

// ouvrir à nouveau depuis l'autre espace : la même discussion (pas de doublon)
$("#new-dm").click(); await tick(60);
$$("#dm-pick .pick-button").find((b) => b.textContent.includes("Camille")).click();
await tick(120);
assert.equal(f.db.channels.filter((c) => c.kind === "dm").length, 1);
ok("une seule discussion par paire, quel que soit l'espace");

// couleurs neutres : la zone des messages privés ne suit pas la production
assert.ok($("#dm-list").classList.contains("dm-zone") && $("#dm-title").classList.contains("dm-zone"));
assert.ok(document.querySelector("#screen-app .chat").classList.contains("is-dm"), "conversation privée : thème neutre");
if (!$("#channel-list .room-root")) { $("#channel-list .room-toggle").click(); await tick(40); }
$("#channel-list .room-root").click(); await tick(120);
assert.ok(!document.querySelector("#screen-app .chat").classList.contains("is-dm"), "un spectacle reprend la couleur de sa production");
$("#dm-list .channel-item").click(); await tick(120);
ok("messages privés : couleurs neutres, indépendantes de la production");

// suppression de toute la discussion
f.storage.files.add(dm.id + "/x.jpg");
let confirmText = "";
window.confirm = (t) => { confirmText = t; return true; };
$("#channel-delete-dm").click();
await tick(200);
assert.match(confirmText, /Camille/);
assert.match(confirmText, /vous deux/);
assert.equal(f.db.channels.some((c) => c.id === dm.id), false);
assert.equal(f.db.messages.some((m) => m.channel_id === dm.id), false);
assert.equal(f.storage.files.size, 0, "photos retirées");
assert.equal($("#dm-list").hidden, true);
ok("supprimer la discussion privée : messages et photos disparaissent");

// seuls les participants peuvent supprimer
f.db.channels.push({ id: "dmX", workspace_id: "w1", name: "dm:u2:u3", kind: "dm", everyone: false, description: null, created_at: "2026-11-01T00:00:00Z" });
const { error } = await f.from("channels").delete().eq("id", "dmX");
assert.equal(f.db.channels.some((c) => c.id === "dmX"), true, "un tiers ne peut pas supprimer");
ok("un tiers ne peut pas supprimer la discussion");

chat.stop();
console.log(`\n${passed} vérifications réussies`);
