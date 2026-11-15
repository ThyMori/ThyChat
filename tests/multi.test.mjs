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


const fire = (node, type, props = {}) => { const e = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(e, props); node.dispatchEvent(e); return e; };
const longPress = async (node) => { fire(node, "pointerdown", { clientX: 10, clientY: 10, pointerType: "touch", button: 0 }); await tick(520); fire($("#messages"), "pointerup", { clientX: 10, clientY: 10 }); fire($("#messages"), "click"); };
const touch = (node, type, x, y) => { const e = new window.Event(type, { bubbles: true, cancelable: true }); const t = { clientX: x, clientY: y }; e.touches = type === "touchend" ? [] : [t]; e.changedTouches = [t]; node.dispatchEvent(e); };
const th = { id: "u1", email: "me@x.fr", user_metadata: {} };
{
  const { f, chat } = await session(th, "admin");
  const rows = () => $$("#messages .msg");
  // appui court : options habituelles (avec Transférer)
  rows()[1].querySelector(".bubble").click(); await tick(30);
  assert.ok($$(".msg-actions button").some((b) => b.dataset.action === "forward"), "bouton Transférer");
  rows()[1].querySelector(".bubble").click(); await tick(30);
  // appui long : sélection
  assert.equal($("#select-bar").hidden, true);
  await longPress(rows()[0].querySelector(".bubble")); await tick(30);
  assert.equal($("#select-bar").hidden, false, "barre de sélection");
  assert.equal(rows()[0].classList.contains("picked"), true);
  assert.equal($("#select-count").textContent, "1 message");
  rows()[1].querySelector(".bubble").click(); await tick(20);
  assert.equal($("#select-count").textContent, "2 messages", "un appui ajoute un message");
  rows()[1].querySelector(".bubble").click(); await tick(20);
  assert.equal($("#select-count").textContent, "1 message", "un appui sur un message coché le décoche");
  rows()[0].querySelector(".bubble").click(); await tick(20);
  assert.equal($("#select-bar").hidden, true, "plus rien de coché : fin de la sélection");
  // suppression par lot
  await longPress(rows()[0].querySelector(".bubble")); await tick(20);
  rows()[2].querySelector(".bubble").click(); await tick(20);
  assert.equal($("#select-delete").disabled, false, "administrateur : peut tout supprimer");
  $("#select-delete").click(); await tick(120);
  assert.equal(f.db.messages.length, 1, "deux messages supprimés d'un coup");
  assert.equal(rows().length, 1);
  assert.equal($("#select-bar").hidden, true);
  assert.ok(f.storage.files.has("c1/photo-1.jpg") === false, "photo du message supprimé retirée");
  chat.stop();
}
{
  const { f, chat } = await session(th, "member");
  const rows = () => $$("#messages .msg");
  await longPress(rows()[0].querySelector(".bubble")); await tick(20);
  assert.equal($("#select-delete").disabled, true, "pas supprimable : message d'un autre");
  rows()[1].querySelector(".bubble").click(); await tick(20);
  assert.equal($("#select-delete").disabled, true);
  rows()[0].querySelector(".bubble").click(); await tick(20); // retire le 1er
  assert.equal($("#select-delete").disabled, false, "mes propres messages : supprimable");
  // transférer : message avec photo + message à moi
  rows()[2] && rows()[2].querySelector(".bubble").click(); await tick(10);
  $("#select-cancel").click(); await tick(20);
  assert.equal($("#select-bar").hidden, true);
  // transfert de 2 messages (dont une photo) vers Technique
  await longPress(rows()[0].querySelector(".bubble")); await tick(20);
  rows()[1].querySelector(".bubble").click(); await tick(20);
  $("#select-forward").click(); await tick(40);
  assert.ok($("#dialog-forward").hasAttribute("open"));
  assert.match($("#forward-title").textContent, /2 messages/);
  $('#forward-list button[data-target="c2"]').click(); await tick(150);
  const copies = f.db.messages.filter((m) => m.channel_id === "c2");
  assert.equal(copies.length, 2, "deux copies dans le sous-salon d'arrivée");
  assert.match(copies[0].body, /^↪ Transféré de Camille\nPlan de feu à jour/);
  assert.match(copies[1].body, /^↪ Transféré de /);
  assert.ok(copies[0].attachments[0].path.startsWith("c2/"), "photo copiée dans le dossier d'arrivée");
  assert.ok(f.storage.files.has(copies[0].attachments[0].path) && f.storage.files.has("c1/photo-1.jpg"), "original conservé");
  assert.equal(f.db.messages.filter((m) => m.channel_id === "c1").length, 3, "originaux intacts");
  assert.equal($("#dialog-forward").hasAttribute("open"), false);
  assert.equal($("#select-bar").hidden, true);
  // vers le fil ouvert : affiché avec la mention
  rows()[0].querySelector(".bubble").click(); await tick(20);
  $$(".msg-actions button").find((b) => b.dataset.action === "forward").click(); await tick(30);
  $('#forward-list button[data-target="c1"]').click(); await tick(150);
  const fwd = $$("#messages .msg-forwarded");
  assert.equal(fwd.length, 1);
  assert.match(fwd[0].textContent, /Transféré de Camille/);
  assert.ok(!/↪/.test($$("#messages .msg-body").map((n) => n.textContent).join("|")), "la mention n'est pas répétée dans le texte");
  // balayer vers la gauche : options
  const row = $$("#messages .msg")[1];
  touch(row.querySelector(".bubble"), "touchstart", 300, 100);
  touch(row.querySelector(".bubble"), "touchend", 150, 105); await tick(30);
  assert.ok($$("#messages .msg-actions").length === 1, "balayage vers la gauche : options du message");
  assert.ok($$(".msg-actions button").some((b) => b.dataset.action === "forward"));
  chat.stop();
}
{
  const { f, chat } = await session(th, "member");
  const copied = [];
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async (t) => { copied.push(t); } }, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  const rows = () => $$("#messages .msg");
  rows()[1].querySelector(".bubble").click(); await tick(20);
  $$(".msg-actions button").find((b) => b.dataset.action === "copy").click(); await tick(40);
  assert.deepEqual(copied, ["Mon message"], "texte copié");
  await longPress(rows()[0].querySelector(".bubble")); await tick(20);
  rows()[1].querySelector(".bubble").click(); await tick(20);
  $("#select-copy").click(); await tick(40);
  assert.equal(copied[1], "Camille : Plan de feu à jour\nme@x.fr : Mon message".replace("me@x.fr", copied[1].split("\n")[1].split(" : ")[0]));
  assert.match(copied[1], /^Camille : Plan de feu à jour\n.+ : Mon message$/);
  assert.equal($("#select-bar").hidden, true);
  // sourdine d'un seul fil
  assert.match($("#channel-bell").getAttribute("aria-label"), /sourdine/i);
  $("#channel-bell").click(); await tick(30);
  assert.ok($("#dialog-mute").hasAttribute("open"));
  assert.equal($$("#mute-choices button").length, 4);
  $('#mute-choices [data-choice="forever"]').click(); await tick(80);
  const mutes = f.db.notification_mutes.filter((m) => m.scope === "channel");
  assert.equal(mutes.length, 1);
  assert.equal(mutes[0].target_id, "c1", "seul ce fil est en sourdine");
  assert.equal($("#dialog-mute").hasAttribute("open"), false);
  assert.equal($("#channel-bell").classList.contains("is-muted"), true);
  $("#channel-bell").click(); await tick(30);
  $('#mute-choices [data-choice="off"]').click(); await tick(80);
  assert.equal(f.db.notification_mutes.filter((m) => m.scope === "channel").length, 0, "sourdine retirée");
  chat.stop();
}
{
  const { f, chat } = await session(th, "admin");
  const rows = () => $$("#messages .msg");
  // m2 est à moi ; m1 et m3 à Camille
  await longPress(rows()[1].querySelector(".bubble")); await tick(20);
  assert.equal($("#select-strike").disabled, false, "mes messages : rayer possible");
  assert.equal($("#select-move").hidden, false, "administrateur : déplacer");
  $("#select-strike").click(); await tick(80);
  assert.ok(f.db.messages.find((m) => m.id === "m2").struck_at, "message rayé");
  assert.equal($("#select-bar").hidden, true);
  await longPress(rows()[1].querySelector(".bubble")); await tick(20);
  assert.equal($("#select-strike").textContent, "Rétablir");
  $("#select-strike").click(); await tick(80);
  assert.equal(f.db.messages.find((m) => m.id === "m2").struck_at, null, "rétabli");
  await longPress(rows()[0].querySelector(".bubble")); await tick(20);
  rows()[2].querySelector(".bubble").click(); await tick(20);
  assert.equal($("#select-strike").disabled, true, "messages d'un autre : pas rayables");
  $("#select-move").click(); await tick(40);
  assert.match($("#move-title").textContent, /2 messages/);
  $('#move-list button[data-target="c2"]').click(); await tick(200);
  assert.equal(f.db.messages.filter((m) => m.channel_id === "c2").length, 2, "deux messages déplacés d'un coup");
  assert.equal(rows().length, 1);
  assert.ok(f.storage.files.has("c2/photo-1.jpg"), "photo suivie");
  chat.stop();
}
{
  const { chat } = await session(th, "member");
  assert.equal($("#select-move") !== null, true);
  await longPress($$("#messages .msg")[1].querySelector(".bubble")); await tick(20);
  assert.equal($("#select-move").hidden, true, "pas de déplacement pour un utilisateur");
  $("#select-cancel").click();
  chat.stop();
}
{
  localStorage.clear();
  const fk = makeFake(th);
  fk.db.workspaces.push({ id: "w1", name: "Cie", created_by: "u1", theme: "violet" });
  fk.db.workspace_members.push({ workspace_id: "w1", user_id: "u1", role: "member" });
  fk.db.rooms.push({ id: "r1", workspace_id: "w1", name: "Hamlet", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
  fk.db.channels.push({ id: "c1", workspace_id: "w1", room_id: "r1", name: "Général", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
  fk.db.messages.push(msg("fx1", "c1", "u1", "Un *gras* et _italique_ et ~barré~ ok, snake_case_name, 2*3*4 https://x.fr/a_b_c *a _b_ c* *non fermé <b>x</b>", "2026-11-14T10:00:00.000Z"));
  const ch = createChat({ supabase: fk, user: th });
  await ch.start(); await openLast(); await tick(100);
  const body = $("#messages .msg-body");
  assert.equal(body.querySelectorAll("strong")[0].textContent, "gras");
  assert.equal(body.querySelectorAll("strong")[1].textContent, "a b c");
  assert.equal(body.querySelector("em").textContent, "italique");
  assert.equal(body.querySelector("s").textContent, "barré");
  assert.equal(body.querySelectorAll("strong")[1].querySelector("em").textContent, "b", "mise en forme imbriquée");
  assert.ok(body.textContent.includes("snake_case_name"), "pas de mise en forme au milieu d'un mot");
  assert.ok(body.textContent.includes("2*3*4"));
  assert.equal(body.querySelector("a").getAttribute("href"), "https://x.fr/a_b_c", "adresse intacte");
  assert.ok(body.textContent.includes("*non fermé"), "marqueur seul laissé tel quel");
  assert.equal(body.querySelector("b"), null, "pas de HTML injecté");
  assert.ok(body.textContent.includes("<b>x</b>"));
  // barre et boutons de mise en forme
  const field = $("#composer-input");
  field.dispatchEvent(new window.Event("focus"));
  assert.equal($("#format-bar").dataset.show, "1");
  field.value = "bonjour tout le monde";
  field.setSelectionRange(8, 12);
  $('#format-bar [data-format="*"]').click();
  assert.equal(field.value, "bonjour *tout* le monde");
  $('#format-bar [data-format="*"]').click();
  assert.equal(field.value, "bonjour tout le monde", "un second appui retire la mise en forme");
  field.value = ""; field.setSelectionRange(0, 0);
  $('#format-bar [data-format="~"]').click();
  assert.equal(field.value, "~~");
  assert.equal(field.selectionStart, 1);
  field.value = "salut "; field.setSelectionRange(0, 5);
  $('#format-bar [data-format="_"]').click();
  assert.equal(field.value, "_salut_ ");
  ch.stop();
}
{
  // médias du fil
  const { f, chat } = await session(th, "member");
  f.db.messages.push(msg("m5", "c1", "u2", "", "2026-11-13T08:00:00.000Z"));
  f.db.messages[f.db.messages.length - 1].attachments = [{ path: "c1/photo-0.jpg", w: 10, h: 10 }, { path: "c1/photo-00.jpg", w: 10, h: 10 }];
  f.db.messages.push(msg("m6", "c2", "u2", "autre fil", "2026-11-14T08:00:00.000Z"));
  f.db.messages[f.db.messages.length - 1].attachments = [{ path: "c2/ailleurs.jpg", w: 10, h: 10 }];
  assert.equal($("#channel-media").hidden, false);
  $("#channel-media").click(); await tick(120);
  assert.ok($("#dialog-media").hasAttribute("open"));
  const thumbs = $$("#media-grid .media-thumb img");
  assert.equal(thumbs.length, 3, "3 photos dans ce fil, aucune de l'autre");
  assert.match($("#media-title").textContent, /\(3\)/);
  assert.match(thumbs[0].getAttribute("src"), /photo-1\.jpg/, "la plus récente d'abord");
  assert.equal($$("#media-grid .media-day").length, 2, "classées par jour");
  thumbs[0].parentElement.click(); await tick(20);
  assert.ok($("#dialog-image").hasAttribute("open"));
  assert.match($("#lightbox-img").getAttribute("src"), /photo-1\.jpg/);
  $("#dialog-image").removeAttribute("open"); $("#dialog-media").removeAttribute("open");
  chat.stop();
}
{
  // date en cours proposée d'office
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
  localStorage.clear();
  for (const d of $$("dialog")) d.removeAttribute("open");
  const fk = makeFake(th);
  fk.db.workspaces.push({ id: "w1", name: "Cie", created_by: "u1", theme: "violet" });
  fk.db.workspace_members.push({ workspace_id: "w1", user_id: "u1", role: "member" });
  fk.db.rooms.push({ id: "r1", workspace_id: "w1", name: "Hamlet", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
  fk.db.channels.push({ id: "c1", workspace_id: "w1", room_id: "r1", name: "Général", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
  fk.db.tour_tags.push({ id: "t1", room_id: "r1", label: "Lausanne", start_date: day(-1), end_date: day(2), shows: [], created_at: "2026-11-01T00:00:00Z" });
  fk.db.tour_tags.push({ id: "t2", room_id: "r1", label: "Paris", start_date: day(30), end_date: day(32), shows: [], created_at: "2026-11-01T00:00:00Z" });
  const ch = createChat({ supabase: fk, user: th });
  await ch.start(); await openLast(); await tick(120);
  assert.equal($$("#composer-tags .tag-chip").length, 1, "le badge de la date en cours est proposé");
  assert.match($("#composer-tags .tag-chip").textContent, /Lausanne/);
  $("#composer-input").value = "Bonjour";
  $("#composer").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await tick(120);
  assert.deepEqual(fk.db.messages.at(-1).tag_ids, ["t1"], "message envoyé avec la date");
  assert.equal($$("#composer-tags .tag-chip").length, 1, "proposée à nouveau pour le message suivant");
  $("#composer-tags .tag-chip").click(); await tick(20);
  assert.equal($$("#composer-tags .tag-chip").length, 0, "un appui sur le badge le retire");
  $("#composer-input").value = "Sans date";
  $("#composer").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await tick(120);
  assert.deepEqual(fk.db.messages.at(-1).tag_ids ?? [], [], "envoyé sans date");
  assert.equal($$("#composer-tags .tag-chip").length, 1, "revient pour le suivant");
  ch.stop();
}
{
  // médias filtrés par dates ; modification d'un message
  const { f, chat } = await session(th, "member");
  f.db.tour_tags.push({ id: "tA", room_id: "r1", label: "Lausanne", start_date: "2099-03-01", end_date: "2099-03-03", shows: [], created_at: "x" });
  f.db.tour_tags.push({ id: "tB", room_id: "r1", label: "Paris", start_date: "2099-04-01", end_date: "2099-04-03", shows: [], created_at: "x" });
  f.db.tour_tags.push({ id: "tC", room_id: "r1", label: "Vide", start_date: "2099-05-01", end_date: "2099-05-03", shows: [], created_at: "x" });
  f.db.messages.push({ ...msg("p1", "c1", "u2", "", "2026-11-12T08:00:00.000Z"), attachments: [{ path: "c1/a.jpg", w: 1, h: 1 }], tag_ids: ["tA"] });
  f.db.messages.push({ ...msg("p2", "c1", "u2", "", "2026-11-11T08:00:00.000Z"), attachments: [{ path: "c1/b.jpg", w: 1, h: 1 }], tag_ids: ["tB"] });
  chat.stop();
  const again = createChat({ supabase: f, user: th });
  await again.start(); await openLast(); await tick(120);
  $("#channel-media").click(); await tick(150);
  assert.equal($$("#media-grid .media-thumb").length, 3, "toutes les photos (a, b, photo-1)");
  const chips = $$("#media-filter .tag-chip");
  assert.equal(chips.length, 2, "seulement les dates qui ont des photos");
  assert.ok(chips.some((c) => /Lausanne/.test(c.textContent)) && chips.some((c) => /Paris/.test(c.textContent)) && !chips.some((c) => /Vide/.test(c.textContent)));
  chips.find((c) => /Lausanne/.test(c.textContent)).click(); await tick(30);
  assert.equal($$("#media-grid .media-thumb").length, 1);
  assert.match($("#media-grid img").getAttribute("src"), /a\.jpg/);
  $$("#media-filter .tag-chip").find((c) => /Paris/.test(c.textContent)).click(); await tick(30);
  assert.equal($$("#media-grid .media-thumb").length, 2, "deux dates : photos de l'une ou l'autre");
  $$("#media-filter .tag-chip").find((c) => /Lausanne/.test(c.textContent)).click();
  $$("#media-filter .tag-chip").find((c) => /Paris/.test(c.textContent)).click(); await tick(30);
  assert.equal($$("#media-grid .media-thumb").length, 3, "sans filtre : tout");
  $("#dialog-media").removeAttribute("open");

  // modifier mon message
  const rows = () => $$("#messages .msg");
  const mine = rows().find((r) => /Mon message/.test(r.textContent));
  mine.querySelector(".bubble").click(); await tick(20);
  const other = rows().find((r) => /Autre message de Camille/.test(r.textContent));
  other.querySelector(".bubble").click(); await tick(20);
  assert.ok(![...$$(".msg-actions button")].some((b) => b.dataset.action === "edit"), "pas de Modifier sur le message d'un autre");
  rows().find((r) => /Mon message/.test(r.textContent)).querySelector(".bubble").click(); await tick(20);
  $$(".msg-actions button").find((b) => b.dataset.action === "edit").click(); await tick(30);
  assert.equal($("#composer-input").value, "Mon message");
  assert.match($("#reply-author").textContent, /Modifier/);
  assert.equal($("#composer-attach").disabled, true);
  // annuler
  $("#reply-cancel").click(); await tick(20);
  assert.equal($("#composer-input").value, "");
  assert.equal($("#reply-bar").hidden, true);
  // modifier + ajouter un #
  rows().find((r) => /Mon message/.test(r.textContent)).querySelector(".bubble").click(); await tick(20);
  $$(".msg-actions button").find((b) => b.dataset.action === "edit").click(); await tick(30);
  $("#composer-input").value = "Mon message corrigé #Lau";
  $("#composer-input").setSelectionRange(24, 24);
  $("#composer-input").dispatchEvent(new window.Event("input", { bubbles: true })); await tick(30);
  const li = $$("#tag-suggest li").find((n) => /Lausanne/.test(n.textContent));
  assert.ok(li, "suggestion # proposée pendant la modification");
  li.dispatchEvent(new window.Event("mousedown", { bubbles: true, cancelable: true })); await tick(20);
  assert.equal($$("#composer-tags .tag-chip").length, 1, "badge de date ajouté");
  $("#composer").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true })); await tick(120);
  const saved = f.db.messages.find((m) => m.id === "m2");
  assert.match(saved.body, /^Mon message corrigé/);
  assert.deepEqual(saved.tag_ids, ["tA"], "date ajoutée au message modifié");
  assert.ok(saved.edited_at, "date de modification posée");
  assert.equal($("#composer-input").value, "");
  assert.ok($$("#messages .msg-edited").length === 1, "mention « modifié »");
  assert.equal(state_ok(), true);
  again.stop();
}
function state_ok() { return true; }
console.log("multi ok");
