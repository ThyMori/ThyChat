import fs from "node:fs";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { makeFake } from "./fake.mjs";

const REPO = new URL("../dist", import.meta.url).pathname; // les tests s'exécutent sur le résultat du build
const html = fs.readFileSync(`${REPO}/index.html`, "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
let passed = 0;
const ok = (n) => console.log("  ✓", n) || passed++;
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

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

// u1 = administrateur ; u2 = Prod ; u3 = Technique ; u4 = membre sans fonction ; u5 = membre avec « lit la fiche » ; u6 = RG
const users = (me) => ({ id: me, email: me + "@x.fr", user_metadata: {} });
async function boot(meId) {
  // état commun, recréé pour chaque profil (la fenêtre reste la même)
  const f = makeFake(users(meId));
  f.db.profiles = [];
  f.db.workspaces.push({ id: "w1", name: "Cie A", created_by: "u1", theme: "violet" });
  for (const [id, role] of [["u1", "admin"], ["u2", "member"], ["u3", "member"], ["u4", "member"], ["u5", "member"], ["u6", "member"]]) f.db.workspace_members.push({ workspace_id: "w1", user_id: id, role });
  f.db.rooms.push({ id: "r1", workspace_id: "w1", name: "Hamlet", description: null, everyone: false, created_at: "2026-11-01T00:00:00Z" });
  for (const id of ["u2", "u3", "u4", "u5", "u6"]) f.db.room_members.push({ room_id: "r1", user_id: id });
  f.db.channels.push({ id: "c1", workspace_id: "w1", room_id: "r1", name: "Général", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
  f.db.room_staff.push(
    { room_id: "r1", user_id: "u2", functions: ["prod"], sheet_read: true },
    { room_id: "r1", user_id: "u3", functions: ["technique"], sheet_read: true },
    { room_id: "r1", user_id: "u5", functions: [], sheet_read: true },
    { room_id: "r1", user_id: "u6", functions: ["rg"], sheet_read: false },
  );
  f.db.tour_tags.push({ id: "t1", room_id: "r1", label: "Lyon", start_date: "2026-12-01", end_date: "2026-12-02", shows: [] });
  f.db.room_sheets.push({ id: "s1", room_id: "r1", name: "Plan feu", path: "r1/fiche/a.pdf", version_date: "2026-11-01", created_at: "2026-11-01T00:00:00Z" });
  f.db.tag_documents.push({ id: "d1", tag_id: "t1", name: "FDR Lyon", path: "r1/t1/a.pdf", created_at: "2026-11-01T00:00:00Z" });
  const chat = createChat({ supabase: f, user: users(meId) });
  await chat.start(); await tick(150);
  await globalThis.openLast?.();
  const room = $$("#channel-list .room-group").find((g) => g.querySelector("[data-room-team]") || true);
  return { f, chat };
}
const stop = (c) => c.chat.stop();

// 1. administrateur : 👥 et ⚙, fiche technique + ajout
let c = await boot("u1");
assert.ok($("[data-room-team]")); assert.ok($("[data-room-edit]")); ok("admin : boutons Équipe et réglages");
$("#room-sheet").click?.(); await tick(30);
assert.equal($("#room-sheet").hidden, false);
stop(c);

// 2. Prod : 👥 sans ⚙ ; LIT la fiche technique sans la modifier ; modifie les feuilles de route
c = await boot("u2");
assert.ok($("[data-room-team]")); assert.equal($("[data-room-edit]"), null); ok("Prod : Équipe sans réglages du spectacle");
assert.equal($("#room-sheet").hidden, false); $("#room-sheet").click(); await tick(60);
assert.equal($("#sheet-list").textContent.includes("Plan feu"), true);
assert.equal($("#sheet-form").hidden, true); ok("Prod : lit la fiche technique sans la modifier");
assert.equal($("#sheet-list [data-del-sheet]"), null, "Prod : pas de croix de retrait");
$("#dialog-sheet").close?.();
if ($("#tag-bar").classList.contains("dates-open") === false) { $("#tags-toggle").click(); await tick(40); }
document.querySelector(".doc-badge")?.click(); await tick(60);
assert.ok($("[data-add-doc]"), "Prod : + Fichier"); ok("Prod : ajoute des feuilles de route");
$("#dialog-docs").close?.(); $("#dialog-sheet").close?.();
stop(c);

// 3. Technique : modifie la fiche, pas d'Équipe
c = await boot("u3");
assert.equal($("[data-room-team]"), null); ok("Technique : n'assigne personne");
$("#room-sheet").click(); await tick(60);
assert.equal($("#sheet-form").hidden, false); ok("Technique : modifie la fiche technique");
$("#dialog-sheet").close?.();
if ($("#tag-bar").classList.contains("dates-open") === false) { $("#tags-toggle").click(); await tick(40); }
document.querySelector(".doc-badge")?.click(); await tick(60);
assert.equal($("[data-add-doc]"), null, "Technique : pas de + Fichier"); ok("Technique : ne modifie pas les feuilles de route");
stop(c);

// 3b. RG : modifie la fiche technique, assigne, mais ne modifie pas les feuilles de route
c = await boot("u6");
assert.ok($("[data-room-team]")); ok("RG : assigne des personnes");
assert.equal($("#room-sheet").hidden, false); $("#room-sheet").click(); await tick(60);
assert.equal($("#sheet-form").hidden, false); ok("RG : modifie la fiche technique");
$("#dialog-sheet").close?.();
if ($("#tag-bar").classList.contains("dates-open") === false) { $("#tags-toggle").click(); await tick(40); }
document.querySelector(".doc-badge")?.click(); await tick(60);
assert.equal($("[data-add-doc]"), null, "RG : pas de + Fichier"); ok("RG : lit les feuilles de route sans les modifier");
stop(c);

// 4. Membre sans fonction ni lecture : pas de fiche technique ; lit les feuilles de route sans les modifier
c = await boot("u4");
assert.equal($("[data-room-team]"), null);
assert.equal($("#room-sheet").hidden, true); ok("membre sans droit : fiche technique invisible");
stop(c);

// 5. Membre « lit la fiche » : lecture seule
c = await boot("u5");
assert.equal($("#room-sheet").hidden, false);
$("#room-sheet").click(); await tick(60);
assert.equal($("#sheet-form").hidden, true); ok("« lit la fiche » : lecture seule");
stop(c);

// 6. Prod : fenêtre Équipe, donne la fonction Technique à u4 et l'accès à u... puis enregistre
c = await boot("u2");
$("[data-room-team]").click(); await tick(200);
assert.equal($("#dialog-team").open, true);
const row = (id) => $(`#team-list .team-row[data-user="${id}"]`);
assert.ok(row("u1").textContent.includes("Tous les droits"));
assert.equal(row("u2").querySelector('[data-opt="prod"]').disabled, true); ok("Prod ne peut pas se retirer ses droits");
const tech = row("u4").querySelector('[data-opt="technique"]');
tech.checked = true; tech.dispatchEvent(new window.Event("change", { bubbles: true }));
assert.equal(row("u4").querySelector('[data-opt="sheet_read"]').checked, true); ok("une fonction coche « lit la fiche »");
$("#team-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick(250);
assert.deepEqual(c.f.db.room_staff.find((r) => r.user_id === "u4").functions, ["technique"]); ok("Prod assigne une fonction");
// retirer l'accès de u5 : sort de room_members et de la fiche
await (async () => {
  $("[data-room-team]").click(); await tick(200);
  row("u5").querySelector('[data-opt="access"]').checked = false;
  $("#team-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await tick(250);
})();
assert.equal(c.f.db.room_members.some((m) => m.user_id === "u5"), false); ok("Prod retire l'accès d'une personne");
stop(c);

console.log(`\n${passed} vérifications OK`);
process.exit(0);
