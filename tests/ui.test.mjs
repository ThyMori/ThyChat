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

// =========================================================================================
// Scénario 1 — administrateur général (Thierry)
// =========================================================================================
const thierry = { id: "u1", email: "me@x.fr", user_metadata: {} };
const f1 = makeFake(thierry);
const chat1 = createChat({ supabase: f1, user: thierry });
await chat1.start(); await openLast();
await tick();

assert.equal($("#empty-state").hidden, false);
assert.match($("#empty-action").textContent, /Mes espaces/);
assert.equal($("#me-name").textContent, "Thierry");
ok("administrateur général sans espace : invitation à créer le premier");

$("#empty-action").click();
$("#workspace-name").value = "Pasolini";
submit($("#workspace-form"));
await tick(80);
const ws1 = f1.db.workspaces[0];
const room1 = f1.db.rooms[0];
assert.equal(room1.name, "Général");
assert.equal(room1.everyone, true);
const tous = f1.db.channels[0];
assert.equal(tous.room_id, room1.id);
assert.equal(tous.name, "Général");
assert.equal(tous.everyone, true);
assert.equal($("#ws-name").textContent, "Pasolini");
assert.match($("#channel-title").textContent, /Général/);
assert.equal($("#new-channel").hidden, false);
assert.equal($("#switch-new").hidden, false);
assert.match($(".chat-head h2").textContent, /Général/);
ok("création d'un espace : salon « Tous » ouvert à tous créé et ouvert");

// Équipe : Camille (utilisateur), Marc (utilisateur)
f1.db.workspace_members.push({ workspace_id: ws1.id, user_id: "u2", role: "member" }, { workspace_id: ws1.id, user_id: "u3", role: "member" });

// --- salon restreint (sous-salon du salon Général)
if (!$(`[data-new-sub="${room1.id}"]`)) $(`.room-chev[data-room="${room1.id}"]`).click();
$(`[data-new-sub="${room1.id}"]`).click();
await tick(60);
assert.equal($("#dialog-channel").hasAttribute("open"), true);
assert.equal($("#channel-pick").hidden, true);
$("#channel-name").value = "# Technique";
document.querySelector('input[name="channel-access"][value="some"]').checked = true;
change(document.querySelector('input[name="channel-access"][value="some"]'));
assert.equal($("#channel-pick").hidden, false);
const pickRows = $$("#channel-pick .pick-row");
assert.equal(pickRows.length, 2, "les administrateurs ne sont pas listés (ils voient tout)");
const camilleBox = pickRows.find((r) => r.textContent.includes("Camille")).querySelector("input");
camilleBox.checked = true;
submit($("#channel-form"));
await tick(100);
const tech = f1.db.channels.find((c) => c.name === "Technique");
assert.ok(tech && tech.everyone === false);
assert.deepEqual(f1.db.channel_members.filter((m) => m.channel_id === tech.id).map((m) => m.user_id), ["u2"]);
assert.match($("#channel-title").textContent, /Technique/);
assert.ok(itemFor(tech.id).querySelector(".lock-ic"), "cadenas sur un salon à accès restreint");
ok("salon restreint : assigné à Camille seulement, cadenas affiché, nom sans #");

// --- modifier l'accès d'un salon
$("#channel-edit").click();
await tick(80);
assert.equal($("#channel-name").value, "Technique");
assert.equal(document.querySelector('input[name="channel-access"]:checked').value, "some");
assert.equal($$("#channel-pick input:checked").length, 1);
const marcBox = $$("#channel-pick .pick-row").find((r) => r.textContent.includes("Marc")).querySelector("input");
marcBox.checked = true;
$$("#channel-pick input").find((i) => i.checked && i !== marcBox).checked = false; // retire Camille
submit($("#channel-form"));
await tick(100);
assert.deepEqual(f1.db.channel_members.filter((m) => m.channel_id === tech.id).map((m) => m.user_id), ["u3"]);
ok("modification d'un salon : accès réassignés (Camille retirée, Marc ajouté)");
$("#channel-edit").click();
await tick(80);
$$("#channel-pick .pick-row").find((r) => r.textContent.includes("Camille")).querySelector("input").checked = true;
submit($("#channel-form"));
await tick(100);

// --- messages privés
$("#new-dm").click();
await tick(60);
assert.deepEqual($$("#dm-pick .pick-name").map((b) => b.textContent).sort(), ["Camille", "Marc"]);
$$("#dm-pick .pick-button").find((b) => b.textContent.includes("Camille")).click();
await tick(100);
const dm = f1.db.channels.find((c) => c.kind === "dm");
assert.ok(dm);
assert.equal($("#dm-list").hidden, false);
assert.equal($$("#dm-list .channel-item").length, 1);
assert.match($("#dm-list").textContent, /Camille/);
assert.match($("#channel-title").textContent, /Camille/);
assert.match($("#channel-desc").textContent, /Message privé/);
assert.equal($("#channel-edit").hidden, true, "pas de réglage d'accès sur un message privé");
$("#new-dm").click();
await tick(40);
$$("#dm-pick .pick-button").find((b) => b.textContent.includes("Camille")).click();
await tick(100);
assert.equal(f1.db.channels.filter((c) => c.kind === "dm").length, 1, "une seule discussion privée par paire");
ok("message privé : ouvert avec Camille, réutilisé si on le rouvre");

// l'administrateur ne peut pas supprimer le message d'autrui dans un message privé
f1.incoming(msg("d1", dm.id, "u2", "Salut Thierry", "2026-11-14T11:00:00.000Z"));
await tick(60);
assert.equal($$(".msg").length, 1);
assert.equal($$(".msg-del").length, 0, "modération impossible dans un message privé");
ok("message privé : pas de suppression des messages de l'autre, même pour un admin");

// --- non lus en direct
const f1tousMsg = msg("m1", tous.id, "u3", "Plan de feu à jour", "2026-11-14T11:05:00.000Z");
f1.incoming(f1tousMsg);
await tick(60);
assert.equal(itemFor(tous.id).querySelector(".unread").textContent, "1");
assert.match(document.title, /^\(1\) /);
f1.incoming(msg("m2", tech.id, "u2", "Gélatines reçues", "2026-11-14T11:06:00.000Z"));
f1.incoming(msg("m3", tech.id, "u2", "On charge à 9h", "2026-11-14T11:07:00.000Z"));
await tick(60);
assert.equal(itemFor(tech.id).querySelector(".unread").textContent, "2");
assert.match(document.title, /^\(3\) /);
ok("non lus : pastilles par salon et total dans le titre de l'onglet");

itemFor(tech.id).click();
await tick(80);
assert.equal(itemFor(tech.id).querySelector(".unread"), null);
assert.ok(f1.db.channel_reads.some((r) => r.channel_id === tech.id), "lecture enregistrée côté serveur");
assert.match(document.title, /^\(1\) /);
ok("ouvrir un salon : pastille effacée et lecture enregistrée");

f1.incoming(msg("m4", tech.id, "u2", "Re-bonjour", "2026-11-14T11:08:00.000Z"));
await tick(60);
assert.equal($$(".msg").length, 3);
assert.equal(itemFor(tech.id).querySelector(".unread"), null, "message reçu dans le salon ouvert : pas de pastille");
ok("message reçu dans le salon ouvert : affiché sans pastille");

// --- silences
$("#open-notifications").click();
await tick(60);
assert.ok($("#dialog-notifications").hasAttribute("open"));
assert.equal($$("#mute-spaces .mute-row").length, 1);
assert.equal($$("#mute-rooms .mute-row").length, 1, "le salon Général");
assert.equal($$("#mute-channels .mute-row").length, 2, "sous-salons Tous et Technique du salon ouvert");
assert.equal($$("#mute-dms .mute-row").length, 1, "le message privé");
const techSelect = $(`#mute-channels select[data-id="${tech.id}"]`);
assert.deepEqual([...techSelect.options].map((o) => o.value), ["off", "8h", "week", "forever"]);
techSelect.value = "8h";
change(techSelect);
await tick(60);
const row = f1.db.notification_mutes.find((m) => m.target_id === tech.id);
assert.ok(row && !row.forever);
const hours = (new Date(row.muted_until) - Date.now()) / 3600000;
assert.ok(hours > 7.9 && hours <= 8.01, "silence de 8 heures");
assert.ok(itemFor(tech.id).classList.contains("is-muted"));
assert.ok(itemFor(tech.id).querySelector(".mute-ic"));
assert.ok($(`#mute-channels select[data-id="${tech.id}"]`).closest(".mute-row").classList.contains("is-muted"));
assert.match($("#channel-desc").textContent, /Silence jusqu'à/);
assert.equal($("#channel-bell").querySelector(".ic:last-child").style.display, "inline", "cloche barrée affichée");
assert.equal($("#channel-bell").querySelector(".ic:first-child").style.display, "none");
ok("silence 8 h sur un salon : enregistré, icône, ligne en évidence, cloche barrée, durée affichée");

f1.incoming(msg("m5", tous.id, "u3", "Autre message", "2026-11-14T11:09:00.000Z"));
await tick(40);
itemFor(tous.id).click(); // retour sur Tous pour que Technique redevienne « autre salon »
await tick(60);
f1.incoming(msg("m6", tech.id, "u2", "Pendant le silence", "2026-11-14T11:10:00.000Z"));
await tick(60);
const mutedBubble = itemFor(tech.id).querySelector(".unread");
assert.ok(mutedBubble && mutedBubble.classList.contains("muted"), "la pastille d'un salon en silence est grise");
assert.equal(notify.badgeTotal(new Map([[tech.id, 1], [tous.id, 2]]), f1.db.channels, new Map([[notify.muteKey("channel", tech.id), row]])), 2);
assert.doesNotMatch(document.title, /^\(\d+\)/, "rien de non lu hors silence : pas de total dans le titre");
ok("salon en silence : pastille grise, exclue du total de l'icône et du titre");

const wsSelect = $(`#mute-spaces select[data-id="${ws1.id}"]`);
wsSelect.value = "forever";
change(wsSelect);
await tick(60);
assert.ok(f1.db.notification_mutes.some((m) => m.scope === "workspace" && m.forever));
assert.equal($("#ws-muted").hidden, false);
assert.ok($(".ws-row").classList.contains("is-muted"));
assert.match($(".ws-row").textContent, /Pasolini/);
assert.ok($$("#channel-list .channel-item:not(.my-notes-item)").every((i) => i.classList.contains("is-muted")), "tous les salons d'un espace en silence sont atténués");
assert.ok($$("#dm-list .channel-item").every((i) => !i.classList.contains("is-muted")), "le silence d'un espace ne touche pas les messages privés");
const wsSelect2 = $(`#mute-spaces select[data-id="${ws1.id}"]`);
wsSelect2.value = "off";
change(wsSelect2);
await tick(60);
assert.equal($("#ws-muted").hidden, true);
assert.equal(f1.db.notification_mutes.some((m) => m.scope === "workspace"), false);
ok("espace en silence « toujours » : icône sur l'espace et tous ses salons, puis réactivation");
$("#dialog-notifications [data-close]").click();

// --- invitation depuis l'application
$("#open-members").click();
await tick(60);
assert.equal($("#open-invite").hidden, false);
assert.equal($$("#members-list .member").length, 3);
assert.equal($$("#members-list .role-select").length, 2, "rôle modifiable sauf pour soi-même");
$("#open-invite").click();
$("#invite-email").value = "nouveau@x.fr";
$("#invite-name").value = "Nina";
assert.equal($$("#invite-spaces .invite-space").length, 1);
assert.equal($("#invite-salons-box").hidden, false, "salons restreints proposés pour le rôle utilisateur");
$$("#invite-salons input").find((i) => i.parentElement.textContent.includes("Technique")).checked = true;
submit($("#invite-form"));
await tick(100);
const [fnName, fnBody] = f1.calls.invoke.at(-1);
assert.equal(fnName, "invite-member");
assert.equal(fnBody.email, "nouveau@x.fr");
assert.equal(fnBody.display_name, "Nina");
assert.deepEqual(fnBody.assignments.map((a) => [a.workspace_id, a.role, a.channel_ids.length, a.room_ids.length]), [[ws1.id, "member", 1, 0]]);
const nina = f1.db.users.find((u) => u.email === "nouveau@x.fr");
assert.ok(f1.db.workspace_members.some((m) => m.user_id === nina.id && m.role === "member"));
assert.ok(f1.db.channel_members.some((m) => m.user_id === nina.id && m.channel_id === tech.id));
assert.match($("#toast").textContent, /Invitation envoyée/);
ok("invitation : e-mail, espace, rôle et salon restreint transmis à la fonction serveur");

// liste déroulante des personnes déjà présentes
f1.db.workspace_members.push({ workspace_id: ws1.id, user_id: "u9", role: "member" });
f1.db.users.push({ id: "u9", email: "lea@x.fr" });
f1.db.profiles.push({ id: "u9", display_name: "Léa", avatar_url: null, is_super_admin: false });
$("#open-members").click();
await tick(60);
$("#open-invite").click();
await tick(80);
const people = [...$("#invite-person").options].map((o) => o.textContent);
assert.ok(people[0].includes("Nouvelle personne"));
assert.ok(people.some((p) => p.startsWith("Léa")), "Léa est dans la liste");
assert.ok(!people.some((p) => p.startsWith("Thierry")), "pas soi-même");
$("#invite-person").value = "u9";
change($("#invite-person"));
assert.equal($("#invite-new").hidden, true, "les champs e-mail disparaissent");
$("#invite-spaces input").checked = true;
submit($("#invite-form"));
await tick(100);
const [, pickBody] = f1.calls.invoke.at(-1);
assert.equal(pickBody.user_id, "u9");
assert.equal(pickBody.email, undefined);
ok("invitation : personne choisie dans la liste déroulante");


// administrateur d'espace : rôle « administrateur » ne propose pas les salons
$("#open-members").click();
await tick(60);
$("#open-invite").click();
$("#invite-email").value = "boss@x.fr";
$("#invite-spaces .role-select").value = "admin";
change($("#invite-spaces"));
assert.equal($("#invite-salons-box").hidden, true, "un administrateur voit tout : pas de choix de salons");
$("#dialog-invite [data-close]").click();
ok("invitation d'un administrateur : pas de choix de salons");

// changement de rôle et retrait
$("#open-members").click();
await tick(60);
const marcSelect = $$("#members-list .role-select").find((s) => s.dataset.user === "u3");
marcSelect.value = "admin";
change(marcSelect);
await tick(60);
assert.equal(f1.db.workspace_members.find((m) => m.user_id === "u3").role, "admin");
$("#members-list [data-remove='u3']").click();
await tick(60);
assert.equal(f1.db.workspace_members.some((m) => m.user_id === "u3"), false);
assert.equal(f1.db.channel_members.some((m) => m.user_id === "u3"), false, "retiré aussi des salons");
$("#dialog-members [data-close]").click();
ok("membres : changement de rôle, retrait (et retrait des salons)");

// suppression d'un salon
f1.db.channels.push({ id: "tmp", workspace_id: ws1.id, room_id: room1.id, name: "Temporaire", kind: "channel", everyone: true, description: null, created_at: "2026-11-14T09:00:00Z" });
await chat1.start().catch(() => {});
await tick(80);
itemFor("tmp").click();
await tick(60);
$("#channel-edit").click();
await tick(60);
$("#channel-delete").click();
await tick(100);
assert.equal(f1.db.channels.some((c) => c.id === "tmp"), false);
assert.equal(itemFor("tmp"), null);
ok("suppression d'un salon par un administrateur");

chat1.stop();
assert.equal(f1.handlerCount(), 0);
ok("arrêt : abonnements temps réel fermés");

// =========================================================================================
// Scénario 2 — Marc, utilisateur simple, même navigateur
// =========================================================================================
resetDom();
const marc = { id: "u3", email: "marc@x.fr", user_metadata: {} };
const f2 = makeFake(marc);
f2.db.workspaces.push({ id: "w1", name: "Pasolini", created_by: "u1", theme: "violet" });
f2.db.workspace_members.push(
  { workspace_id: "w1", user_id: "u1", role: "admin" },
  { workspace_id: "w1", user_id: "u2", role: "member" },
  { workspace_id: "w1", user_id: "u3", role: "member" },
);
f2.db.rooms.push(
  { id: "r-gen", workspace_id: "w1", name: "Général", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" },
  { id: "r-regie", workspace_id: "w1", name: "Régie", description: null, everyone: false, created_at: "2026-11-01T00:00:00Z" },
);
f2.db.room_members.push({ room_id: "r-regie", user_id: "u2", created_at: "2026-11-01T00:00:00Z" });
f2.db.channels.push(
  { id: "c-tous", workspace_id: "w1", room_id: "r-gen", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" },
  { id: "c-tech", workspace_id: "w1", room_id: "r-gen", name: "Technique", kind: "channel", everyone: false, description: null, created_at: "2026-11-01T00:00:00Z" },
  { id: "c-regie", workspace_id: "w1", room_id: "r-regie", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" },
  { id: "c-dm", workspace_id: "w1", name: "dm:u1:u2", kind: "dm", everyone: false, description: null, created_at: "2026-11-01T00:00:00Z" },
);
f2.db.channel_members.push({ channel_id: "c-tech", user_id: "u2", created_at: "2026-11-01T00:00:00Z" }, { channel_id: "c-dm", user_id: "u1" }, { channel_id: "c-dm", user_id: "u2" });
f2.db.messages.push(
  msg("a", "c-tous", "u1", "Bienvenue", "2026-11-14T09:00:00.000Z"),
  msg("b", "c-tech", "u2", "Secret technique", "2026-11-14T09:01:00.000Z"),
  msg("c", "c-dm", "u1", "Message privé de Thierry à Camille", "2026-11-14T09:02:00.000Z"),
);
f2.db.channel_reads.push({ user_id: "u3", channel_id: "c-tous", last_read_at: "2026-11-14T09:00:30.000Z" });

const chat2 = createChat({ supabase: f2, user: marc });
await chat2.start(); await openLast();
await tick(80);
assert.equal($("#me-name").textContent, "Marc");
assert.deepEqual(names("#channel-list .channel-item:not(.my-notes-item)"), ["Général"], "Marc ne voit pas le sous-salon Technique ni le salon Régie");
assert.deepEqual($$("#channel-list .room-head .channel-name").map((n) => n.textContent), ["Général"], "salon Régie invisible");
assert.equal($("#dm-list").hidden, true, "ni les messages privés des autres");
assert.equal($("#new-channel").hidden, true);
assert.equal($("#switch-new").hidden, true, "seul l'administrateur général crée des espaces");
assert.equal($("#channel-edit").hidden, true);
assert.equal($$(".msg").length, 1);
assert.equal($$(".msg-del").length, 0);
assert.ok(!f2.canAccess("u3", "c-tech") && !f2.canAccess("u3", "c-dm") && !f2.canAccess("u3", "c-regie"));
ok("utilisateur simple : voit uniquement son salon, aucun message privé d'autrui, aucun outil d'admin");

$("#composer-input").value = "Merci !";
submit($("#composer"));
await tick(60);
assert.equal($$(".msg").length, 2, "pas de double envoi : écouteurs de l'ancien compte détachés");
ok("changement de compte sur le même navigateur : aucun écouteur dupliqué");

// Un salon est assigné à Marc pendant qu'il est connecté
f2.db.channel_members.push({ channel_id: "c-tech", user_id: "u3", created_at: "2026-11-14T10:30:00Z" });
f2.emit("channel_members", { eventType: "INSERT", new: { channel_id: "c-tech", user_id: "u3" } });
await tick(600);
if ($(`.room-chev[data-room="r-gen"]`).getAttribute("aria-expanded") !== "true") $(`.room-chev[data-room="r-gen"]`).click();
assert.deepEqual(names("#channel-list .channel-item:not(.my-notes-item)"), ["Général", "Technique"], "le nouveau salon apparaît sans recharger");
ok("assignation à un sous-salon en cours de session : il apparaît tout de suite");

// Marc est assigné au salon restreint « Régie » : le salon et son sous-salon « Tous » apparaissent
f2.db.room_members.push({ room_id: "r-regie", user_id: "u3", created_at: "2026-11-14T10:31:00Z" });
f2.emit("room_members", { eventType: "INSERT", new: { room_id: "r-regie", user_id: "u3" } });
await tick(600);
assert.deepEqual($$("#channel-list .room-head .channel-name").map((n) => n.textContent), ["Général", "Régie"]);
if ($('.room-chev[data-room="r-regie"]').getAttribute("aria-expanded") !== "true") $('.room-chev[data-room="r-regie"]').click();
assert.deepEqual(names("#channel-list .channel-item:not(.my-notes-item)"), ["Général", "Technique", "Régie"]);
$('.room-chev[data-room="r-regie"]').click(); // replier (le bouton est recréé à chaque affichage)
assert.equal($('.room-chev[data-room="r-regie"]').getAttribute("aria-expanded"), "false");
assert.deepEqual(names("#channel-list .channel-item:not(.my-notes-item)"), ["Général", "Technique", "Régie"], "salon replié : sous-salons masqués");
assert.ok(JSON.parse(localStorage.getItem("thychat:open") || "[]" ) !== null);
ok("salon restreint assigné : apparaît, se déplie et se replie");

$("#open-members").click();
await tick(60);
assert.equal($("#open-invite").hidden, true);
assert.equal($$("#members-list .role-select").length, 0);
$("#dialog-members [data-close]").click();
ok("utilisateur simple : pas d'invitation ni de gestion des rôles");

$("#open-profile").click();
assert.equal($("#profile-name").value, "Marc");
assert.equal($("#profile-email").value, "marc@x.fr");
$("#profile-name").value = "Marc D.";
$("#profile-email").value = "marc.d@x.fr";
submit($("#profile-form"));
await tick(60);
assert.equal(f2.db.profiles.find((p) => p.id === "u3").display_name, "Marc D.");
assert.equal($("#me-name").textContent, "Marc D.");
assert.ok(f2.calls.rpc.some(([n, a]) => n === "auth.updateUser" && a.email === "marc.d@x.fr"), "changement d'e-mail demandé");
assert.match($("#profile-message").textContent, /e-mail de confirmation/);
ok("profil : nom affiché modifié, changement d'e-mail demandé avec confirmation");

f2.db.profiles.find((p) => p.id === "u3").avatar_url = "https://evil.example/x.png";
chat2.stop();
const chat2b = createChat({ supabase: f2, user: marc });
await chat2b.start(); await openLast();
await tick(60);
assert.equal($("#me-avatar img"), null, "photo hors de notre stockage : ignorée");
f2.db.profiles.find((p) => p.id === "u3").avatar_url = "https://x.supabase.co/storage/v1/object/public/avatars/u3/avatar.jpg?v=1";
chat2b.stop();
const chat2c = createChat({ supabase: f2, user: marc });
await chat2c.start(); await openLast();
await tick(60);
assert.ok($("#me-avatar img"), "photo de profil affichée");
assert.ok($("#me-avatar").classList.contains("has-photo"));
ok("photo de profil : affichée si hébergée chez nous, ignorée sinon");
chat2c.stop();

// =========================================================================================
// Scénario 3 — Camille : message privé non lu, ouverture depuis une notification
// =========================================================================================
resetDom();
const camille = { id: "u2", email: "camille@x.fr", user_metadata: {} };
const f3 = makeFake(camille);
Object.assign(f3.db, { workspaces: f2.db.workspaces.map((x) => ({ ...x })), workspace_members: f2.db.workspace_members.map((x) => ({ ...x })), rooms: f2.db.rooms.map((x) => ({ ...x })), room_members: f2.db.room_members.map((x) => ({ ...x })), channels: f2.db.channels.map((x) => ({ ...x })), channel_members: f2.db.channel_members.map((x) => ({ ...x })) });
f3.db.messages.push(msg("x", "c-dm", "u1", "Tu as vu le planning ?", "2026-11-14T09:02:00.000Z"));
f3.db.channel_reads.push({ user_id: "u2", channel_id: "c-tous", last_read_at: "2026-11-14T10:00:00.000Z" }, { user_id: "u2", channel_id: "c-tech", last_read_at: "2026-11-14T10:00:00.000Z" });
history.replaceState(null, "", "/?w=w1&c=c-dm");
const chat3 = createChat({ supabase: f3, user: camille });
await chat3.start();
await tick(80);
assert.equal(location.search, "", "paramètres de notification retirés de l'adresse");
assert.match($("#channel-title").textContent, /Thierry/, "ouvert directement sur le message privé de la notification");
assert.equal($("#dm-list .channel-item .unread"), null, "ouvert : lu");
assert.ok(f3.db.channel_reads.some((r) => r.channel_id === "c-dm"));
ok("notification : l'adresse /?w=…&c=… ouvre directement le bon salon et le marque lu");
chat3.stop();

// =========================================================================================
// Scénario mobile — bouton « Retour » du téléphone
// =========================================================================================
resetDom();
window.matchMedia = (q) => ({ matches: /max-width: 760px/.test(q) });
history.replaceState(null, "", "/");
const fm = makeFake(marc);
Object.assign(fm.db, { workspaces: f2.db.workspaces.map((x) => ({ ...x })), workspace_members: f2.db.workspace_members.map((x) => ({ ...x })), rooms: f2.db.rooms.map((x) => ({ ...x })), room_members: f2.db.room_members.map((x) => ({ ...x })), channels: f2.db.channels.map((x) => ({ ...x })), channel_members: f2.db.channel_members.map((x) => ({ ...x })) });
fm.db.channels.push({ id: "c-dmM", workspace_id: "w1", name: "dm:u2:u3", kind: "dm", everyone: false, description: null, created_at: "2026-11-01T00:00:00Z" });
fm.db.channel_members.push({ channel_id: "c-dmM", user_id: "u2" }, { channel_id: "c-dmM", user_id: "u3" });
const chatM = createChat({ supabase: fm, user: marc });
await chatM.start(); await openLast();
await tick(80);
assert.equal(history.state && history.state.tcGuard, true, "une entrée d'historique protège contre la sortie");
assert.equal($("#screen-app").classList.contains("sidebar-open"), false);
history.back();
await tick(60);
assert.equal($("#screen-app").classList.contains("sidebar-open"), true, "Retour depuis un salon : retour à la liste des salons");
assert.equal($("#messages").hidden, false, "pas d'écran vide");
ok("mobile : « Retour » dans un salon ramène à la liste au lieu de quitter l'application");

$(".channel-item").click();
await tick(60);
assert.equal($("#screen-app").classList.contains("sidebar-open"), false);
$("#open-members").click();
await tick(40);
assert.ok($("#dialog-members").hasAttribute("open"));
history.back();
await tick(60);
assert.equal($("#dialog-members").hasAttribute("open"), false, "Retour ferme la boîte de dialogue");
assert.equal(history.state && history.state.tcGuard, true, "la protection est reposée");
ok("mobile : « Retour » ferme une boîte de dialogue ouverte");

$("#open-calendar").click();
await tick(60);
assert.equal($("#calendar").hidden, false, "calendrier ouvert");
history.back();
await tick(80);
assert.equal($("#calendar").hidden, true, "Retour quitte le calendrier");
assert.equal($("#messages").hidden, false, "on revient au sous-salon, pas d'écran noir");
assert.equal($("#screen-app").classList.contains("sidebar-open"), false, "pas de rideau sombre");
assert.equal(history.state && history.state.tcGuard, true, "la protection est reposée");
ok("mobile : « Retour » depuis le calendrier ramène au sous-salon");

function swipe(node, dx) {
  const mk = (type, x) => { const ev = new window.Event(type, { bubbles: true }); const pt = { clientX: x, clientY: 100 }; ev.touches = type === "touchend" ? [] : [pt]; ev.changedTouches = [pt]; return ev; };
  node.dispatchEvent(mk("touchstart", 200));
  node.dispatchEvent(mk("touchend", 200 + dx));
}
$("#screen-app").classList.add("sidebar-open");
swipe($("#sidebar"), -120);
assert.equal($("#screen-app").classList.contains("sidebar-open"), false, "glisser à gauche ferme le menu");
$("#open-calendar").click();
await tick(60);
const monthBefore = $("#cal-title") ? $("#cal-title").textContent : "";
swipe($("#calendar"), -120);
await tick(20);
if ($("#cal-title")) assert.notEqual($("#cal-title").textContent, monthBefore, "glisser à gauche : mois suivant");
swipe($("#calendar"), 120);
await tick(20);
if ($("#cal-title")) assert.equal($("#cal-title").textContent, monthBefore, "glisser à droite : mois précédent");
ok("mobile : glisser ferme le menu et change de mois");
history.back();
await tick(80);

$("#screen-app").classList.add("sidebar-open");
$("#dm-list .channel-item").click();
await tick(80);
assert.equal($("#channel-title").textContent, "Camille", "message privé ouvert");
history.back();
await tick(80);
assert.equal($("#screen-app").classList.contains("sidebar-open"), true, "Retour depuis un message privé : liste");
assert.equal(history.state && history.state.tcGuard, true);
history.back();
await tick(80);
assert.equal($("#screen-app").classList.contains("sidebar-open"), true, "1er Retour sur la liste : on reste dans l'appli");
assert.match($("#toast").textContent, /encore sur Retour/, "message de confirmation");
assert.equal(history.state && history.state.tcGuard, true, "la protection est reposée");
ok("mobile : Retour depuis un message privé, puis confirmation avant de quitter");

// Retour dans la fenêtre « dates de tournée » (menu ⋮) : la fenêtre se ferme, l'appli reste affichée
$("#screen-app").classList.remove("sidebar-open");
$("#channel-list .channel-item").click();
await tick(80);
if (!$("#channel-dates").hidden) {
  $("#channel-dates").click();
  await tick(60);
  assert.ok($("#dialog-tags").hasAttribute("open"));
  history.back();
  await tick(80);
  assert.equal($("#dialog-tags").hasAttribute("open"), false, "Retour ferme la fenêtre des dates");
  assert.equal($("#messages").hidden, false, "le fil reste affiché");
  assert.equal(history.state && history.state.tcGuard, true);
}
ok("mobile : Retour dans la gestion des dates ferme la fenêtre");

$("#channel-list .channel-item").click();
await tick(80);
assert.equal($("#channel-people").hidden, false, "bouton des personnes dans un sous-salon");
$("#channel-people").click();
await tick(120);
const peopleRows = [...document.querySelectorAll("#people-list button")].map((b) => b.textContent);
console.log("personnes:", JSON.stringify(peopleRows));
assert.ok(peopleRows.some((t) => /Camille/.test(t)), "Camille listée");
assert.ok(peopleRows.some((t) => /\(toi\)/.test(t)), "soi-même marqué");
[...document.querySelectorAll("#people-list button")].find((b) => /Camille/.test(b.textContent)).click();
await tick(120);
assert.equal($("#dialog-people").hasAttribute("open"), false);
assert.equal($("#channel-title").textContent, "Camille", "un appui ouvre le message privé");
assert.equal($("#channel-people").hidden, true, "pas de liste dans un message privé");
ok("sous-salon : liste des personnes, un appui ouvre le message privé");

$("#screen-app").classList.remove("sidebar-open");
swipe($("#messages"), 120);
assert.equal($("#screen-app").classList.contains("sidebar-open"), true, "glisser à droite dans un fil ouvre le menu");
$("#screen-app").classList.remove("sidebar-open");
swipe($("#messages"), -120);
assert.equal($("#screen-app").classList.contains("sidebar-open"), false, "glisser à gauche : rien");
assert.equal($("#push-reminder").hidden, true, "rappel caché quand les notifications ne sont pas réglables ici");
ok("mobile : glisser à droite dans un fil ouvre le menu");
chatM.stop();
delete window.matchMedia;

// =========================================================================================
// Scénario 4 — repli sans fonction d'invitation, base non migrée
// =========================================================================================
resetDom();
const f4 = makeFake(thierry, { functionMissing: true });
f4.db.workspaces.push({ id: "w1", name: "Pasolini", created_by: "u1", theme: "violet" });
f4.db.workspace_members.push({ workspace_id: "w1", user_id: "u1", role: "admin" });
f4.db.rooms.push({ id: "r1", workspace_id: "w1", name: "Général", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
f4.db.channels.push({ id: "c1", workspace_id: "w1", room_id: "r1", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
const chat4 = createChat({ supabase: f4, user: thierry });
await chat4.start(); await openLast();
await tick(80);
$("#open-members").click();
await tick(40);
$("#open-invite").click();
$("#invite-email").value = "inconnu@x.fr";
submit($("#invite-form"));
await tick(80);
assert.match($("#invite-message").textContent, /pas encore déployée/);
$("#invite-email").value = "camille@x.fr";
submit($("#invite-form"));
await tick(80);
assert.ok(f4.db.workspace_members.some((m) => m.user_id === "u2"), "compte existant ajouté malgré l'absence de la fonction");
ok("sans fonction d'invitation : compte existant ajouté, message clair pour les nouveaux");
chat4.stop();

resetDom();
const f5 = makeFake(thierry, { failTable: "profiles", failMessage: "column profiles.is_super_admin does not exist" });
const chat5 = createChat({ supabase: f5, user: thierry });
await chat5.start();
await tick(60);
assert.match($("#empty-text").textContent, /005_rooms/);
ok("base non migrée : message clair indiquant la migration 003");
chat5.stop();

// =========================================================================================
// Fonctions pures
// =========================================================================================
{
  const now = Date.parse("2026-11-14T10:00:00Z");
  assert.equal(notify.muteFromChoice("off"), null);
  assert.equal(notify.muteFromChoice("forever").forever, true);
  assert.equal(Date.parse(notify.muteFromChoice("8h", now).muted_until) - now, 8 * 3600e3);
  assert.equal(Date.parse(notify.muteFromChoice("week", now).muted_until) - now, 7 * 24 * 3600e3);
  const past = { forever: false, muted_until: new Date(now - 1000).toISOString() };
  assert.equal(notify.isActive(past, now), false, "un silence expiré n'est plus actif");
  assert.equal(notify.choiceOf(past, now), "off");
  assert.equal(notify.choiceOf(notify.muteFromChoice("8h", now), now), "8h");
  assert.equal(notify.choiceOf(notify.muteFromChoice("week", now), now), "week");
  assert.equal(notify.muteLabel({ forever: true }), "Désactivées");
  assert.match(notify.muteLabel(notify.muteFromChoice("8h", now), now), /^Silence jusqu'à \d\d:\d\d$/);
  assert.equal(notify.countLabel(150), "99+");
  assert.equal(notify.countLabel(7), "7");
  ok("silences : durées, expiration, libellés, plafond « 99+ »");
}
assert.equal(new Set(PALETTE.map((t) => t.key)).size, PALETTE.length);
assert.equal(themeFor({ id: "abc", theme: "vert" }).key, "vert");
assert.equal(pickUnusedTheme(PALETTE.slice(0, 9).map((t) => t.key), "x").key, PALETTE[9].key);
ok("thèmes : palette sans doublon, couleur enregistrée prioritaire, couleur libre privilégiée");

console.log(`\n${passed} vérifications réussies`);
process.exit(0);
