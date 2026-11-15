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
const go = (off) => { globalThis.__off = off; };
{
  const { f, chat } = await session(th, "admin");
  assert.equal($("#offline-bar").hidden, true, "en ligne : pas de bandeau");
  // une première lecture réussie a été gardée ; le réseau tombe
  f.net.off = true; go(true);
  window.dispatchEvent(new window.Event("offline")); await tick(20);
  assert.equal($("#offline-bar").hidden, false);
  assert.match($("#offline-bar").textContent, /Pas de réseau/);
  // écrire sans réseau : le message est mis en attente
  $("#composer-input").value = "Je n'ai plus de réseau";
  $("#composer").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await tick(80);
  assert.equal(f.db.messages.filter((m) => m.body === "Je n'ai plus de réseau").length, 0, "pas envoyé");
  assert.equal($$("#messages .msg.pending").length, 1);
  assert.match($("#messages .msg.pending").textContent, /En attente d'envoi/);
  assert.match($("#offline-bar").textContent, /1 message en attente/);
  assert.equal($("#composer-input").value, "", "zone de saisie vidée");
  // un deuxième message passe derrière le premier
  $("#composer-input").value = "Et un second";
  $("#composer").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await tick(80);
  assert.equal($$("#messages .msg.pending").length, 2);
  // l'ordre est conservé à l'envoi
  f.net.off = false; go(false);
  window.dispatchEvent(new window.Event("online")); await tick(300);
  const sent = f.db.messages.filter((m) => m.user_id === "u1" && /réseau|second/.test(m.body));
  assert.deepEqual(sent.map((m) => m.body), ["Je n'ai plus de réseau", "Et un second"], "dans l'ordre");
  assert.equal($$("#messages .msg.pending").length, 0, "plus d'attente");
  assert.equal($$("#messages .msg").length >= 5, true);
  assert.equal($("#offline-bar").hidden, true, "bandeau retiré");
  assert.equal(await f.db.messages.filter((m) => m.body === "Et un second").length, 1, "pas de doublon");
  chat.stop();
}
{
  // photo + réponse + date sans réseau ; échec non réseau => « Non envoyé »
  const { f, chat } = await session(th, "admin");
  f.net.off = true; go(true);
  window.dispatchEvent(new window.Event("offline")); await tick(20);
  Object.defineProperty($("#file-photo"), "files", { value: [new window.File([new Uint8Array(4)], "a.png", { type: "image/png" })], configurable: true });
  $("#file-photo").dispatchEvent(new window.Event("change", { bubbles: true })); await tick(80);
  assert.equal($$("#composer-images .pending-image").length, 1);
  $("#composer-input").value = "Avec photo";
  $("#composer").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await tick(60);
  assert.equal($$("#messages .msg.pending").length, 1);
  assert.equal($$("#messages .msg.pending img").length, 1, "la photo en attente est affichée");
  f.net.off = false; go(false);
  window.dispatchEvent(new window.Event("online")); await tick(300);
  assert.equal(f.db.messages.filter((m) => m.body === "Avec photo").length, 1, "photo + texte partis au retour du réseau");
  assert.equal($$("#messages .msg.pending").length, 0);
  chat.stop();
}
{
  // une file gardée d'une session précédente repart ; un message refusé par la base est marqué « Non envoyé »
  const { f, chat, store } = await session(th, "admin");
  chat.stop();
  await store.outboxPut({ id: "dead-1", user_id: "u1", channel_id: "c1", body: "Réponse orpheline", reply_to: "inconnu", tag_ids: [], images: [], attachments: [], created_at: "2026-11-14T10:05:00.000Z", status: "pending", error: "" });
  await store.outboxPut({ id: "ok-2", user_id: "u1", channel_id: "c1", body: "Celui-là passe", reply_to: null, tag_ids: [], images: [], attachments: [], created_at: "2026-11-14T10:06:00.000Z", status: "pending", error: "" });
  const again = createChat({ supabase: f, user: th, store });
  await again.start(); await openLast(); await tick(300);
  assert.equal(f.db.messages.some((m) => m.body === "Celui-là passe"), true, "le suivant n'est pas bloqué");
  assert.equal($$("#messages .msg.pending.failed").length, 1, "refusé : marqué non envoyé");
  assert.match($("#messages .msg.pending.failed").textContent, /Non envoyé/);
  assert.ok($("#messages .msg.pending.failed [data-pending-action='retry']"));
  $("#messages [data-pending-action='cancel']").click(); await tick(60);
  assert.equal($$("#messages .msg.pending").length, 0);
  assert.equal(again.pendingCount(), 0);
  assert.equal((await store.outboxAll("u1")).length, 0, "file vidée");
  again.stop();
}
{
  // démarrage sans réseau : les lectures gardées s'affichent
  const f0 = await session(th, "admin");
  const store = f0.store;
  f0.chat.stop();
  go(true); f0.f.net.off = true;
  const chat2 = createChat({ supabase: f0.f, user: th, store });
  await chat2.start(); await openLast(); await tick(250);
  assert.ok($$("#messages .msg").length >= 3, "messages déjà vus affichés hors-ligne");
  assert.match($("#messages").textContent, /Plan de feu à jour/);
  assert.equal($("#offline-bar").hidden, false);
  chat2.stop();
  go(false);
}
console.log("offline ok");
