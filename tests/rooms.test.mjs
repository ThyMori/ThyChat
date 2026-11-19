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
f.db.workspace_members.push({ workspace_id: "w1", user_id: "u1", role: "admin" }, { workspace_id: "w1", user_id: "u2", role: "member" }, { workspace_id: "w1", user_id: "u3", role: "member" });
const chat = createChat({ supabase: f, user: thierry });
await chat.start(); await openLast();
await tick(80);
assert.equal($("#empty-state").hidden, false);
assert.match($("#empty-action").textContent, /spectacle/i);
ok("espace sans salon : invitation à créer le premier salon");

$("#empty-action").click();
await tick(60);
assert.ok($("#dialog-room").hasAttribute("open"));
$("#room-name").value = "Hamlet";
$("#room-description").value = "Création 2027";
const some = document.querySelector('input[name="room-access"][value="some"]');
assert.equal(document.querySelector('input[name="room-access"]:checked').value, "some", "accès restreint par défaut");
assert.equal($("#room-pick").hidden, false);
some.checked = true; change(some);
assert.equal($("#room-pick").hidden, false);
await tick(40);
assert.equal($$("#room-pick .pick-row").length, 2);
$$("#room-pick .pick-row").find((r) => r.textContent.includes("Camille")).querySelector("input").checked = true;
submit($("#room-form"));
await tick(100);
const hamlet = f.db.rooms.find((r) => r.name === "Hamlet");
assert.ok(hamlet && hamlet.everyone === false);
assert.deepEqual(f.db.room_members.filter((m) => m.room_id === hamlet.id).map((m) => m.user_id), ["u2"]);
const sub = f.db.channels.find((c) => c.room_id === hamlet.id);
assert.equal(sub.name, "Général");
assert.match($("#channel-title").textContent, /Hamlet/);
assert.match($(".chat-head").textContent, /Hamlet/);
assert.ok($(".room-head .lock-ic"));
ok("création d'un salon restreint : assigné à Camille, sous-salon « Tous » créé et ouvert, cadenas");

// sous-salon : la liste de choix se limite aux personnes du salon
$(`[data-new-sub="${hamlet.id}"]`).click();
await tick(80);
assert.match($("#channel-room-note").textContent, /Hamlet/);
assert.match($("#channel-everyone-label").textContent, /Hamlet/);
const some2 = document.querySelector('input[name="channel-access"][value="some"]');
some2.checked = true; change(some2);
assert.deepEqual($$("#channel-pick .pick-name").map((n) => n.textContent), ["Camille"], "seuls les gens du salon sont proposés");
$("#channel-name").value = "Lumières";
$$("#channel-pick input")[0].checked = true;
submit($("#channel-form"));
await tick(100);
const lum = f.db.channels.find((c) => c.name === "Lumières");
assert.equal(lum.room_id, hamlet.id);
assert.equal(lum.everyone, false);
ok("sous-salon restreint : choix limité aux membres du salon");

// doublon de nom dans le même salon
$(`[data-new-sub="${hamlet.id}"]`).click();
await tick(60);
$("#channel-name").value = "Lumières";
submit($("#channel-form"));
await tick(80);
assert.match($("#channel-message").textContent, /déjà/);
$("#dialog-channel [data-close]").click();
ok("doublon de nom de sous-salon refusé dans le même salon");

// silence d'un salon
$("#open-notifications").click();
await tick(60);
assert.equal($$("#mute-rooms .mute-row").length, 1);
const sel = $(`#mute-rooms select[data-id="${hamlet.id}"]`);
sel.value = "forever"; change(sel);
await tick(60);
assert.ok(f.db.notification_mutes.some((m) => m.scope === "room" && m.target_id === hamlet.id && m.forever));
assert.ok($(`.room-group`).classList.contains("is-muted"));
assert.ok($$(".channel-item.sub").every((i) => i.classList.contains("is-muted")), "sous-salons atténués");
ok("salon en silence : le salon et ses sous-salons sont mis en évidence");
$("#dialog-notifications [data-close]").click();

// modifier puis supprimer le salon
$(`[data-room-edit="${hamlet.id}"]`).click();
await tick(80);
assert.equal($("#room-name").value, "Hamlet");
assert.equal(document.querySelector('input[name="room-access"]:checked').value, "some");
assert.equal($$("#room-pick input:checked").length, 1);
$("#room-name").value = "Hamlet 2027";
submit($("#room-form"));
await tick(100);
assert.ok(f.db.rooms.some((r) => r.name === "Hamlet 2027"));
$(`[data-room-edit="${hamlet.id}"]`).click();
await tick(60);
$("#room-delete").click();
await tick(100);
assert.equal(f.db.rooms.some((r) => r.id === hamlet.id), false);
assert.equal(f.db.channels.some((c) => c.room_id === hamlet.id), false);
ok("salon : renommé puis supprimé avec ses sous-salons");
chat.stop();
console.log(`\n${passed} vérifications réussies`);
