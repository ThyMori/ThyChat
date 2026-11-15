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
  // écrire un Post-it
  assert.ok($("#attach-postit"), "logo Post-it dans le +");
  assert.equal($("#postit-wall").hidden, true, "pas de Post-it : mur caché");
  $("#attach-postit").click(); await tick(30);
  assert.ok($("#dialog-postit").hasAttribute("open"));
  $("#postit-input").value = "Apporter les gobos demain";
  $("#postit-input").dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.match($("#postit-count").textContent, /^25 \/ 300/);
  $("#postit-form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await tick(80);
  assert.equal(f.db.postits.length, 1);
  assert.equal($("#dialog-postit").hasAttribute("open"), false);
  assert.equal($("#postit-wall").hidden, false);
  assert.equal($$("#postit-wall .postit").length, 1);
  assert.match($("#postit-wall .postit").textContent, /Apporter les gobos demain/);
  assert.match($("#postit-wall .postit").textContent, /Thierry/);
  assert.ok($("#postit-wall .postit").classList.contains("stick-in"), "animation de collage");
  // vide refusé
  $("#attach-postit").click(); await tick(20);
  $("#postit-form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await tick(40);
  assert.equal(f.db.postits.length, 1);
  assert.equal($("#postit-message").hidden, false);
  $("#dialog-postit").removeAttribute("open");
  chat.stop();
}
{
  // un autre membre : le Post-it s'affiche, se décolle, se recolle, se jette
  const { f, chat } = await session(camille, "member");
  chat.stop();
  f.db.postits.push({ id: "p1", channel_id: "c1", user_id: "u1", body: "Réunion à 18 h\nsalle B", created_at: "2026-11-14T08:00:00.000Z" });
  f.db.postits.push({ id: "p2", channel_id: "c1", user_id: "u1", body: "Deuxième mot", created_at: "2026-11-14T09:00:00.000Z" });
  f.db.postits.push({ id: "p9", channel_id: "c2", user_id: "u1", body: "Autre fil", created_at: "2026-11-14T09:00:00.000Z" });
  const again = createChat({ supabase: f, user: camille });
  await again.start(); await openLast(); await tick(150);
  assert.equal($$("#postit-wall .postit").length, 2, "les Post-it de ce fil seulement");
  assert.ok(!/Autre fil/.test($("#postit-wall").textContent));
  // décoller
  $('#postit-wall [data-id="p1"]').click(); await tick(30);
  assert.ok($('#postit-wall [data-id="p1"]').classList.contains("peeling"), "animation de décollage");
  assert.equal($("#dialog-postit-read").hasAttribute("open"), false, "pas encore ouvert pendant l'animation");
  await wait(450);
  assert.ok($("#dialog-postit-read").hasAttribute("open"), "ouvert en grand");
  assert.match($("#postit-read-note").textContent, /Réunion à 18 h/);
  assert.match($("#postit-read-when").textContent, /Thierry/);
  assert.equal($("#postit-delete-all").hidden, true, "pas l'auteur, pas administrateur");
  // garder : il revient
  assert.equal($("#postit-edit").hidden, true, "pas de crayon pour un non-auteur");
  $("#postit-read-note").click(); await tick(40);
  assert.equal($("#dialog-postit-read").hasAttribute("open"), false);
  assert.equal($$("#postit-wall .postit").length, 2, "le Post-it est recollé");
  assert.equal(f.db.postit_states.length, 0, "rien de jeté");
  // jeter
  $('#postit-wall [data-id="p1"]').click(); await wait(450);
  $("#postit-throw").click(); await tick(60);
  assert.ok($("#postit-read-note .postit").classList.contains("crumpling"), "animation de froissement");
  await wait(800);
  assert.equal($("#dialog-postit-read").hasAttribute("open"), false);
  assert.deepEqual(f.db.postit_states.map((r) => [r.postit_id, r.user_id, r.state]), [["p1", "u2", "discarded"]]);
  assert.equal($$("#postit-wall .postit").length, 1);
  assert.ok(!/Réunion/.test($("#postit-wall").textContent));
  again.stop();

  // rouvrir le fil : p1 n'est plus là pour moi, p2 revient toujours
  const third = createChat({ supabase: f, user: camille });
  await third.start(); await openLast(); await tick(150);
  assert.equal($$("#postit-wall .postit").length, 1);
  assert.match($("#postit-wall").textContent, /Deuxième mot/);
  // Post-it jetés
  $("#channel-postits").click(); await tick(40);
  assert.ok($("#dialog-postit-trash").hasAttribute("open"));
  assert.equal($$("#postit-trash-list .postit").length, 1);
  assert.match($("#postit-trash-list").textContent, /Réunion à 18 h/);
  $("#postit-trash-list [data-restore]").click(); await tick(60);
  assert.equal($$("#postit-wall .postit").length, 2, "remis en haut du fil");
  assert.equal(f.db.postit_states.length, 0);
  assert.match($("#postit-trash-list").textContent, /Aucun Post-it jeté/);
  // rejeter puis jeter définitivement
  $("#dialog-postit-trash").removeAttribute("open");
  $('#postit-wall [data-id="p1"]').click(); await wait(450);
  $("#postit-throw").click(); await wait(850);
  $("#channel-postits").click(); await tick(40);
  $("#postit-trash-list [data-purge]").click(); await tick(60);
  assert.equal(f.db.postit_states[0].state, "purged");
  assert.match($("#postit-trash-list").textContent, /Aucun Post-it jeté/);
  $("#dialog-postit-trash").removeAttribute("open");
  third.stop();
  // pour Thierry (autre personne), rien n'a changé
  if (!f.db.workspace_members.some((m) => m.user_id === "u1")) f.db.workspace_members.push({ workspace_id: "w1", user_id: "u1", role: "member" });
  Object.assign(camille, { id: "u1", email: "me@x.fr" }); // le faux Supabase suit l'objet utilisateur de sa création
  const author = createChat({ supabase: f, user: camille });
  await author.start(); await openLast(); await tick(150);
  assert.equal($$("#postit-wall .postit").length, 2, "l'état est personnel : l'auteur voit toujours les deux");
  // l'auteur peut le retirer pour tous
  $('#postit-wall [data-id="p2"]').click(); await wait(450);
  assert.equal($("#postit-delete-all").hidden, false);
  assert.equal($("#postit-edit").hidden, false, "crayon pour l'auteur");
  $("#postit-edit").click(); await tick(60);
  assert.equal($("#dialog-postit-read").hasAttribute("open"), false);
  assert.ok($("#dialog-postit").hasAttribute("open"));
  assert.equal($("#postit-input").value, "Deuxième mot");
  assert.equal($("#postit-submit").textContent, "Enregistrer");
  $("#postit-input").value = "Deuxième mot corrigé";
  $("#postit-form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await tick(80);
  assert.equal(f.db.postits.find((p) => p.id === "p2").body, "Deuxième mot corrigé");
  assert.match($("#postit-wall").textContent, /Deuxième mot corrigé/);
  assert.equal($("#dialog-postit").hasAttribute("open"), false);
  $('#postit-wall [data-id="p2"]').click(); await wait(450);
  $("#postit-delete-all").click(); await tick(80);
  assert.equal(f.db.postits.some((p) => p.id === "p2"), false);
  assert.equal($$("#postit-wall .postit").length, 1);
  author.stop();
}
{
  // arrivée en temps réel
  const { f, chat } = await session(camille, "member");
  f.emit("postits", { eventType: "INSERT", new: { id: "rt1", channel_id: "c1", user_id: "u1", body: "En direct", created_at: "2026-11-14T10:00:00.000Z" } });
  await tick(100);
  assert.match($("#postit-wall").textContent, /En direct/);
  chat.stop();
}
console.log("postit ok");
