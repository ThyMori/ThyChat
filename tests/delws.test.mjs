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
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
let passed = 0; const ok = (n) => console.log("  ✓", n) || passed++;

async function run(userId, role) {
  const me = { id: userId, email: userId + "@x.fr", user_metadata: {} };
  const f = makeFake(me);
  f.db.workspaces.push({ id: "w1", name: "Test", created_by: "u1", theme: "violet" }, { id: "w2", name: "Cie B", created_by: "u1", theme: "teal" });
  f.db.workspace_members.push({ workspace_id: "w1", user_id: userId, role }, { workspace_id: "w2", user_id: userId, role: "admin" });
  f.db.rooms.push({ id: "r1", workspace_id: "w1", name: "Hamlet", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" }, { id: "r2", workspace_id: "w2", name: "Lear", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
  f.db.channels.push({ id: "c1", workspace_id: "w1", room_id: "r1", name: "Général", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" }, { id: "c2", workspace_id: "w2", room_id: "r2", name: "Général", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
  const chat = createChat({ supabase: f, user: me });
  await chat.start(); await tick(200); await globalThis.openLast?.();
  return { f, chat };
}

// membre simple : pas de bouton
let c = await run("u2", "member");
$("#workspace-button").click(); await tick(30); document.querySelector("#ws-list .ws-row")?.click(); await tick(150);
// ouvre la fenêtre de l'espace
document.querySelector("#space-open, #open-members, #members-button")?.click();
c.chat.stop();

// administrateur : suppression avec confirmation par le nom
c = await run("u1", "admin");
$("#workspace-button").click(); await tick(60);
[...document.querySelectorAll("#ws-list .ws-row")].find((b) => b.textContent.includes("Test")).click(); await tick(250);
const opener = [...document.querySelectorAll("button")].find((b) => b.id && /members/.test(b.id) && !b.hidden);
assert.ok(opener, "bouton Espace introuvable : " + [...document.querySelectorAll("[id*=member]")].map((e) => e.id));
opener.click(); await tick(200);
assert.equal($("#space-danger-section").hidden, false); ok("admin : section « Supprimer l'espace »");
$("#space-delete-open").click(); await tick(30);
assert.equal($("#dialog-delete-space").open, true);
assert.equal($("#delete-space-submit").disabled, true);
$("#delete-space-name").value = "test";
$("#delete-space-name").dispatchEvent(new window.Event("input", { bubbles: true }));
assert.equal($("#delete-space-submit").disabled, true); ok("le nom doit être exact");
$("#delete-space-name").value = "Test";
$("#delete-space-name").dispatchEvent(new window.Event("input", { bubbles: true }));
assert.equal($("#delete-space-submit").disabled, false);
$("#delete-space-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick(400);
console.log("notice:", $("#delete-space-message").textContent, JSON.stringify(c.f.calls.invoke));
assert.equal(c.f.db.workspaces.some((w) => w.id === "w1"), false);
assert.equal(c.f.db.workspaces.some((w) => w.id === "w2"), true); ok("l'espace est supprimé, l'autre reste");
assert.equal($("#dialog-delete-space").open, false);
c.chat.stop();
console.log(`\n${passed} vérifications OK`);
process.exit(0);
