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
f.db.rooms.push({ id: "r2", workspace_id: "w1", name: "Lear", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
f.db.channels.push({ id: "c1", workspace_id: "w1", room_id: "r1", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
f.db.channels.push({ id: "c2", workspace_id: "w1", room_id: "r2", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
const chat = createChat({ supabase: f, user: thierry });
await chat.start(); await openLast();
await tick(100);

assert.match($(".section-title").textContent, /Spectacles/);
assert.equal($("#week-strip").hidden, true, "pas de frise sans dates");
ok("« Salons » est devenu « Spectacles »");

function pickDay(sel, iso) {
  for (let i = 0; i < 4; i++) {
    const b = document.querySelector(sel + ' [data-iso="' + iso + '"]');
    if (b) { b.click(); return; }
    document.querySelector(sel + " .mini-cal-head button:last-child").click();
  }
  throw new Error("jour introuvable " + iso);
}

// création d'une date avec plage et représentations
$("#channel-dates").click();
await tick(40);
$("#tag-label").value = "Lausanne";
$("#tag-start").value = iso(plus(0));
$("#tag-end").value = iso(plus(-3));
submit($("#tags-form"));
await tick(60);
assert.match($("#tags-message").textContent, /fin/i, "fin avant début refusée");
pickDay("#tag-range-picker", iso(plus(0)));
pickDay("#tag-range-picker", iso(plus(3)));
assert.equal($("#tag-start").value, iso(plus(0)));
assert.equal($("#tag-end").value, iso(plus(3)));
pickDay("#tag-range-picker", iso(plus(2)));
assert.equal($("#tag-start").value, iso(plus(2)), "3e appui = nouveau début");
assert.equal($("#tag-end").value, "");
pickDay("#tag-range-picker", iso(plus(0)));
assert.equal($("#tag-start").value, iso(plus(0)), "fin avant début : inversé");
assert.equal($("#tag-end").value, iso(plus(2)));
pickDay("#tag-range-picker", iso(plus(0)));
pickDay("#tag-range-picker", iso(plus(3)));
$("#tag-shows-toggle").click();
pickDay("#tag-shows-picker", iso(plus(1)));
pickDay("#tag-shows-picker", iso(plus(2)));
pickDay("#tag-shows-picker", iso(plus(2)));
assert.equal($("#show-choice").hidden, false, "choix ajouter/retirer");
$('#show-choice [data-choice="add"]').click();
pickDay("#tag-shows-picker", iso(plus(3)));
pickDay("#tag-shows-picker", iso(plus(3)));
$('#show-choice [data-choice="remove"]').click();
pickDay("#tag-shows-picker", iso(plus(1)));
$('#show-choice [data-choice="remove"]').click();

// le calendrier des représentations suit celui des dates : un seul défilement
const monthOf = (sel) => document.querySelector(`${sel} .mini-title`).textContent;
const nextOf = (sel) => document.querySelector(`${sel} .mini-nav[aria-label="Mois suivant"]`);
const prevOf = (sel) => document.querySelector(`${sel} .mini-nav[aria-label="Mois précédent"]`);
const m0 = monthOf("#tag-range-picker");
assert.equal(monthOf("#tag-shows-picker"), m0, "au départ : même mois");
nextOf("#tag-range-picker").click(); nextOf("#tag-range-picker").click();
assert.notEqual(monthOf("#tag-range-picker"), m0);
assert.equal(monthOf("#tag-shows-picker"), monthOf("#tag-range-picker"), "les représentations suivent le défilement des dates");
prevOf("#tag-range-picker").click();
assert.equal(monthOf("#tag-shows-picker"), monthOf("#tag-range-picker"), "dans les deux sens");
// défiler les représentations seules ne bouge pas le calendrier des dates
const rangeMonth = monthOf("#tag-range-picker");
nextOf("#tag-shows-picker").click();
assert.equal(monthOf("#tag-range-picker"), rangeMonth, "le suivi va dans un seul sens");
prevOf("#tag-range-picker").click(); nextOf("#tag-range-picker").click();
assert.equal(monthOf("#tag-shows-picker"), monthOf("#tag-range-picker"), "le calendrier des dates reprend la main");
while (monthOf("#tag-range-picker") !== m0) prevOf("#tag-range-picker").click();
ok("calendrier des représentations : suit celui des dates");
assert.equal($$("#tag-shows .tag-chip").length, 1, "un jour à 2 représentations = une pastille ×2");
assert.match($("#tag-shows .tag-chip").textContent, /×2/);
submit($("#tags-form"));
await tick(80);
const lausanne = f.db.tour_tags[0];
assert.equal(lausanne.start_date, iso(plus(0)));
assert.equal(lausanne.end_date, iso(plus(3)));
assert.deepEqual(lausanne.shows, [iso(plus(2)), iso(plus(2))]);
// début seul => une journée
$("#tag-label").value = "Générale";
$("#tag-start").value = iso(plus(5));
$("#tag-end").value = "";
submit($("#tags-form"));
await tick(60);
const generale = f.db.tour_tags.find((t) => t.label === "Générale");
assert.equal(generale.end_date, generale.start_date);
$("#dialog-tags [data-close]").click();
ok("une date a une plage et des représentations ; un seul jour si la fin manque");

// frise hebdomadaire : veille + 6 jours suivants
assert.equal($("#week-strip").hidden, false);
assert.equal($$("#week-strip .cal-day").length, 8);
assert.equal($$("#week-strip .cal-day")[1].classList.contains("today"), true, "aujourd'hui est la 2e case");
assert.ok($$("#week-strip .cal-bar").some((b) => b.textContent === "Lausanne"));
assert.equal($$("#week-strip .cal-star").length, 1, "un jour à 2 représentations = une étoile");
assert.match($("#week-strip .cal-star").textContent, /2/);
ok("frise hebdomadaire : 1 jour avant, 6 après, plage et étoile");

// un clic mène au calendrier
$("#week-strip").click();
await tick(60);
assert.equal($("#calendar").hidden, false);
assert.equal($("#messages").hidden, true);
assert.equal($("#composer").hidden, true);
assert.equal($("#week-strip").hidden, true);
assert.equal($("#channel-title").textContent, "Calendrier");
assert.equal($("#cal-scope").value, "r1", "ouvert sur le spectacle courant");
assert.ok($$("#cal-grid .cal-bar").some((b) => /Lausanne/.test(b.textContent)));
assert.ok($$("#cal-grid .cal-star").length >= 1);
assert.match($("#cal-title").textContent, new RegExp(String(new Date().getFullYear())));
ok("un clic sur la frise ouvre le calendrier mensuel");

// autre spectacle : étoile et frise dans la vue « tous les spectacles »
f.db.tour_tags.push({ id: "tz", room_id: "r2", label: "Tournée Lear", start_date: iso(plus(1)), end_date: iso(plus(2)), shows: [iso(plus(1))], created_at: "x" });
f.emit("tour_tags", { eventType: "INSERT", new: {} });
await tick(700);
$("#cal-scope").value = "ws";
$("#cal-scope").dispatchEvent(new window.Event("change", { bubbles: true }));
assert.ok($$("#cal-grid .cal-bar").some((b) => /Lear · Tournée Lear/.test(b.textContent)));
assert.ok($$("#cal-grid .cal-bar").some((b) => /Hamlet · Lausanne/.test(b.textContent)));
$("#cal-next").click();
assert.notEqual($("#cal-title").textContent, "");
$("#cal-today").click();
ok("calendrier : tous les spectacles de l'espace, navigation par mois");

// détail d'un jour, puis ouverture du spectacle filtré
const cell = $$("#cal-grid .cal-day").find((c) => c.dataset.day === iso(plus(1)));
cell.click();
assert.equal($("#cal-detail").hidden, false);
assert.match($("#cal-detail").textContent, /Lausanne/);
assert.match($("#cal-detail").textContent, /représentation/);
$$("#cal-grid .cal-bar").find((b) => /Lear/.test(b.textContent)).click();
await tick(120);
assert.equal($("#calendar").hidden, true);
assert.equal($("#messages").hidden, false);
assert.match($(".chat-head").textContent, /Lear/);
assert.equal($$("#tag-filter [aria-pressed='true']").length, 1, "le filtre est posé sur la date touchée");
ok("toucher une frise ouvre le spectacle filtré sur cette date");

// retour par un salon de la barre latérale
$("#open-calendar").click();
await tick(40);
assert.equal($("#calendar").hidden, false);
$(".channel-item.sub, #channel-list .channel-item").click();
await tick(120);
assert.equal($("#calendar").hidden, true);
ok("choisir un sous-salon quitte le calendrier");
// page d'aide
$("#open-help").click();
assert.ok($("#dialog-help").hasAttribute("open"));
assert.ok($$("#dialog-help summary").length >= 7, "toutes les rubriques sont là");
assert.match($("#dialog-help").textContent, /Calendrier/);
$("#dialog-help [data-close]").click();
ok("bouton « i » : page d'explication des fonctions");
chat.stop();
console.log(`\n${passed} vérifications réussies`);
