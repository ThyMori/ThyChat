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



const thierry = { id: "u1", email: "me@x.fr", user_metadata: {} };
const f = makeFake(thierry);
f.db.workspaces.push({ id: "w1", name: "Compagnie", created_by: "u1", theme: "violet" });
f.db.workspace_members.push({ workspace_id: "w1", user_id: "u1", role: "admin" }, { workspace_id: "w1", user_id: "u2", role: "member" });
f.db.profiles.push({ id: "u2", display_name: "Camille", avatar_url: null });
f.db.rooms.push({ id: "r1", workspace_id: "w1", name: "Hamlet", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
f.db.channels.push({ id: "c1", workspace_id: "w1", room_id: "r1", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
f.db.messages.push({ id: "m1", channel_id: "c1", user_id: "u2", parent_id: null, reply_to: null, tag_ids: [], body: "Bonjour à tous, les plans de feu sont à jour.", created_at: "2026-11-13T10:00:00Z" });
const chat = createChat({ supabase: f, user: thierry });
await chat.start(); await openLast();
await tick(100);

// pas de date : la barre n'apparaît que pour l'administrateur, avec « Gérer »
assert.equal($("#tag-bar").hidden, false);
assert.equal($("#channel-dates").hidden, false);
$("#channel-dates").click();
await tick(30);
assert.ok($("#dialog-tags").hasAttribute("open"));
assert.equal($("#tags-form").hidden, true, "formulaire masqué à l'ouverture");
assert.equal($("#tag-new").hidden, false);
$("#tag-new").click();
assert.equal($("#tags-form").hidden, false, "le + ouvre le formulaire");
assert.equal($("#tag-new").hidden, true);
$("#tag-cancel").click();
assert.equal($("#tags-form").hidden, true, "Annuler le referme");
$("#tag-new").click();
for (const [label, start, end] of [["Lausanne", "2027-03-12", "2027-03-14"], ["Paris", "2027-04-02", ""]]) {
  $("#tag-label").value = label;
  $("#tag-start").value = start;
  $("#tag-end").value = end;
  submit($("#tags-form"));
  await tick(60);
}
assert.deepEqual(f.db.tour_tags.map((t) => t.label), ["Lausanne", "Paris"]);
assert.equal($$("#tags-list .tag-row").length, 2);
$("#tag-label").value = "Paris";
submit($("#tags-form"));
await tick(60);
assert.match($("#tags-message").textContent, /déjà/);
$("#dialog-tags [data-close]").click();
if ($("#tags-toggle").getAttribute("aria-expanded") !== "true") $("#tags-toggle").click();
assert.equal($$("#tag-filter .tag-chip").length, 2);
ok("l'administrateur crée des dates de tournée, doublon refusé");

// « # » propose les dates
const input = $("#composer-input");
input.value = "Rendez-vous #lau";
input.setSelectionRange(input.value.length, input.value.length);
input.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.equal($("#tag-suggest").hidden, false);
assert.deepEqual($$("#tag-suggest li").map((li) => li.textContent.split(" · ")[0]), ["Lausanne"]);
input.value = "Rendez-vous #";
input.setSelectionRange(input.value.length, input.value.length);
input.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.deepEqual($$("#tag-suggest li").map((li) => li.textContent.split(" · ")[0]), ["Lausanne", "Paris"], "triées par date");
input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
assert.equal(input.value, "Rendez-vous #Paris ", "le #Date reste dans le corps du message");
assert.equal($$("#composer-tags .tag-chip").length, 1);
assert.match($("#composer-tags").textContent, /Paris/);
assert.equal($("#tag-suggest").hidden, true);
ok("# propose les dates et le choix ajoute une pastille au message");

submit($("#composer"));
await tick(80);
const sent = f.db.messages.find((m) => m.body === "Rendez-vous #Paris");
assert.deepEqual(sent.tag_ids, [f.db.tour_tags.find((t) => t.label === "Paris").id]);
assert.ok([...$$(".msg-tag")].some((n) => /Paris/.test(n.textContent)));
assert.ok([...$$(".msg-body .hash-pill")].some((n) => n.textContent === "#Paris"), "pastille #Paris dans le corps du message");
assert.equal($("#composer-extra").hidden, true, "pastilles vidées après envoi");
ok("message envoyé avec sa date");

// répondre
$$(".msg").find((m) => m.dataset.id === "m1").click();
await tick(20);
$(".msg-actions [data-action='reply']").click();
assert.equal($("#reply-bar").hidden, false);
assert.match($("#reply-author").textContent, /Camille/);
input.value = "Merci !";
submit($("#composer"));
await tick(80);
const answer = f.db.messages.find((m) => m.body === "Merci !");
assert.equal(answer.reply_to, "m1");
const quote = $$(".msg-quote").at(-1);
assert.match(quote.textContent, /Camille/);
assert.match(quote.textContent, /plans de feu/);
assert.equal($("#reply-bar").hidden, true);
ok("répondre à : citation affichée au-dessus du message");

// citer
$$(".msg").find((m) => m.dataset.id === "m1").click();
await tick(20);
$(".msg-actions [data-action='quote']").click();
assert.match(input.value, /^> Camille : Bonjour à tous/);
input.value += "D'accord.";
submit($("#composer"));
await tick(80);
const cited = f.db.messages.find((m) => m.body.endsWith("D'accord."));
assert.ok(cited && cited.reply_to === null);
assert.ok($$(".quote-line").some((n) => /Bonjour à tous/.test(n.textContent)));
ok("citer : le texte cité est inséré puis affiché en retrait");

// filtre
const lausanne = f.db.tour_tags.find((t) => t.label === "Lausanne");
const paris = f.db.tour_tags.find((t) => t.label === "Paris");
$(`#tag-filter [data-tag="${paris.id}"]`).click();
await tick(80);
assert.deepEqual($$(".msg").map((m) => m.dataset.id), [sent.id]);
$(`#tag-filter [data-tag="${lausanne.id}"]`).click();
await tick(80);
assert.equal($$(".msg").length, 1, "Lausanne n'a aucun message de plus");
$(`#tag-filter [data-tag="${paris.id}"]`).click();
await tick(80);
assert.match($("#messages").textContent, /Aucun message pour ces dates/);
$("#tag-filter [data-clear]").click();
await tick(80);
assert.equal($$(".msg").length, 4);
ok("le filtre n'affiche que les messages des dates choisies");

// supprimer une date la retire des messages
$("#channel-dates").click();
await tick(30);
window.confirm = () => true;
$(`#tags-list [data-del="${paris.id}"]`).click();
await tick(60);
assert.deepEqual(f.db.messages.find((m) => m.id === sent.id).tag_ids, []);
assert.equal($$(".msg-tag").length, 0);
$("#dialog-tags [data-close]").click();
ok("date supprimée : retirée des messages");

// rayer son message (et seulement le sien)
$$(".msg").find((m) => m.dataset.id === "m1").click();
await tick(20);
assert.equal($(".msg-actions [data-action='strike']"), null, "pas de « Rayer » sur le message d'un autre");
$$(".msg").find((m) => m.dataset.id === sent.id).click();
await tick(20);
assert.equal($(".msg-actions [data-action='strike']").title, "Rayer");
$(".msg-actions [data-action='strike']").click();
await tick(60);
assert.ok(f.db.messages.find((m) => m.id === sent.id).struck_at);
assert.ok($$(".msg.struck").some((m) => m.dataset.id === sent.id));
$$(".msg").find((m) => m.dataset.id === sent.id).click();
await tick(20);
assert.equal($(".msg-actions [data-action='strike']").title, "Rétablir");
$(".msg-actions [data-action='strike']").click();
await tick(60);
assert.equal(f.db.messages.find((m) => m.id === sent.id).struck_at, null);
assert.equal($$(".msg.struck").length, 0);
ok("rayer / rétablir son propre message");

// photo de l'espace (administrateur)
window.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
window.HTMLCanvasElement.prototype.toBlob = function (cb) { cb(new window.Blob(["x"], { type: "image/jpeg" })); };
globalThis.createImageBitmap = window.createImageBitmap;
$("#open-members").click();
await tick(60);
assert.equal($("#space-photo-section").hidden, false);
const file = new window.File(["x"], "logo.png", { type: "image/png" });
Object.defineProperty($("#space-photo-file"), "files", { value: [file], configurable: true });
$("#space-photo-file").dispatchEvent(new window.Event("change", { bubbles: true }));
await tick(150);
assert.match(f.db.workspaces[0].avatar_url || "", /avatars\/ws\/w1\/logo\.jpg/);
assert.ok($("#ws-avatar img"), "la photo remplace les initiales dans la barre latérale");
assert.equal($("#space-photo-remove").hidden, false);
$("#space-photo-remove").click();
await tick(80);
assert.equal(f.db.workspaces[0].avatar_url, null);
assert.equal($("#ws-avatar img"), null);
$("#dialog-members [data-close]").click();
ok("photo d'espace : envoyée, affichée, retirée");

// un utilisateur simple ne gère pas les dates
const marc = { id: "u2", email: "c@x.fr", user_metadata: {} };
const f2 = makeFake(marc);
Object.assign(f2.db, { workspaces: f.db.workspaces.map((x) => ({ ...x })), workspace_members: f.db.workspace_members.map((x) => ({ ...x })), rooms: f.db.rooms.map((x) => ({ ...x })), channels: f.db.channels.map((x) => ({ ...x })), tour_tags: f.db.tour_tags.map((x) => ({ ...x })), messages: f.db.messages.map((x) => ({ ...x })) });
chat.stop();
document.body.innerHTML = document.body.innerHTML;
assert.equal(f2.canAccessRoom?.("u2", "r1") ?? true, true);
const guard = f2.from("tour_tags").insert({ room_id: "r1", label: "Intrus" });
assert.ok((await guard).error, "RLS : un utilisateur ne crée pas de date");
ok("droits : seul un administrateur crée des dates");
console.log(`\n${passed} vérifications réussies`);
