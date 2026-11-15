import fs from "node:fs";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { makeFake } from "./fake.mjs";
import { createStore } from "../dist/js/offline.js";
const REPO = new URL("../dist", import.meta.url).pathname; // les tests s'exécutent sur le résultat du build
const html = fs.readFileSync(`${REPO}/index.html`, "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
const dom = new JSDOM(html, { url: "https://thychat.thierry-morin.com/" });
const { window } = dom;
window.confirm = () => true;
Object.defineProperty(window.navigator, 'onLine', { get: () => !globalThis.__off, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, AbortController: window.AbortController });
Object.defineProperty(globalThis, "location", { value: window.location, configurable: true });
Object.defineProperty(globalThis, "history", { value: window.history, configurable: true });
document.getElementById("screen-app").hidden = false;
const { createChat } = await import(`${REPO}/js/messagerie.js`);
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const msg = (id, channel, user, body, at) => ({ id, channel_id: channel, user_id: user, parent_id: null, pinned: false, edited_at: null, body, created_at: at, tag_ids: [], attachments: [] });

async function session(userObj, role, store = createStore()) {
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
  f.db.messages.push(msg("m2", "c1", "u1", "Mon message", "2026-11-14T09:01:00.000Z"));
  f.db.messages.push(msg("m3", "c1", "u2", "Autre message de Camille", "2026-11-14T09:02:00.000Z"));
  const chat = createChat({ supabase: f, user: userObj, store });
  await chat.start(); await openLast();
  await tick(100);
  return { f, chat, store };
}



const th = { id: "u1", email: "me@x.fr", user_metadata: {} };
const camille = { id: "u2", email: "c@x.fr", user_metadata: {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

globalThis.createImageBitmap = async () => ({ width: 3200, height: 2400, close() {} });
window.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, drawImage() {}, set fillStyle(v) {} });
window.HTMLCanvasElement.prototype.toBlob = function (cb, type) { cb(new window.Blob([new Uint8Array(10)], { type })); };
URL.createObjectURL = () => "blob:test/1";
URL.revokeObjectURL = () => {};

const touch = (node, type, x, y) => {
  const e = new window.Event(type, { bubbles: true, cancelable: true });
  const pt = { clientX: x, clientY: y };
  e.touches = type === "touchend" ? [] : [pt];
  e.changedTouches = [pt];
  node.dispatchEvent(e);
};
{
  const { f, chat } = await session(th, "admin");
  const row = () => $$("#messages .msg")[1];
  const r = row(); const id = r.dataset.id;
  touch(r.querySelector(".bubble"), "touchstart", 300, 200);
  touch(r.querySelector(".bubble"), "touchmove", 280, 202);
  assert.ok(r.classList.contains("swiping"), "le message suit le doigt");
  assert.match(r.style.transform, /translateX\(-/);
  touch(r.querySelector(".bubble"), "touchmove", 200, 204);
  assert.ok(r.classList.contains("armed"), "seuil atteint : surbrillance renforcée");
  touch(r.querySelector(".bubble"), "touchend", 200, 204); await tick(30);
  assert.equal(r.style.transform, "", "revient en place");
  const sel = document.querySelector(`#messages .msg[data-id="${id}"]`);
  assert.ok(sel.classList.contains("selected"), "message sélectionné après le glissement");
  assert.ok(sel.querySelector(".msg-actions .msg-act svg"), "actions en icônes");
  assert.equal(sel.querySelector("[data-action='reply']").getAttribute("aria-label"), "Répondre");
  // « Retour » (popstate) désélectionne le message avant toute autre chose
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  window.dispatchEvent(new window.Event("popstate")); await tick(30);
  assert.equal(document.querySelector("#messages .msg.selected"), null, "Retour désélectionne");
  assert.equal(document.querySelector("#messages .msg-actions"), null);
  assert.equal($("#screen-app").classList.contains("sidebar-open"), false, "on reste dans le fil");
  // glissement vertical : pas de suivi
  const r2 = $$("#messages .msg")[2];
  touch(r2.querySelector(".bubble"), "touchstart", 300, 200);
  touch(r2.querySelector(".bubble"), "touchmove", 296, 260);
  assert.equal(r2.classList.contains("swiping"), false);
  touch(r2.querySelector(".bubble"), "touchend", 296, 260);
  chat.stop();
}
console.log("swipe ok");
