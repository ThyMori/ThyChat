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
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const msg = (id, channel, user, body, at) => ({ id, channel_id: channel, user_id: user, parent_id: null, pinned: false, edited_at: null, body, created_at: at, tag_ids: [], attachments: [] });

async function session(userObj, role) {
  localStorage.clear();
  for (const d of $$("dialog")) d.removeAttribute("open");
  const f = makeFake(userObj);
  f.db.workspaces.push({ id: "w1", name: "Cie", created_by: "u1", theme: "violet" });
  f.db.workspace_members.push({ workspace_id: "w1", user_id: userObj.id, role });
  f.db.profiles.push({ id: "u2", display_name: "Camille", avatar_url: null, is_super_admin: false });
  f.db.workspace_members.push({ workspace_id: "w1", user_id: "u2", role: "member" });
  f.db.rooms.push({ id: "r1", workspace_id: "w1", name: "Hamlet", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
  f.db.rooms.push({ id: "r2", workspace_id: "w1", name: "Lear", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
  f.db.channels.push(
    { id: "c1", workspace_id: "w1", room_id: "r1", name: "Général", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" },
    { id: "c2", workspace_id: "w1", room_id: "r1", name: "Technique", kind: "channel", everyone: true, description: null, created_at: "2026-11-02T00:00:00Z" },
    { id: "c3", workspace_id: "w2x", room_id: "r2", name: "Général", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" },
  );
  f.db.channels[2].workspace_id = "w1";
  f.db.messages.push(msg("m1", "c1", "u2", "Plan de feu à jour", "2026-11-14T09:00:00.000Z"));
  f.db.messages[0].attachments = [{ path: "c1/photo-1.jpg", w: 10, h: 10 }];
  f.storage.files.add("c1/photo-1.jpg");
  const chat = createChat({ supabase: f, user: userObj });
  await chat.start(); await openLast();
  await tick(100);
  return { f, chat };
}

const th = { id: "u1", email: "me@x.fr", user_metadata: {} };
{
  const { f, chat } = await session(th, "admin");
  $(".msg").click();
  await tick(30);
  const move = $$(".msg-actions button").find((b) => b.dataset.action === "move");
  assert.ok(move, "bouton Déplacer pour un administrateur");
  move.click();
  await tick(30);
  const targets = $$("#move-list button").map((b) => b.textContent);
  assert.ok(targets.some((t) => /Technique/.test(t)) && targets.some((t) => /Général/.test(t)), "destinations : autre sous-salon et autre spectacle");
  assert.ok(!$$("#move-list button").some((b) => b.dataset.target === "c1"), "pas le sous-salon actuel");
  $('#move-list button[data-target="c3"]').click();
  await tick(60);
  assert.equal(f.db.messages.find((m) => m.id === "m1").channel_id, "c3", "message déplacé dans l'autre spectacle");
  assert.equal($$(".msg").length, 0, "disparu du fil d'origine");
  assert.ok(f.storage.files.has("c3/photo-1.jpg") && !f.storage.files.has("c1/photo-1.jpg"), "la photo a réellement été déplacée dans le stockage");
  assert.equal(f.db.messages.find((m) => m.id === "m1").attachments[0].path, "c3/photo-1.jpg");
  assert.equal($("#dialog-move").hasAttribute("open"), false);
  chat.stop();
}
{
  const camille = { id: "u2", email: "c@x.fr", user_metadata: {} };
  const { chat } = await session(camille, "member");
  $(".msg").click();
  await tick(30);
  assert.ok(!$$(".msg-actions button").some((b) => b.dataset.action === "move"), "pas de bouton Déplacer pour un utilisateur");
  chat.stop();
}
console.log("move ok");
