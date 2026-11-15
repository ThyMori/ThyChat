import fs from "node:fs";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { makeFake } from "./fake.mjs";
const REPO = new URL("../dist", import.meta.url).pathname; // les tests s'exécutent sur le résultat du build
const html = fs.readFileSync(`${REPO}/index.html`, "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
const dom = new JSDOM(html, { url: "https://thychat.thierry-morin.com/" });
const { window } = dom;
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, AbortController: window.AbortController });
Object.defineProperty(globalThis, "location", { value: window.location, configurable: true });
Object.defineProperty(globalThis, "history", { value: window.history, configurable: true });
document.getElementById("screen-app").hidden = false;
const { createChat } = await import(`${REPO}/js/messagerie.js`);
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const dd = new Date(); dd.setDate(dd.getDate() - 1);
const YESTERDAY = `${dd.getFullYear()}-${pad(dd.getMonth() + 1)}-${pad(dd.getDate())}`;
const th = { id: "u1", email: "me@x.fr", user_metadata: {} };
const f = makeFake(th);
f.db.workspaces.push({ id: "w1", name: "Cie", created_by: "u1", theme: "violet" });
f.db.workspace_members.push({ workspace_id: "w1", user_id: "u1", role: "admin" });
f.db.rooms.push({ id: "r1", workspace_id: "w1", name: "Hamlet", description: null, everyone: true, created_at: "2026-11-01T00:00:00Z" });
f.db.channels.push({ id: "c1", workspace_id: "w1", room_id: "r1", name: "Tous", kind: "channel", everyone: true, description: null, created_at: "2026-11-01T00:00:00Z" });
f.db.tour_tags.push(
  { id: "a", room_id: "r1", label: "Passée", start_date: "2020-01-01", end_date: "2020-01-03", shows: ["2020-01-02"] },
  { id: "b", room_id: "r1", label: "Lointaine", start_date: "2099-05-01", end_date: "2099-05-03", shows: ["2099-05-03", "2099-05-02"] },
  { id: "y", room_id: "r1", label: "Hier", start_date: "2000-01-01", end_date: YESTERDAY, shows: [] },
  { id: "d", room_id: "r1", label: "Proche", start_date: "2098-01-01", end_date: "2098-01-02", shows: [] },
);
const chat = createChat({ supabase: f, user: th });
await chat.start(); await openLast();
await tick(80);
$("#channel-dates").click();
await tick(60);
const rows = $$("#tags-list .tag-row");
assert.deepEqual(rows.map((r) => r.querySelector("strong").textContent), ["Hier", "Proche", "Lointaine", "Passée"], "ordre chronologique, passée à la fin");
assert.ok(!rows[0].classList.contains("is-past") && rows[3].classList.contains("is-past"), "finie hier : pas rayée (retour) ; ancienne rayée");
assert.match(rows[2].textContent, /1–3 mai|1.3 mai/, "début et fin seulement");
assert.ok(!/représentation/.test(rows[2].textContent));
console.log("order ok");
chat.stop();
