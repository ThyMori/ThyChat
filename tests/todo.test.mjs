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
  f.db.messages.push(msg("m2", "c1", "u1", "Mon message", "2026-11-14T09:01:00.000Z"));
  f.db.messages.push(msg("m3", "c1", "u2", "Autre message de Camille", "2026-11-14T09:02:00.000Z"));
  const chat = createChat({ supabase: f, user: userObj });
  await chat.start(); await openLast();
  await tick(100);
  return { f, chat };
}



const th = { id: "u1", email: "me@x.fr", user_metadata: {} };
const camille = { id: "u2", email: "c@x.fr", user_metadata: {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

{
  const { f, chat } = await session(th, "admin");
  // écrire une To-Do
  assert.ok($("#attach-todo"), "To-Do dans le +");
  $("#attach-todo").click(); await tick(30);
  assert.ok($("#dialog-todo").hasAttribute("open"));
  assert.equal($$("#todo-items li").length, 3);
  // vide refusé
  $("#todo-form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await tick(40);
  assert.equal(f.db.postits.length, 0);
  assert.equal($("#todo-message").hidden, false);
  $("#todo-title").value = "Chargement";
  const inputs = $$("#todo-items input");
  inputs[0].value = "Projecteurs"; inputs[1].value = "Câbles"; // la 3e reste vide : ignorée
  $("#todo-form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await tick(80);
  assert.equal(f.db.postits.length, 1);
  assert.equal(f.db.postits[0].kind, "todo");
  assert.deepEqual(f.db.postits[0].items, [{ t: "Projecteurs", done: false }, { t: "Câbles", done: false }]);
  assert.equal($("#dialog-todo").hasAttribute("open"), false);
  assert.equal($$("#postit-wall .postit.todo").length, 1);
  assert.match($("#postit-wall").textContent, /Chargement/);
  assert.match($("#postit-wall").textContent, /0 \/ 2/);
  chat.stop();
}
{
  // un autre membre coche les cases : partagées, la feuille disparaît à la fin
  const { f, chat } = await session(camille, "member");
  chat.stop();
  f.db.postits.push({ id: "t1", channel_id: "c1", user_id: "u1", kind: "todo", body: "Chargement", items: [{ t: "Projecteurs", done: false }, { t: "Câbles", done: false }], created_at: "2026-11-14T08:00:00.000Z" });
  f.db.postits.push({ id: "t2", channel_id: "c2", user_id: "u1", kind: "todo", body: "Réglages", items: [{ t: "Face", done: false }], created_at: "2026-11-14T09:00:00.000Z" });
  f.db.postits.push({ id: "n1", channel_id: "c1", user_id: "u1", kind: "note", body: "Simple mot", items: null, created_at: "2026-11-14T09:00:00.000Z" });
  const again = createChat({ supabase: f, user: camille });
  await again.start(); await openLast(); await tick(150);
  assert.equal($$("#postit-wall .postit").length, 2);
  assert.equal($$("#postit-wall .postit.todo").length, 1);
  $('#postit-wall [data-id="t1"]').click(); await wait(450);
  assert.ok($("#dialog-postit-read").hasAttribute("open"));
  assert.equal($$("#postit-read-note .todo-item input").length, 2);
  assert.equal($("#postit-edit").hidden, true);
  assert.match($("#postit-read-hint").textContent, /Coche/);
  const box = () => $$("#postit-read-note .todo-item input");
  // aucune confirmation n'est demandée
  let asked = 0;
  window.confirm = () => { asked++; return false; };
  box()[0].checked = true; box()[0].dispatchEvent(new window.Event("change", { bubbles: true })); await tick(60);
  assert.equal(f.db.postits.find((p) => p.id === "t1").items[0].done, true, "case enregistrée pour tous");
  assert.match($("#postit-read-note .todo-count").textContent, /1 \/ 2/);
  assert.equal(f.db.postits.find((p) => p.id === "t1").items[0].by, "u2", "signée par Camille");
  await tick(40);
  assert.match($("#postit-read-note .todo-by").textContent, /Camille/, "signature visible");
  assert.ok($("#dialog-postit-read").hasAttribute("open"), "cocher ne ferme pas");
  assert.equal(asked, 0, "pas de confirmation");
  $$("#postit-read-note .todo-item")[0].click(); await tick(60); // clic sur la ligne : ne fait rien
  $$("#postit-read-note .todo-label")[0].click(); await tick(60);
  assert.ok($("#dialog-postit-read").hasAttribute("open"));
  assert.equal(f.db.postits.find((p) => p.id === "t1").items[0].done, true, "la ligne ne décoche pas");
  $$("#postit-read-note .todo-item input")[0].click(); await tick(60); // la case elle-même décoche
  assert.equal(f.db.postits.find((p) => p.id === "t1").items[0].done, false, "décochée pour tous");
  assert.equal(asked, 0, "toujours aucune confirmation");
  window.confirm = () => true;
  assert.equal("by" in f.db.postits.find((p) => p.id === "t1").items[0], false, "signature retirée");
  assert.equal($$("#postit-read-note .todo-by").length, 0);
  $$("#postit-read-note .todo-item input")[0].click(); await tick(60);
  assert.equal(f.db.postits.find((p) => p.id === "t1").items[0].done, true);
  // aperçu général avant la fin
  $("#dialog-postit-read").removeAttribute("open"); $("#dialog-postit-read").dispatchEvent(new window.Event("close")); await tick(40);
  assert.match($("#postit-wall").textContent, /1 \/ 2/);
  // vue d'ensemble : classée par spectacle
  $("#open-todos").click(); await tick(120);
  assert.ok($("#dialog-todos").hasAttribute("open"));
  const rooms = $$("#todos-list .todos-room");
  assert.deepEqual(rooms.map((b) => b.textContent), ["Hamlet2"], "les deux fils de Hamlet");
  assert.equal($("#todo-count").hidden, false);
  assert.equal($("#todo-count").textContent, "2", "bulle du menu : nombre de To-Do en cours");
  rooms[0].click(); await tick(30);
  assert.equal($$("#todos-list .postit.todo").length, 2);
  assert.equal($("#todos-back").hidden, false);
  // cocher dans la vue d'ensemble
  const sheet = $('#todos-list [data-id="t2"]');
  const b2 = sheet.querySelector("input"); b2.checked = true; b2.dispatchEvent(new window.Event("change", { bubbles: true })); await tick(60);
  assert.equal(f.db.postits.find((p) => p.id === "t2").items[0].done, true);
  assert.equal($$("#todos-list .postit.todo").length, 2, "terminée : reste affichée tant que la fenêtre est ouverte");
  assert.match($("#todos-message").textContent, /disparaîtra quand tu fermeras/);
  // case cochée par erreur : on la décoche, la To-Do reste en cours
  b2.checked = false; b2.dispatchEvent(new window.Event("change", { bubbles: true })); await tick(60);
  assert.equal(f.db.postits.find((p) => p.id === "t2").items[0].done, false, "décochée avant la fermeture");
  assert.equal($("#todos-message").hidden, true);
  b2.checked = true; b2.dispatchEvent(new window.Event("change", { bubbles: true })); await tick(60);
  $("#todos-back").click(); await tick(20);
  assert.match($("#todos-list").textContent, /Hamlet/, "retour aux spectacles : t2 terminée est retirée");
  $$("#todos-list .todos-room")[0].click(); await tick(30);
  assert.equal($$("#todos-list .postit.todo").length, 1, "terminée : disparue après le retour");
  $("#todos-back").click(); await tick(20);
  // finir t1 depuis le fil : disparaît du mur, reste dans les jetés
  $("#dialog-todos").removeAttribute("open");
  $('#postit-wall [data-id="t1"]').click(); await wait(450);
  const last = $$("#postit-read-note .todo-item input")[1]; last.checked = true; last.dispatchEvent(new window.Event("change", { bubbles: true })); await tick(60);
  assert.ok($("#dialog-postit-read").hasAttribute("open"), "dernière case : la feuille reste ouverte");
  assert.match($("#postit-read-message").textContent, /disparaîtra quand tu fermeras/);
  // cochée par erreur : on décoche, rien n'a disparu
  last.checked = false; last.dispatchEvent(new window.Event("change", { bubbles: true })); await tick(60);
  assert.equal($("#postit-read-message").hidden, true);
  assert.equal(f.db.postits.find((p) => p.id === "t1").items[1].done, false);
  last.checked = true; last.dispatchEvent(new window.Event("change", { bubbles: true })); await tick(60);
  $("#dialog-postit-read").removeAttribute("open"); $("#dialog-postit-read").dispatchEvent(new window.Event("close")); await tick(60);
  assert.equal($$("#postit-wall .postit.todo").length, 0, "feuille terminée : disparaît à la fermeture");
  assert.equal($$("#postit-wall .postit").length, 1, "le Post-it reste");
  $("#channel-postits").click(); await tick(40);
  assert.equal($$("#postit-trash-list .postit.todo").length, 1, "consultable dans les jetés");
  assert.match($("#postit-trash-list").textContent, /☑ Projecteurs — Camille/);
  assert.equal($("#postit-trash-list [data-restore]"), null, "pas de « remettre » pour une To-Do terminée");
  assert.equal($("#postit-empty").hidden, false);
  $("#postit-empty").click(); await tick(60);
  assert.equal(f.db.postit_states.filter((r) => r.state === "purged").length, 1, "tout jeté définitivement");
  assert.match($("#postit-trash-list").textContent, /Aucun Post-it jeté/);
  assert.equal($("#postit-empty").hidden, true);
  $("#dialog-postit-trash").removeAttribute("open");
  // vue d'ensemble : plus rien en cours pour Hamlet
  $("#open-todos").click(); await tick(120);
  assert.match($("#todos-list").textContent, /Aucune To-Do en cours/);
  $("#dialog-todos").removeAttribute("open");
  // l'auteur modifie une To-Do en cours
  f.db.postits.push({ id: "t3", channel_id: "c1", user_id: "u1", kind: "todo", body: "Lundi", items: [{ t: "A", done: true }, { t: "B", done: false }], created_at: "2026-11-14T10:00:00.000Z" });
  again.stop();
  if (!f.db.workspace_members.some((m) => m.user_id === "u1")) f.db.workspace_members.push({ workspace_id: "w1", user_id: "u1", role: "member" });
  Object.assign(camille, { id: "u1", email: "me@x.fr" });
  const author = createChat({ supabase: f, user: camille });
  await author.start(); await openLast(); await tick(150);
  $('#postit-wall [data-id="t3"]').click(); await wait(450);
  assert.equal($("#postit-edit").hidden, false);
  $("#postit-edit").click(); await tick(60);
  assert.ok($("#dialog-todo").hasAttribute("open"));
  assert.equal($("#todo-title").value, "Lundi");
  assert.deepEqual($$("#todo-items input").map((i) => i.value), ["A", "B"]);
  $("#todo-add-item").click(); await tick(10);
  $$("#todo-items input")[2].value = "C";
  $("#todo-form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await tick(80);
  assert.deepEqual(f.db.postits.find((p) => p.id === "t3").items, [{ t: "A", done: true }, { t: "B", done: false }, { t: "C", done: false }], "la case déjà cochée le reste");
  assert.match($("#postit-wall").textContent, /1 \/ 3/);
  author.stop();
}
console.log("todo ok");
