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
const mkdb = () => {
  const f = makeFake(me);
  f.db.users.push({ id: "u2", email: "b@x.fr" });
  f.db.profiles.push({ id: "u1", display_name: "Thierry" }, { id: "u2", display_name: "Bea" });
  f.db.workspaces.push({ id: "w1", name: "Cie A", created_by: "u1", theme: "violet" }, { id: "w2", name: "Cie B", created_by: "u1", theme: "teal" });
  f.db.workspace_members.push({ workspace_id: "w1", user_id: "u1", role: "admin" }, { workspace_id: "w1", user_id: "u2", role: "user" }, { workspace_id: "w2", user_id: "u1", role: "admin" });
  f.db.rooms.push({ id: "r1", workspace_id: "w1", name: "Hamlet", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" }, { id: "r2", workspace_id: "w2", name: "Lear", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
  f.db.channels.push({ id: "c1", workspace_id: "w1", room_id: "r1", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" }, { id: "c2", workspace_id: "w2", room_id: "r2", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" }, { id: "dm1", workspace_id: "w1", room_id: null, name: "", kind: "dm", everyone: false, description: null, created_at: "2026-11-01T00:00:00Z" });
  f.db.channel_members.push({ channel_id: "dm1", user_id: "u1" }, { channel_id: "dm1", user_id: "u2" });
  f.db.messages.push({ id: "m1", channel_id: "dm1", user_id: "u2", parent_id: null, pinned: false, edited_at: null, body: "Tu peux m'appeler ?", created_at: new Date().toISOString() });
  return f;
};
// 1. le dernier fil ouvert était un message privé : au lancement, on arrive quand même sur le calendrier
localStorage.setItem("thychat:last", JSON.stringify({ ws: "w1", channel: "dm1" }));
{
  const f = mkdb();
  const chat = createChat({ supabase: f, user: me });
  await chat.start(); await tick(200);
  assert.equal($("#calendar").hidden, false, "calendrier affiché");
  assert.equal($("#messages").hidden, true, "aucun fil ouvert");
  assert.equal($("#composer").hidden, true);
  assert.equal($("#cal-scope").value, "all");
  assert.equal(f.db.channel_reads.filter((r) => r.channel_id === "dm1").length, 0, "le message privé n'est pas marqué lu à ton insu");
  ok("lancement : calendrier « Tous mes espaces », sans ouvrir ni marquer lu le dernier fil");
  // choisir un fil depuis la barre latérale
  const item = document.querySelector("#channel-list .channel-item");
  item.click(); await tick(150);
  assert.equal($("#calendar").hidden, true); assert.equal($("#messages").hidden, false);
  ok("choisir un fil quitte le calendrier");
  chat.stop();
}
// 2. une notification touchée ouvre le fil concerné
for (const d of document.querySelectorAll("dialog")) d.removeAttribute("open");
history.replaceState(null, "", "/?w=w1&c=dm1");
{
  const f = mkdb();
  const chat = createChat({ supabase: f, user: me });
  await chat.start(); await tick(200);
  assert.equal($("#calendar").hidden, true);
  assert.equal($("#messages").hidden, false);
  assert.equal(f.db.channel_reads.some((r) => r.channel_id === "dm1"), true, "ouvert : lu");
  ok("notification touchée : ouvre le fil concerné");
  chat.stop();
}
console.log(`\n${passed} vérifications OK`);
process.exit(0);
