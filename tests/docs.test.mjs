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
f.db.tour_tags.push({ id: "t1", room_id: "r1", label: "Lausanne", start_date: "2099-11-09", end_date: "2099-11-13", shows: [] }, { id: "t2", room_id: "r1", label: "Paris", start_date: "2099-11-20", end_date: "2099-11-22", shows: [] });
f.db.channels.push({ id: "c1", workspace_id: "w1", room_id: "r1", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
//, workspace_id: "w1", room_id: "r2", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
const chat = createChat({ supabase: f, user: thierry });
await chat.start(); await openLast();
await tick(100);



const pdf = (name, size = 1000, type = "application/pdf") => { const file = new window.File([new Uint8Array(4)], name, { type }); Object.defineProperty(file, "size", { value: size }); return file; };
window.open = () => ({ location: { set href(v) { opened.push(v); } }, close() {} });
const opened = [];
const pick = async (files) => { Object.defineProperty($("#docs-file"), "files", { value: files, configurable: true }); change($("#docs-file")); await tick(120); };

// administrateur
assert.equal($("#tags-docs"), null, "plus de bouton Documents dans l'en-tête");
assert.equal($$("#tag-filter .doc-badge").length, 1, "dates repliées : seulement la prochaine date et son badge");
$("#tags-toggle").click(); await tick(20);
assert.equal($$("#tag-filter .doc-badge").length, 2, "un badge documents par date");
$('#tag-filter [data-docs-tag="t1"]').click(); await tick(40);
assert.ok($("#dialog-docs").hasAttribute("open"));
assert.equal($$("#docs-list .docs-tag").length, 1, "uniquement la date touchée");
assert.equal($$("#docs-list [data-add-doc]").length, 1);
$$("#docs-list [data-add-doc]")[0].click();
await pick([pdf("Feuille de route.pdf", 250000), pdf("Billets.pdf", 90000), pdf("notes.txt", 100, "text/plain"), pdf("gros.pdf", 20 * 1024 * 1024)]);
assert.equal(f.db.tag_documents.length, 2);
assert.ok(f.db.tag_documents.every((d) => d.tag_id === "t1" && d.path.startsWith("r1/t1/") && d.path.endsWith(".pdf")));
assert.equal(f.storage.docFiles.size, 2);
assert.match($("#docs-message").textContent, /notes\.txt.*ni un PDF ni une image/);
assert.match($("#docs-message").textContent, /gros\.pdf.*15 Mo/);
assert.equal($$("#docs-list .doc-row").length, 2);
assert.match($("#docs-list").textContent, /Feuille de route\.pdf/);
assert.match($("#docs-list").textContent, /244 Ko/);
assert.equal($('#tag-filter [data-docs-tag="t1"]').textContent.trim(), "2", "le badge compte les documents");
ok("un administrateur ajoute des PDF à une date (autres fichiers et fichiers trop gros refusés)");

// envoi lent : un message « Envoi en cours » dit où ça en est, un second envoi est refusé (l'envoi finit ici en échec réseau : rien n'est ajouté)
{
  const realFrom = f.storage.from;
  f.storage.from = function (bucket) {
    const o = realFrom.call(this, bucket);
    o.upload = async () => { await tick(200); return { error: { message: "Failed to fetch" } }; };
    return o;
  };
  $$("#docs-list [data-add-doc]")[0].click();
  Object.defineProperty($("#docs-file"), "files", { value: [pdf("Lent.pdf", 3 * 1024 * 1024)], configurable: true });
  change($("#docs-file")); await tick(60);
  assert.match($("#docs-message").textContent, /Envoi en cours.*Lent\.pdf/);
  assert.equal($("#docs-message").dataset.kind, "busy");
  $$("#docs-list [data-add-doc]")[0].click();
  change($("#docs-file")); await tick(20);
  assert.match($("#docs-message").textContent, /déjà en cours/, "pas de second envoi pendant le premier");
  await tick(350);
  assert.match($("#docs-message").textContent, /Lent\.pdf.*Failed to fetch/);
  assert.equal(f.db.tag_documents.length, 2, "l'envoi en échec n'ajoute rien");
  f.storage.from = realFrom;
  ok("envoi de PDF : message « Envoi en cours », double envoi refusé");
}

await tick(60);
const link0 = $$("#docs-list a.doc-open")[0];
assert.equal(link0.target, "_blank");
assert.match(link0.getAttribute("href"), /object\/sign\/tag-documents\/r1\/t1\//);
assert.ok(!link0.hasAttribute("aria-busy"));
ok("un PDF est un vrai lien temporaire (ouvre un nouvel onglet)");

// image et lien web
$$("#docs-list [data-add-doc]")[0].click();
await pick([pdf("Plan salle.jpg", 3000, "image/jpeg")]);
assert.equal(f.db.tag_documents.length, 3);
assert.ok(f.db.tag_documents.some((d) => d.path.endsWith(".jpg")));
$$("#docs-list [data-add-link]")[0].click();
assert.equal($("#docs-link-form").hidden, false);
$("#docs-link-url").value = "data:text/html,<script>1</script>";
$("#docs-link-form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await tick(60);
assert.match($("#docs-message").textContent, /lien web valable/);
$("#docs-link-name").value = "Billets en ligne";
$("#docs-link-url").value = "https://billets.example.com/abc";
$("#docs-link-form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await tick(80);
const lienDoc = f.db.tag_documents.find((d) => d.kind === "link");
assert.equal(lienDoc.url, "https://billets.example.com/abc");
assert.equal(lienDoc.path ?? null, null);
assert.equal($("#docs-link-form").hidden, true);
const lienA = [...$$("#docs-list a.doc-open")].find((a) => /Billets en ligne/.test(a.textContent));
assert.equal(lienA.getAttribute("href"), "https://billets.example.com/abc");
assert.match(lienA.textContent, /billets\.example\.com/);
ok("une date accepte une image et un lien web (adresses dangereuses refusées)");
for (const d of f.db.tag_documents.filter((d) => d.kind === "link" || /\.jpg$/.test(d.path || ""))) { $(`#docs-list [data-del-doc="${d.id}"]`).click(); await tick(80); }
assert.equal(f.db.tag_documents.length, 2);
$$("#docs-list [data-del-doc]")[1].click(); await tick(100);
assert.equal(f.db.tag_documents.length, 1);
assert.equal(f.storage.docFiles.size, 1);
ok("retirer un document supprime aussi le fichier");
$("#dialog-docs [data-close]").click();
chat.stop();

// simple utilisateur : consulte seulement
f.db.workspace_members.find((m) => m.user_id === "u1").role = "member";
f.db.profiles.find((p) => p.id === "u1").is_super_admin = false;
const chat2 = createChat({ supabase: f, user: thierry });
await chat2.start(); await openLast(); await tick(150);
if ($("#tags-toggle").getAttribute("aria-expanded") !== "true") { $("#tags-toggle").click(); await tick(20); }
assert.equal($$("#tag-filter .doc-badge").length, 1, "badge seulement sur les dates avec documents");
$("#tag-filter .doc-badge").click(); await tick(40);
assert.equal($$("#docs-list .docs-tag").length, 1);
assert.equal($$("#docs-list [data-add-doc], #docs-list [data-del-doc]").length, 0, "ni ajout ni suppression");
await tick(60);
assert.match($("#docs-list a.doc-open").getAttribute("href"), /sign\/tag-documents/);
const ins = await f.from("tag_documents").insert({ tag_id: "t2", name: "x.pdf", path: "r1/t2/x.pdf" }).select().single();
assert.ok(ins.error, "la base refuse l'ajout par un utilisateur");
ok("un utilisateur ouvre les documents mais ne peut ni en ajouter ni en retirer");
$("#dialog-docs [data-close]").click();

// dates en cours : accès rapide
const today = new Date();
f.db.tour_tags.find((t) => t.id === "t1").start_date = iso(plus(-1));
f.db.tour_tags.find((t) => t.id === "t1").end_date = iso(plus(2));
f.db.tour_tags.find((t) => t.id === "t1").shows = [iso(today)];
f.db.profiles.find((p) => p.id === "u1").is_super_admin = false;
f.db.workspace_members.find((m) => m.user_id === "u1").role = "member";
chat2.stop();
const chat4 = createChat({ supabase: f, user: thierry });
await chat4.start(); await openLast(); await tick(150);
assert.equal($("#open-current").hidden, false);
assert.equal($("#channel-current").hidden, false);
assert.equal($("#current-count").textContent, "1");
$("#channel-current").click(); await tick(40);
assert.ok($("#dialog-current").hasAttribute("open"));
assert.match($("#current-list").textContent, /Hamlet · Lausanne/);
assert.match($("#current-list").textContent, /Représentation aujourd'hui/);
await tick(60);
assert.equal($$("#current-list a.doc-open").length, 1);
assert.match($("#current-list a.doc-open").getAttribute("href"), /sign\/tag-documents/);
assert.ok($("#dialog-current .help-close"), "croix de fermeture en haut de la fenêtre");
$("#dialog-current .help-close").click(); await tick(20);
assert.ok(!$("#dialog-current").hasAttribute("open"), "la croix ferme la fenêtre");
$("#open-current").click(); await tick(40);
$("#current-list [data-go-tag]").click(); await tick(150);
assert.ok(!$("#dialog-current").hasAttribute("open"));
assert.equal($$("#tag-filter [aria-pressed='true']").length, 0, "ouvre le spectacle, sans filtre de date");
assert.ok($("#current-list .docs-tag.colored").style.getPropertyValue("--h"), "la date reprend la couleur de sa production");
assert.ok($("#current-dots .live-dot").style.getPropertyValue("--h"));
assert.equal($("#current-dots .live-dot").style.getPropertyValue("--h"), $("#current-list .docs-tag.colored").style.getPropertyValue("--h"));
ok("dates en cours : bouton partout, liste du jour avec documents, accès direct au spectacle");
$("#open-calendar").click(); await tick(60);
assert.equal($("#channel-current").hidden, false, "toujours accessible depuis le calendrier");
// plus aucune date en cours : les boutons disparaissent
f.db.tour_tags.find((t) => t.id === "t1").start_date = iso(plus(5));
f.db.tour_tags.find((t) => t.id === "t1").end_date = iso(plus(6));
chat4.stop();
f.db.profiles.find((p) => p.id === "u1").is_super_admin = true;
f.db.workspace_members.find((m) => m.user_id === "u1").role = "admin";
var chat5 = createChat({ supabase: f, user: thierry });
await chat5.start(); await openLast(); await tick(150);
assert.equal($("#open-current").hidden, true);
assert.equal($("#channel-current").hidden, true);
ok("sans date en cours, pas de bouton");
// la veille du début et le lendemain de la fin comptent (trajets)
const t1 = f.db.tour_tags.find((t) => t.id === "t1");
for (const [start, end, note] of [[iso(plus(1)), iso(plus(3)), /Veille/], [iso(plus(-3)), iso(plus(-1)), /Lendemain/], [iso(plus(2)), iso(plus(4)), null], [iso(plus(-4)), iso(plus(-2)), null]]) {
  t1.start_date = start; t1.end_date = end; t1.shows = [];
  chat5.stop();
  var c = createChat({ supabase: f, user: thierry });
  await c.start(); await openLast(); await tick(150);
  const shown = !$("#open-current").hidden;
  assert.equal(shown, note !== null, `${start}..${end}`);
  if (note) { $("#open-current").click(); await tick(40); assert.match($("#current-list").textContent, note); $("#dialog-current [data-close]").click(); }
  c.stop();
}
ok("dates en cours : de la veille du début au lendemain de la fin");
var chat5b = createChat({ supabase: f, user: thierry });
chat5.stop();
// supprimer la date supprime ses documents
f.db.workspace_members.find((m) => m.user_id === "u1").role = "admin";
f.db.profiles.find((p) => p.id === "u1").is_super_admin = true;
chat2.stop();
const chat3 = createChat({ supabase: f, user: thierry });
await chat3.start(); await openLast(); await tick(150);
$("#channel-dates").click(); await tick(40);
$("#tags-list [data-del=\"t1\"]").click(); await tick(120);
assert.equal(f.db.tag_documents.length, 0);
assert.equal(f.storage.docFiles.size, 0);
ok("supprimer une date supprime ses documents");
chat3.stop();
console.log(`\n${passed} vérifications réussies`);
