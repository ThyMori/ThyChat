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
f.db.channels.push({ id: "c1", workspace_id: "w1", room_id: "r1", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
//, workspace_id: "w1", room_id: "r2", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
f.db.workspaces.push({ id: "w2", name: "Studio", created_by: "u1", theme: "bleu" });
f.db.workspace_members.push({ workspace_id: "w2", user_id: "u1", role: "member" });
f.db.profiles.push({ id: "u2", display_name: "Camille", avatar_url: null, is_super_admin: false });
f.db.workspace_members.push({ workspace_id: "w1", user_id: "u2", role: "member" }, { workspace_id: "w2", user_id: "u2", role: "member" });
f.db.rooms.push({ id: "r9", workspace_id: "w2", name: "Cabaret", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
f.db.channels.push({ id: "c9", workspace_id: "w2", room_id: "r9", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });

await tick(100);



// discussion privée ouverte depuis l'espace Compagnie
$("#new-dm").click(); await tick(60);
f.db.rooms.push({ id: "r10", workspace_id: "w2", name: "Revue", description: null, everyone: true, created_at: "2026-11-02T00:00:00Z" });
f.db.channels.push({ id: "c10", workspace_id: "w2", room_id: "r10", name: "Régie", kind: "channel", everyone: true, description: null, created_at: "2026-11-02T00:00:00Z" });
f.db.workspaces.push({ id: "w3", name: "Vide", created_by: "u1", theme: "vert" });
f.db.workspace_members.push({ workspace_id: "w3", user_id: "u1", role: "admin" });
f.db.channels.push({ id: "cdm", workspace_id: "w1", room_id: null, name: "dm:u1:u2", kind: "dm", everyone: false, description: null, created_at: "2026-11-01T00:00:00Z" });
f.db.channel_members.push({ channel_id: "cdm", user_id: "u1" }, { channel_id: "cdm", user_id: "u2" });

const chat2 = createChat({ supabase: f, user: thierry });
await chat2.start();
await tick(80);
const wsTitle = () => $("#workspace-name") ? $("#workspace-name").textContent : "";
$(`.channel-item[data-id="c1"]`) && 0;

// on ouvre un message privé dans l'espace 1, puis on change d'espace
$(`.channel-item[data-id="cdm"]`).click();
await tick(80);
assert.equal($("#channel-title").textContent, "Camille");
$("#workspace-button").click();
await tick(60);
$$(".ws-row").find((r) => /Studio/.test(r.textContent)).click();
await tick(100);
assert.notEqual($("#channel-title").textContent, "Camille", "pas de message privé en changeant d'espace");
assert.equal($("#messages").hidden, false, "un fil est ouvert");
// on choisit le 2e sous-salon de Studio, on part ailleurs, on revient
if (!$(`.channel-item[data-id="c10"]`)) $(`.room-toggle[data-room="r10"]`).click();
$(`.channel-item[data-id="c10"]`).click();
await tick(80);
assert.equal($("#channel-title").textContent, "Revue");
$("#workspace-button").click();
await tick(60);
$$(".ws-row").find((r) => /Compagnie/.test(r.textContent)).click();
await tick(100);
assert.equal($("#channel-title").textContent, "Hamlet");
$("#workspace-button").click();
await tick(60);
$$(".ws-row").find((r) => /Studio/.test(r.textContent)).click();
await tick(100);
assert.equal($("#channel-title").textContent, "Revue", "retour sur le dernier fil de cet espace");
// espace sans fil : page vide
$("#workspace-button").click();
await tick(60);
$$(".ws-row").find((r) => /Vide/.test(r.textContent)).click();
await tick(100);
assert.equal($("#messages").hidden, true, "page vide");
assert.equal($("#empty-state").hidden, false);
console.log("spaces ok");
chat2.stop();
