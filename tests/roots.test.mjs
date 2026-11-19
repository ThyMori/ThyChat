import fs from "node:fs";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { makeFake } from "./fake.mjs";
const REPO = new URL("../dist", import.meta.url).pathname; // les tests s'exécutent sur le résultat du build
const html = fs.readFileSync(`${REPO}/index.html`, "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
const dom = new JSDOM(html, { url: "https://thychat.thierry-morin.com/" });
const { window } = dom;
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, AbortController: window.AbortController });
Object.defineProperty(globalThis, "location", { value: window.location, configurable: true });
Object.defineProperty(globalThis, "history", { value: window.history, configurable: true });
document.getElementById("screen-app").hidden = false;
const { createChat } = await import(`${REPO}/js/messagerie.js`);
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const dd = new Date(); dd.setDate(dd.getDate() - 1);
const YESTERDAY = `${dd.getFullYear()}-${pad(dd.getMonth() + 1)}-${pad(dd.getDate())}`;
const th = { id: "u1", email: "me@x.fr", user_metadata: {} };
const f = makeFake(th);
f.db.workspaces.push({ id: "w1", name: "Cie", created_by: "u1", theme: "violet" });
f.db.workspace_members.push({ workspace_id: "w1", user_id: "u1", role: "admin" });
f.db.rooms.push({ id: "r1", workspace_id: "w1", name: "Hamlet", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
f.db.channels.push({ id: "c1", workspace_id: "w1", room_id: "r1", name: "Général", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
f.db.channels.push({ id: "c2", workspace_id: "w1", room_id: "r1", name: "Technique", kind: "channel", everyone: true, description: null, created_at: "2026-11-02T00:00:00Z" });
const chat = createChat({ supabase: f, user: th });
await chat.start(); await openLast();
await tick(80);
const rows = () => $$("#channel-list .channel-item").map((i) => i.querySelector(".channel-name").textContent);
// racine ouverte au démarrage, sous-salons repliés, « Général » absent de la liste
assert.equal($("#channel-title").textContent, "Hamlet", "le titre de la racine est le nom du spectacle");
// ouvrir un spectacle depuis la liste le déplie ; « Général » n'apparaît pas (c'est la ligne du spectacle)
assert.deepEqual(rows(), ["Hamlet", "Technique", "Mes notes"], "le spectacle ouvert est déplié");
assert.equal($(".room-chev").getAttribute("aria-expanded"), "true");
// la flèche replie, puis déplie
$(".room-chev").click();
assert.deepEqual(rows(), ["Hamlet"], "replié : seule la ligne du spectacle");
$(".room-chev").click();
assert.deepEqual(rows(), ["Hamlet", "Technique", "Mes notes"]);
$(`.channel-item[data-id="c2"]`).click();
await tick(80);
assert.equal($("#channel-title").textContent, "Technique");
// replier alors qu'on est dans Technique : possible
$(".room-chev").click();
assert.deepEqual(rows(), ["Hamlet"], "on peut replier même avec un sous-salon ouvert");
// un appui sur le spectacle revient au « Général »
$(".room-root").click();
await tick(80);
assert.equal($("#channel-title").textContent, "Hamlet");
assert.equal($(".room-root").getAttribute("aria-current"), "true");
assert.deepEqual(rows(), ["Hamlet", "Technique", "Mes notes"], "toucher le spectacle replié (même le seul de l'espace) le déplie");
// changement de spectacle : le précédent se replie, le nouveau se déplie
f.db.rooms.push({ id: "r2", workspace_id: "w1", name: "Lear", description: null, everyone: true, created_at: "2026-11-03T00:00:00Z" });
f.db.channels.push({ id: "c3", workspace_id: "w1", room_id: "r2", name: "Général", kind: "channel", everyone: true, description: null, created_at: "2026-11-03T00:00:00Z" });
f.db.channels.push({ id: "c4", workspace_id: "w1", room_id: "r2", name: "Musiciens", kind: "channel", everyone: true, description: null, created_at: "2026-11-04T00:00:00Z" });
await chat.start?.(); await tick(150);
const chev = (room) => $(`.room-chev[data-room="${room}"]`);
if (chev("r1").getAttribute("aria-expanded") !== "true") chev("r1").click();
$(`.channel-item[data-id="c2"]`).click(); await tick(80);
assert.equal(chev("r1").getAttribute("aria-expanded"), "true", "Hamlet déplié (Technique ouvert)");
assert.equal(chev("r2").getAttribute("aria-expanded"), "false");
$(`.room-root[data-id="c3"]`).click(); await tick(80);
assert.equal($("#channel-title").textContent, "Lear");
assert.equal(chev("r1").getAttribute("aria-expanded"), "false", "le spectacle précédent se replie");
assert.equal(chev("r2").getAttribute("aria-expanded"), "true", "le spectacle choisi se déplie");
assert.ok(rows().includes("Musiciens") && !rows().includes("Technique"), "seuls les sous-salons du spectacle choisi sont montrés");
// rester dans le même spectacle ne change rien
$(`.channel-item[data-id="c4"]`).click(); await tick(80);
assert.equal(chev("r2").getAttribute("aria-expanded"), "true");
assert.equal(chev("r1").getAttribute("aria-expanded"), "false");
// plusieurs spectacles dépliés (état gardé d'une ancienne session) : changer de spectacle les replie tous sauf le choisi
chev("r1").click();
assert.equal(chev("r1").getAttribute("aria-expanded"), "true");
assert.equal(chev("r2").getAttribute("aria-expanded"), "true", "deux spectacles dépliés");
$(`.channel-item[data-id="c2"]`).click(); await tick(80);
assert.equal(chev("r1").getAttribute("aria-expanded"), "true");
assert.equal(chev("r2").getAttribute("aria-expanded"), "false", "l'autre spectacle déplié se replie");
console.log("roots ok");
chat.stop();
