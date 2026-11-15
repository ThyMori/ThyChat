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

f.db.profiles.push({ id: "u3", display_name: "Marc", avatar_url: null, is_super_admin: false }, { id: "u4", display_name: "Zoé", avatar_url: null, is_super_admin: false });
for (const u of ["u3", "u4"]) f.db.workspace_members.push({ workspace_id: "w1", user_id: u, role: "member" });
const mk = (id, a, b, at) => { f.db.channels.push({ id, workspace_id: "w1", name: `dm:${a}:${b}`, kind: "dm", everyone: false, description: null, created_at: "2026-11-01T00:00:00Z" }); f.db.channel_members.push({ channel_id: id, user_id: a, created_at: at }, { channel_id: id, user_id: b, created_at: at }); };
mk("d2", "u1", "u2", "2026-11-01T00:00:00Z"); mk("d3", "u1", "u3", "2026-11-01T00:00:00Z");
const M = (id, ch, u, body, at) => ({ id, channel_id: ch, user_id: u, parent_id: null, reply_to: null, tag_ids: [], pinned: false, edited_at: null, struck_at: null, attachments: [], body, created_at: at });
f.db.messages.push(M("a1", "d2", "u2", "plan de feu v1", "2026-11-10T10:00:00.000Z"), M("a2", "d3", "u3", "Bonjour", "2026-11-13T10:00:00.000Z"));
for (let i = 0; i < 120; i++) f.db.messages.push(M("o" + i, "c1", "u2", "bavardage " + i, `2026-11-02T${String(8 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`));
f.db.messages.push(M("old", "c1", "u2", "Le gobo rouge est cassé", "2026-11-01T09:00:00.000Z"));
f.db.messages.push(M("w2m", "c9", "u2", "Gobo bleu dans le Studio", "2026-11-12T09:00:00.000Z"));
const chat = createChat({ supabase: f, user: thierry });
await chat.start();
await tick(100);




// liste des messages privés : le fil le plus récent en haut
assert.deepEqual($$("#dm-list .channel-name").map((n) => n.textContent), ["Marc", "Camille"]);
assert.ok($("#dm-list .channel-item.dm"), "lignes compactes");
f.incoming(M("a3", "d2", "u2", "Nouveau message", "2026-11-14T12:00:00.000Z"));
await tick(80);
assert.deepEqual($$("#dm-list .channel-name").map((n) => n.textContent), ["Camille", "Marc"]);
ok("messages privés classés du plus récent au plus ancien, et remontés à l'arrivée d'un message");

// « + » : recherche d'un fil existant
$("#new-dm").click(); await tick(60);
assert.deepEqual($$("#dm-pick .pick-name").map((n) => n.textContent), ["Camille", "Marc", "Zoé"]);
assert.equal($$("#dm-pick [data-thread]").length, 2);
$("#dm-search").value = "cam";
$("#dm-search").dispatchEvent(new window.Event("input", { bubbles: true }));
assert.deepEqual($$("#dm-pick .pick-name").map((n) => n.textContent), ["Camille"]);
$("#dm-search").value = "zzz";
$("#dm-search").dispatchEvent(new window.Event("input", { bubbles: true }));
assert.match($("#dm-pick").textContent, /Personne ne correspond/);
$("#dm-search").value = "zo";
$("#dm-search").dispatchEvent(new window.Event("input", { bubbles: true }));
$("#dm-pick .pick-button").click(); await tick(150);
assert.equal(f.db.channels.filter((c) => c.kind === "dm").length, 3, "nouveau fil créé avec Zoé");
$("#new-dm").click(); await tick(60);
$("#dm-search").value = "marc";
$("#dm-search").dispatchEvent(new window.Event("input", { bubbles: true }));
$("#dm-pick .pick-button").click(); await tick(150);
assert.equal(f.db.channels.filter((c) => c.kind === "dm").length, 3, "fil existant retrouvé, pas recréé");
assert.equal($("#channel-title").textContent, "Marc");
ok("le + cherche un fil existant ou en crée un nouveau");

// recherche de messages
$("#open-search").click(); await tick(30);
assert.ok($("#dialog-search").hasAttribute("open"));
$("#search-input").value = "g";
$("#search-input").dispatchEvent(new window.Event("input", { bubbles: true }));
await tick(400);
assert.match($("#search-status").textContent, /2 caractères/);
$("#search-input").value = "gobo";
$("#search-input").dispatchEvent(new window.Event("input", { bubbles: true }));
await tick(450);
assert.equal($$("#search-results .search-hit").length, 2);
assert.match($("#search-results").textContent, /Hamlet · Tous/);
assert.match($("#search-results").textContent, /Studio · Cabaret · Tous/);
assert.equal($("#search-results mark").textContent.toLowerCase(), "gobo");
ok("recherche : résultats de tous les espaces, mot surligné");

// portée « ce sous-salon »
$("#search-scope").value = "all";
$("#dialog-search [data-close]").click();
// aller dans un message ancien (hors des 100 derniers)
$("#open-search").click(); await tick(30);
$("#search-input").value = "gobo rouge";
$("#search-input").dispatchEvent(new window.Event("input", { bubbles: true }));
await tick(450);
$("#search-results .search-hit").click();
await tick(300);
assert.ok(!$("#dialog-search").hasAttribute("open"));
assert.ok($('#messages .msg[data-id="old"]'), "message ancien chargé");
assert.ok($('#messages .msg[data-id="old"]').classList.contains("flash"));
ok("un résultat ouvre le sous-salon sur le message, même ancien");

// autre espace
$("#open-search").click(); await tick(30);
$("#search-input").value = "studio";
$("#search-input").dispatchEvent(new window.Event("input", { bubbles: true }));
await tick(450);
$("#search-results .search-hit").click();
await tick(400);
assert.match($("#ws-name").textContent, /Studio/);
assert.ok($('#messages .msg[data-id="w2m"]'));
ok("un résultat d'un autre espace change d'espace");

// dans un message privé : % et _ ne sont pas des jokers
$("#open-search").click(); await tick(30);
$("#search-input").value = "%%";
$("#search-input").dispatchEvent(new window.Event("input", { bubbles: true }));
await tick(450);
assert.match($("#search-status").textContent, /Aucun/);
$("#search-input").value = "plan de feu";
$("#search-input").dispatchEvent(new window.Event("input", { bubbles: true }));
await tick(450);
assert.match($("#search-results").textContent, /Message privé · Camille/);
ok("recherche dans les messages privés ; les jokers sont neutralisés");

// sans accents ni majuscules
f.db.messages.push(M("acc", "c1", "u2", "Réglage de l'éclairage à Zürich", "2026-11-14T13:00:00.000Z"));
$("#open-search").click(); await tick(30);
$("#search-input").value = "ECLAIRAGE a zurich";
$("#search-input").dispatchEvent(new window.Event("input", { bubbles: true }));
await tick(450);
assert.equal($$("#search-results .search-hit").length, 1);
assert.equal($("#search-results mark").textContent, "éclairage à Zürich");
$("#search-input").value = "reglage";
$("#search-input").dispatchEvent(new window.Event("input", { bubbles: true }));
await tick(450);
assert.equal($("#search-results mark").textContent, "Réglage");
ok("la recherche ignore les accents et les majuscules (résultats et surlignage)");

// migration 011 pas encore exécutée : retour à la recherche simple
const realRpc = f.rpc.bind(f);
f.rpc = async (name, args) => name === "search_messages" ? { data: null, error: { code: "PGRST202", message: "Could not find the function public.search_messages in the schema cache" } } : realRpc(name, args);
$("#open-search").click(); await tick(30);
$("#search-input").value = "gobo";
$("#search-input").dispatchEvent(new window.Event("input", { bubbles: true }));
await tick(450);
assert.equal($$("#search-results .search-hit").length, 2, "recherche simple de repli");
ok("sans la migration 011, la recherche simple continue de marcher");
chat.stop();
console.log(`\n${passed} vérifications réussies`);
