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
const U = (id) => ({ id, email: id + "@x.fr", user_metadata: {} });

const base = (f) => {
  f.db.workspaces.push({ id: "w1", name: "Cie A", created_by: "u1", theme: "violet" });
  for (const [id, role] of [["u1", "admin"], ["u2", "member"], ["u3", "member"], ["u4", "member"]]) f.db.workspace_members.push({ workspace_id: "w1", user_id: id, role });
  f.db.rooms.push({ id: "r1", workspace_id: "w1", name: "Hamlet", description: null, everyone: false, created_at: "2026-11-01T00:00:00Z" });
  f.db.rooms.push({ id: "r2", workspace_id: "w1", name: "Lear", description: null, everyone: false, created_at: "2026-11-01T00:00:00Z" });
  for (const id of ["u2", "u3"]) f.db.room_members.push({ room_id: "r1", user_id: id });
  f.db.room_members.push({ room_id: "r2", user_id: "u4" });
  f.db.channels.push({ id: "c1", workspace_id: "w1", room_id: "r1", name: "Général", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z", created_by: "u1" });
  f.db.channels.push({ id: "c2", workspace_id: "w1", room_id: "r2", name: "Général", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z", created_by: "u1" });
};

// u2 (simple membre du spectacle Hamlet) crée un sous-salon réservé et y invite u3 ; u4 (autre spectacle) n'y est pas proposé
const f = makeFake(U("u2")); base(f);
const chat = createChat({ supabase: f, user: U("u2") });
await chat.start(); await tick(150); await globalThis.openLast?.();
const chev = $(`.room-chev[data-room="r1"]`); if (chev && chev.getAttribute("aria-expanded") !== "true") { chev.click(); await tick(40); }
assert.ok($("[data-new-sub=\"r1\"]"), "bouton + Nouveau sous-salon");
assert.ok($("[data-new-sub=\"r1\"]").compareDocumentPosition($("[data-notes-room=\"r1\"]")) & 4, "« + Nouveau sous-salon » est au-dessus de « Mes notes »"); ok("un membre simple voit « + Nouveau sous-salon »");
$("[data-new-sub=\"r1\"]").click(); await tick(150);
assert.equal($("#dialog-channel").open, true);
$("#channel-name").value = "Régie son";
document.querySelector('input[name="channel-access"][value="some"]').checked = true;
document.querySelector('input[name="channel-access"][value="some"]').dispatchEvent(new window.Event("change", { bubbles: true })); await tick(30);
const names = $$("#channel-pick .pick-name").map((n) => n.textContent);
assert.equal(names.length, 2, "membres du spectacle seulement : " + names); ok("le choix ne propose que les membres du spectacle");
const u3box = $$("#channel-pick input").find((b) => b.value === "u3"); u3box.checked = true;
$("#channel-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick(300);
const made = f.db.channels.find((c) => c.name === "Régie son");
assert.ok(made && made.created_by === "u2" && made.everyone === false); ok("sous-salon créé par un membre, réservé");
assert.deepEqual(f.db.channel_members.filter((m) => m.channel_id === made.id).map((m) => m.user_id).sort(), ["u2", "u3"]); ok("créateur et invité sont membres");
assert.equal($("#channel-edit").hidden, false); ok("le créateur a le ⚙");
// un autre membre n'a pas le ⚙ sur le salon général
$$("#channel-list .channel-item").find((b) => b.dataset.id === "c1")?.click(); await tick(100);
chat.stop();

// u3 voit le salon (invité) et n'a pas le ⚙ ; u4 (autre spectacle) ne le voit pas
const f2 = makeFake(U("u3")); base(f2);
f2.db.channels.push({ ...made }); f2.db.channel_members.push({ channel_id: made.id, user_id: "u3" }, { channel_id: made.id, user_id: "u2" });
const chat2 = createChat({ supabase: f2, user: U("u3") });
await chat2.start(); await tick(150); await globalThis.openLast?.();
const chev2 = $(`.room-chev[data-room="r1"]`); if (chev2 && chev2.getAttribute("aria-expanded") !== "true") { chev2.click(); await tick(40); }
const item = $$("#channel-list .channel-item").find((b) => b.dataset.id === made.id);
assert.ok(item); item.click(); await tick(100);
assert.equal($("#channel-edit").hidden, true); ok("l'invité voit le sous-salon mais ne le gère pas");
const refused = await f2.from("channels").update({ name: "pirate" }).eq("id", made.id).select();
assert.notEqual(f2.db.channels.find((c) => c.id === made.id).name, "pirate"); ok("un autre membre ne peut pas le renommer");
chat2.stop();

const f3 = makeFake(U("u4")); base(f3);
f3.db.channels.push({ ...made });
const chat3 = createChat({ supabase: f3, user: U("u4") });
await chat3.start(); await tick(150); await globalThis.openLast?.();
assert.equal($$("#channel-list .channel-item").some((b) => b.dataset.id === made.id), false);
const cross = await f3.from("channels").insert({ workspace_id: "w1", room_id: "r1", name: "intrus" }).select();
assert.equal(f3.db.channels.some((c) => c.name === "intrus"), false); ok("hors du spectacle : pas de sous-salon visible ni créable");
chat3.stop();
console.log(`\n${passed} vérifications OK`);
process.exit(0);
