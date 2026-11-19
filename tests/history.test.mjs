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
const { groupByDay, unreadCount } = await import(`${REPO}/js/historique.js`);
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (n) => console.log("  ✓", n) || passed++;

// --- logique pure : regroupement par jour et comptage
const now = new Date();
const at = (daysAgo, h) => { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, h, 5); return d.toISOString(); };
const L = (id, daysAgo, h, read) => ({ id, user_id: "u1", kind: "message", title: "T" + id, body: "B" + id, workspace_id: "w1", channel_id: "c1", created_at: at(daysAgo, h), read_at: read ? "x" : null });
const groups = groupByDay([L("a", 0, 9), L("b", 1, 18), L("c", 0, 12), L("d", 5, 10)]);
assert.deepEqual(groups.map((g) => g.label).slice(0, 2), ["Aujourd'hui", "Hier"]);
assert.deepEqual(groups[0].entries.map((e) => e.id), ["c", "a"], "les plus récentes d'abord");
assert.equal(groups.length, 3);
assert.equal(unreadCount([L("a", 0, 1, true), L("b", 0, 2, false)]), 1); ok("regroupement par jour (Aujourd'hui, Hier) et comptage des non lues");

// --- interface
const me = { id: "u1", email: "me@x.fr", user_metadata: {} };
const f = makeFake(me);
f.db.workspaces.push({ id: "w1", name: "Cie A", created_by: "u1", theme: "violet" }, { id: "w2", name: "Cie B", created_by: "u1", theme: "teal" });
f.db.workspace_members.push({ workspace_id: "w1", user_id: "u1", role: "user" }, { workspace_id: "w2", user_id: "u1", role: "user" });
const room = (id, ws, name) => ({ id, workspace_id: ws, name, description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
f.db.rooms.push(room("r1", "w1", "Hamlet"), room("r2", "w2", "Lear"));
const ch = (id, ws, rm) => ({ id, workspace_id: ws, room_id: rm, name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
f.db.channels.push(ch("c1", "w1", "r1"), ch("c2", "w2", "r2"));
f.db.notification_log.push(
  { ...L("n1", 0, 9), channel_id: "c1", created_at: new Date(Date.now() - 2000).toISOString() }, // « tout juste reçue » : indépendant de l'heure du test
  { ...L("n2", 1, 18), workspace_id: "w2", channel_id: "c2", title: "Lear › Tous · Cie B", body: "Camille : à demain" },
  { ...L("n3", 3, 10, true), kind: "doc", title: "📄 Nouveau PDF · Hamlet", body: "Marc a ajouté Fiche technique" },
  { ...L("n-autre", 0, 8), user_id: "u2", title: "secret d'un autre" },
);
const chat = createChat({ supabase: f, user: me });
await chat.start(); await tick(200);

// 1. cloche dans l'en-tête, pastille rouge pour les non lues (les miennes seulement)
assert.ok($("#open-history")); assert.match($("#open-history").getAttribute("aria-label"), /2 non lue/);
assert.equal($("#open-history").classList.contains("has-new"), true);
assert.equal($("#open-sidebar").classList.contains("has-new"), true); ok("cloche avec pastille (aussi sur ☰), 2 non lues");

// 2. ouverture : lignes datées, personne d'autre, nouvelles mises en valeur, puis marquées lues
$("#open-history").click(); await tick(150);
assert.equal($("#dialog-history").open, true);
const rows = $$("#history-list .history-row");
assert.equal(rows.length, 3, "mes 3 lignes seulement");
assert.equal($("#history-list").textContent.includes("secret d'un autre"), false); ok("seules MES notifications sont listées");
assert.deepEqual($$("#history-list .history-day").map((h) => h.textContent).slice(0, 2), ["Aujourd'hui", "Hier"]);
assert.equal($$("#history-list .history-row.fresh").length, 2); ok("jours « Aujourd'hui / Hier », non lues mises en valeur");
assert.match(rows[0].querySelector(".history-time").textContent, /^\d\d:\d\d$/); ok("heure affichée");
assert.equal(f.db.notification_log.filter((r) => r.user_id === "u1" && !r.read_at).length, 0, "marquées lues en base");
assert.equal($("#open-history").classList.contains("has-new"), false); ok("ouvrir la cloche marque tout comme lu, la pastille disparaît");
assert.equal(f.db.notification_log.find((r) => r.id === "n-autre").read_at, null, "celle d'un autre n'est pas touchée");

// 3. toucher une ligne d'un AUTRE espace ouvre le bon sous-salon
rows[1].click(); await tick(250);
assert.equal($("#dialog-history").open, false);
assert.equal($("#channel-title").textContent, "Lear"); ok("une ligne ouvre le sous-salon (même dans un autre espace)");

// 4. nouvelle notification en temps réel
f.db.notification_log.push({ ...L("n4", 0, 23), id: "n4", title: "Nouveau en direct", created_at: new Date(Date.now() + 1000).toISOString() });
f.emit("notification_log", { eventType: "INSERT", new: f.db.notification_log.at(-1) }); await tick(80);
assert.equal($("#open-history").classList.contains("has-new"), true); ok("une notification reçue en direct allume la pastille");
$("#open-history").click(); await tick(120);
assert.equal($$("#history-list .history-row").length, 4); assert.match($$("#history-list .history-row")[0].textContent, /Nouveau en direct/); ok("elle apparaît en tête de liste");

// 5. tout effacer : seulement les miennes
$("#history-clear").click(); await tick(120);
assert.equal(f.db.notification_log.filter((r) => r.user_id === "u1").length, 0);
assert.equal(f.db.notification_log.filter((r) => r.user_id === "u2").length, 1);
assert.match($("#history-list").textContent, /Aucune notification pour l'instant/); ok("« Tout effacer » vide mon historique sans toucher aux autres, état vide explicite");
chat.stop();

// 6. migration 033 pas encore collée : la cloche ne casse rien
const g = makeFake(me, { failTable: "notification_log", failMessage: 'relation "notification_log" does not exist' });
g.db.workspaces.push({ id: "w1", name: "Cie A", created_by: "u1", theme: "violet" });
g.db.workspace_members.push({ workspace_id: "w1", user_id: "u1", role: "user" });
g.db.rooms.push(room("r1", "w1", "Hamlet")); g.db.channels.push(ch("c1", "w1", "r1"));
const chat2 = createChat({ supabase: g, user: me });
await chat2.start(); await tick(200);
$("#dialog-history").removeAttribute("open");
$("#open-history").click(); await tick(120);
assert.match($("#history-list").textContent, /pas encore disponible/);
assert.equal($("#open-history").classList.contains("has-new"), false);
assert.equal($("#channel-title").textContent.length > 0, true); ok("sans la table, message clair et l'application fonctionne");
chat2.stop();
console.log(`\n${passed} vérifications OK`);
process.exit(0);
