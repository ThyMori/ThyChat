import { JSDOM } from "jsdom";
import fs from "node:fs";
import assert from "node:assert/strict";
const root = new URL("../dist", import.meta.url).pathname; // résultat du build
const html = fs.readFileSync(`${root}/index.html`, "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
let n = 0;
async function scenario(name, { ua = "Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537", standalone = false, store = {}, platform = "Win32", touch = 0 } = {}, fn) {
  const dom = new JSDOM(html, { url: "https://thychat.thierry-morin.com/", userAgent: ua });
  const w = dom.window;
  Object.defineProperty(w.navigator, "userAgent", { value: ua, configurable: true });
  Object.defineProperty(w.navigator, "platform", { value: platform, configurable: true });
  Object.defineProperty(w.navigator, "maxTouchPoints", { value: touch, configurable: true });
  w.matchMedia = (q) => ({ matches: standalone && /display-mode: standalone/.test(q) });
  for (const [k, v] of Object.entries(store)) w.localStorage.setItem(k, JSON.stringify(v));
  for (const k of ["window", "document", "navigator", "localStorage"]) Object.defineProperty(globalThis, k, { value: w[k === "window" ? "self" : k], configurable: true, writable: true });
  globalThis.window = w;
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const mod = await import(`${root}/js/install.js?${n++}`);
  await fn(mod, w);
  console.log("  ✓", name);
}
const $ = (w, s) => w.document.querySelector(s);
const K = "thychat:install";

const { detectPlatform } = await import(`${root}/js/install.js?d`);
const ua = (u, extra = {}) => detectPlatform({ userAgent: u, ...extra });
assert.equal(ua("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari"), "ios");
assert.equal(ua("Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari", { platform: "MacIntel", maxTouchPoints: 5 }), "ios");
assert.equal(ua("Mozilla/5.0 (Macintosh; Intel Mac OS X) Version/17 Safari/605", { platform: "MacIntel", maxTouchPoints: 0 }), "mac-safari");
assert.equal(ua("Mozilla/5.0 (Macintosh) Chrome/120 Safari/537", { platform: "MacIntel" }), "desktop-chromium");
assert.equal(ua("Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile"), "android");
assert.equal(ua("Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/120.0"), "firefox-desktop");
assert.equal(ua("Mozilla/5.0 (Windows NT 10.0) Edg/120 Chrome/120"), "desktop-chromium");
console.log("  ✓ détection des plateformes");

await scenario("première visite : bannière « Voir comment », guide ouvert sur l'appareil", {}, async ({ initInstall }, w) => {
  initInstall();
  assert.equal($(w, "#install-banner").hidden, false);
  assert.equal($(w, "#install-now").textContent, "Voir comment");
  assert.equal($(w, "#open-install").hidden, false);
  $(w, "#install-now").click();
  assert.ok($(w, "#dialog-install").hasAttribute("open"));
  const mine = $(w, 'details[data-platform="desktop-chromium"]');
  assert.ok(mine.open && mine.style.order === "-1" && !mine.querySelector(".here").hidden);
  assert.ok(!$(w, 'details[data-platform="ios"]').open);
});
await scenario("iPhone : guide iOS en premier", { ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari" }, async ({ initInstall }, w) => {
  initInstall(); $(w, "#install-now").click();
  assert.ok($(w, 'details[data-platform="ios"]').open);
});
await scenario("« Plus tard » masque, mémorise ; revient après 7 jours ; s'arrête après 3 reports", {}, async ({ initInstall }, w) => {
  initInstall(); $(w, "#install-later").click();
  assert.equal($(w, "#install-banner").hidden, true);
  const s = JSON.parse(w.localStorage.getItem(K));
  assert.equal(s.count, 1);
  assert.ok(s.snoozedUntil > Date.now() + 6.9 * 864e5);
  assert.equal($(w, "#open-install").hidden, false); // l'entrée du menu reste
});
await scenario("report expiré : bannière revenue", { store: { [K]: { count: 1, snoozedUntil: Date.now() - 1 } } }, async ({ initInstall }, w) => {
  initInstall(); assert.equal($(w, "#install-banner").hidden, false);
});
await scenario("3 reports : plus de bannière, menu disponible", { store: { [K]: { count: 3, snoozedUntil: 0 } } }, async ({ initInstall }, w) => {
  initInstall(); assert.equal($(w, "#install-banner").hidden, true); assert.equal($(w, "#open-install").hidden, false);
});
await scenario("déjà en mode application : tout est masqué", { standalone: true }, async ({ initInstall }, w) => {
  initInstall(); assert.equal($(w, "#install-banner").hidden, true); assert.equal($(w, "#open-install").hidden, true);
});
await scenario("Firefox ordinateur : pas de bannière, guide explicatif", { ua: "Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/120.0" }, async ({ initInstall }, w) => {
  initInstall(); assert.equal($(w, "#install-banner").hidden, true);
  $(w, "#open-install").click(); assert.ok($(w, 'details[data-platform="firefox-desktop"]').open);
});
await scenario("invitation native : bouton Installer, accepté => installé", {}, async ({ initInstall }, w) => {
  initInstall();
  let prevented = false, prompted = false;
  const ev = new w.Event("beforeinstallprompt", { cancelable: true });
  ev.prompt = async () => { prompted = true; }; ev.userChoice = Promise.resolve({ outcome: "accepted" });
  const origPrevent = ev.preventDefault.bind(ev); ev.preventDefault = () => { prevented = true; origPrevent(); };
  w.dispatchEvent(ev);
  assert.ok(prevented);
  assert.equal($(w, "#install-now").textContent, "Installer");
  $(w, "#install-now").click();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(prompted);
  assert.equal(JSON.parse(w.localStorage.getItem(K)).installed, true);
  assert.equal($(w, "#install-banner").hidden, true);
  assert.equal($(w, "#open-install").hidden, true);
});
await scenario("bouton du menu : installe directement, puis disparaît", {}, async ({ initInstall }, w) => {
  initInstall();
  let prompted = false;
  const ev = new w.Event("beforeinstallprompt", { cancelable: true });
  ev.prompt = async () => { prompted = true; }; ev.userChoice = Promise.resolve({ outcome: "accepted" });
  w.dispatchEvent(ev);
  $(w, "#open-install").click();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(prompted, "la fenêtre d'installation native s'ouvre");
  assert.ok(!$(w, "#dialog-install").hasAttribute("open"), "pas de guide quand l'installation est possible");
  assert.equal($(w, "#open-install").hidden, true);
});
await scenario("invitation native refusée => reportée", {}, async ({ initInstall }, w) => {
  initInstall();
  const ev = new w.Event("beforeinstallprompt", { cancelable: true });
  ev.prompt = async () => {}; ev.userChoice = Promise.resolve({ outcome: "dismissed" });
  w.dispatchEvent(ev); $(w, "#install-now").click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(JSON.parse(w.localStorage.getItem(K)).count, 1);
  assert.equal($(w, "#install-banner").hidden, true);
});
await scenario("événement appinstalled", {}, async ({ initInstall }, w) => {
  initInstall(); w.dispatchEvent(new w.Event("appinstalled"));
  assert.equal($(w, "#install-banner").hidden, true);
});
await scenario("stockage indisponible : aucune erreur", {}, async ({ initInstall }, w) => {
  Object.defineProperty(w, "localStorage", { get() { throw new Error("denied"); }, configurable: true });
  Object.defineProperty(globalThis, "localStorage", { get() { throw new Error("denied"); }, configurable: true });
  initInstall(); $(w, "#install-later").click();
});
console.log("OK");
