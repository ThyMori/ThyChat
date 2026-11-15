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
const { PALETTE, themeByKey, themeFor, pickUnusedTheme } = await import(`${REPO}/js/themes.js`);
const notify = await import(`${REPO}/js/notify.js`);

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const submit = (form) => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
const change = (node) => node.dispatchEvent(new window.Event("change", { bubbles: true }));
let passed = 0;
const ok = (name) => console.log("  ✓", name) || passed++;
const itemFor = (id) => $(`.channel-item[data-id="${id}"]`);
const names = (sel) => $$(sel).map((n) => n.querySelector(".channel-name").textContent);
const resetDom = () => {
  localStorage.clear();
  for (const d of $$("dialog")) d.removeAttribute("open");
  $("#messages").replaceChildren();
};
const msg = (id, channel, user, body, at) => ({
  id, channel_id: channel, user_id: user, parent_id: null, pinned: false, edited_at: null, body, created_at: at,
});




const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };

const thierry = { id: "u1", email: "me@x.fr", user_metadata: {} };
const f = makeFake(thierry);
f.db.workspaces.push({ id: "w1", name: "Compagnie", created_by: "u1", theme: "violet" });
f.db.workspace_members.push({ workspace_id: "w1", user_id: "u1", role: "admin" });
f.db.rooms.push({ id: "r1", workspace_id: "w1", name: "Hamlet", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
//, workspace_id: "w1", name: "Lear", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
f.db.tour_tags.push({ id: "t1", room_id: "r1", label: "Lausanne", start_date: "2026-11-09", end_date: "2026-11-13", shows: [] }, { id: "t2", room_id: "r1", label: "Paris", start_date: "2026-11-20", end_date: "2026-11-22", shows: [] });
f.db.channels.push({ id: "c1", workspace_id: "w1", room_id: "r1", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
//, workspace_id: "w1", room_id: "r2", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
const chat = createChat({ supabase: f, user: thierry });
await chat.start(); await openLast();
await tick(100);




const pdf = (name, size = 1000, type = "application/pdf") => { const file = new window.File([new Uint8Array(4)], name, { type }); Object.defineProperty(file, "size", { value: size }); return file; };
const opened = [];
window.open = () => ({ location: { set href(v) { opened.push(v); } }, close() {} });
const pickSheet = async (file) => { Object.defineProperty($("#sheet-file"), "files", { value: Array.isArray(file) ? file : [file], configurable: true }); change($("#sheet-file")); await tick(120); };

assert.equal($("#room-sheet").hidden, false);
assert.equal($("#room-sheet-label").textContent, "Fiche technique");
$("#room-sheet").click(); await tick(40);
assert.ok($("#dialog-sheet").hasAttribute("open"));
assert.equal($("#sheet-form").hidden, false);
assert.match($("#sheet-list").textContent, /Aucune fiche/);
// version 1 (date choisie)
$("#sheet-date").value = "2026-10-02";
await pickSheet(pdf("Fiche v1.pdf", 300000));
// sans date : refusé
$("#sheet-date").value = "";
$("#sheet-pick").click(); await tick(20);
assert.match($("#sheet-message").textContent, /date/i);
// mauvais fichier / trop gros
$("#sheet-date").value = "2026-11-05";
await pickSheet(pdf("notes.txt", 100, "text/plain"));
assert.match($("#sheet-message").textContent, /ni un PDF ni une image/);
await pickSheet(pdf("énorme.pdf", 20 * 1024 * 1024));
assert.match($("#sheet-message").textContent, /15 Mo/);
assert.equal(f.db.room_sheets.length, 1);
// version 2 plus récente
await pickSheet(pdf("Fiche v2.pdf", 410000));
assert.equal(f.db.room_sheets.length, 2);
assert.ok(f.db.room_sheets.every((s) => s.path.startsWith("r1/fiche/") && s.path.endsWith(".pdf")));
assert.equal(f.storage.docFiles.size, 2);
assert.match($("#sheet-list").textContent, /Version la plus récente/);
const latestText = $("#sheet-list .docs-tag:first-child").textContent;
assert.match(latestText, /5 nov/);
assert.match(latestText, /Fiche v2\.pdf/);
assert.match($("#sheet-list .docs-tag:last-child").textContent, /Version du 2 oct/);
assert.match($("#room-sheet-label").textContent, /5 nov/);
ok("un administrateur ajoute des versions datées ; la plus récente est en avant");

// plusieurs fichiers pour une même version : images, PDF, lien
$("#sheet-date").value = "2026-11-10";
await pickSheet([pdf("Plan son.pdf", 5000), pdf("Plan lumière.png", 7000, "image/png")]);
assert.equal(f.db.room_sheets.length, 4);
const png = f.db.room_sheets.find((r) => r.name === "Plan lumière.png");
assert.ok(png.path.endsWith(".png"), "image rangée en .png");
$("#sheet-label").value = "Plan plateau";
$("#sheet-url").value = "javascript:alert(1)";
$("#sheet-add-link").click(); await tick(60);
assert.match($("#sheet-message").textContent, /lien web valable/);
assert.equal(f.db.room_sheets.length, 4);
$("#sheet-url").value = "drive.google.com/plans";
$("#sheet-add-link").click(); await tick(80);
assert.equal(f.db.room_sheets.length, 5);
const lien = f.db.room_sheets.find((r) => r.kind === "link");
assert.equal(lien.url, "https://drive.google.com/plans");
assert.equal(lien.name, "Plan plateau");
const firstSection = $("#sheet-list .docs-tag:first-child");
assert.equal(firstSection.querySelectorAll("a.doc-open").length, 3, "3 documents dans la version la plus récente");
const linkAnchor = [...firstSection.querySelectorAll("a.doc-open")].find((a) => /Plan plateau/.test(a.textContent));
assert.equal(linkAnchor.getAttribute("href"), "https://drive.google.com/plans");
ok("une fiche réunit plusieurs fichiers (PDF, image) et un lien ; un lien dangereux est refusé");
// retire ces ajouts pour la suite (le bouton X de chacun)
for (let i = 0; i < 3; i++) { $("#sheet-list .docs-tag:first-child [data-del-sheet]").click(); await tick(80); }
assert.equal(f.db.room_sheets.length, 2);
assert.equal(f.storage.docFiles.size, 2, "les fichiers retirés sont supprimés du stockage");


await tick(60);
assert.match($("#sheet-list a.doc-open").getAttribute("href"), /sign\/tag-documents\/r1\/fiche\//);
assert.equal($("#sheet-list a.doc-open").target, "_blank");
ok("la fiche s'ouvre par lien temporaire");

$$("#sheet-list [data-del-sheet]")[0].click(); await tick(100);
assert.equal(f.db.room_sheets.length, 1);
assert.equal(f.storage.docFiles.size, 1);
assert.match($("#room-sheet-label").textContent, /2 oct/);
ok("retirer une version supprime son fichier");
$("#dialog-sheet [data-close]").click();
chat.stop();

// simple utilisateur avec la case « lit la fiche technique »
f.db.room_staff.push({ room_id: "r1", user_id: "u1", functions: [], sheet_read: true });
f.db.workspace_members.find((m) => m.user_id === "u1").role = "member";
f.db.profiles.find((p) => p.id === "u1").is_super_admin = false;
const chat2 = createChat({ supabase: f, user: thierry });
await chat2.start(); await openLast(); await tick(150);
assert.equal($("#room-sheet").hidden, false);
$("#room-sheet").click(); await tick(40);
assert.equal($("#sheet-form").hidden, true);
assert.equal($$("#sheet-list [data-del-sheet]").length, 0);
await tick(60);
assert.match($("#sheet-list a.doc-open").getAttribute("href"), /sign\/tag-documents/);
const ins = await f.from("room_sheets").insert({ room_id: "r1", name: "x.pdf", path: "r1/fiche/x.pdf", version_date: "2026-11-06" }).select().single();
assert.ok(ins.error, "la base refuse l'ajout par un utilisateur");
ok("un utilisateur lit la fiche mais ne peut ni l'ajouter ni la retirer");
$("#dialog-sheet [data-close]").click();
chat2.stop();

// spectacle sans fiche : bouton caché pour un utilisateur
f.db.room_sheets.length = 0;
const chat3 = createChat({ supabase: f, user: thierry });
await chat3.start(); await openLast(); await tick(150);
assert.equal($("#room-sheet").hidden, true);
ok("sans fiche, pas de bouton pour un utilisateur");
chat3.stop();
console.log(`\n${passed} vérifications réussies`);
