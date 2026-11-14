// Rappel et guide pour installer ThyChat comme une application (téléphone ou ordinateur).
//
// - Chrome, Edge, Android : le navigateur envoie « beforeinstallprompt » ; le bouton Installer
//   déclenche la fenêtre d'installation native (bandeau, guide et bouton du menu).
// - iPhone / iPad (Safari), Safari sur Mac : pas d'installation par programme, on affiche le guide.
// - Déjà installée (ouverte en mode application) : on n'affiche rien.
// - « Plus tard » reporte le rappel d'une semaine ; après 3 reports, il ne revient plus tout seul
//   (le bouton « Installer l'application » reste disponible dans le menu).

const KEY = "thychat:install";
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SNOOZES = 3;

// ios | android | firefox-desktop | mac-safari | desktop-chromium
export function detectPlatform(nav = navigator) {
  const ua = nav.userAgent || "";
  const iPadOnMac = nav.platform === "MacIntel" && nav.maxTouchPoints > 1; // iPadOS se présente comme un Mac
  if (/iPhone|iPad|iPod/.test(ua) || iPadOnMac) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Firefox\//.test(ua)) return "firefox-desktop";
  if (/Macintosh/.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\//.test(ua)) return "mac-safari";
  return "desktop-chromium";
}

export function isStandalone() {
  const matches = (query) => Boolean(window.matchMedia && window.matchMedia(query).matches);
  return (
    matches("(display-mode: standalone)") ||
    matches("(display-mode: fullscreen)") ||
    matches("(display-mode: minimal-ui)") ||
    navigator.standalone === true // Safari iOS
  );
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

function save(patch) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...load(), ...patch }));
  } catch {
    /* stockage indisponible : le rappel reviendra, sans conséquence */
  }
}

export function initInstall() {
  const $ = (selector) => document.querySelector(selector);
  const platform = detectPlatform();
  let deferred = null; // événement « beforeinstallprompt » mis de côté

  const installed = () => isStandalone() || load().installed === true;

  function bannerAllowed() {
    const state = load();
    return (
      !installed() &&
      platform !== "firefox-desktop" && // Firefox sur ordinateur ne sait pas installer : rien à proposer
      (state.count || 0) < MAX_SNOOZES &&
      Date.now() >= (state.snoozedUntil || 0)
    );
  }

  function refresh() {
    $("#open-install").hidden = installed();
    $("#install-banner").hidden = !bannerAllowed();
    $("#install-now").textContent = deferred ? "Installer" : "Voir comment";
    $("#install-prompt").hidden = !deferred;
  }

  function snooze() {
    save({ snoozedUntil: Date.now() + SNOOZE_MS, count: (load().count || 0) + 1 });
    refresh();
  }

  function openGuide() {
    for (const details of document.querySelectorAll("#install-how details[data-platform]")) {
      const here = details.dataset.platform === platform;
      details.open = here;
      details.style.order = here ? "-1" : "0"; // l'appareil de la personne passe en premier
      details.querySelector(".here").hidden = !here;
    }
    const dialog = $("#dialog-install");
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute("open", "");
    $("#install-title").focus();
  }

  function closeGuide() {
    const dialog = $("#dialog-install");
    if (dialog.close) dialog.close();
    else dialog.removeAttribute("open");
  }

  async function promptInstall() {
    if (!deferred) return openGuide();
    const event = deferred;
    deferred = null; // l'événement ne peut servir qu'une fois
    try {
      await event.prompt();
      const choice = await event.userChoice;
      if (choice && choice.outcome === "accepted") save({ installed: true });
      else snooze();
    } catch {
      /* fenêtre fermée ou refusée : on ne insiste pas */
    }
    closeGuide();
    refresh();
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); // on affiche notre propre invitation, au bon moment
    deferred = event;
    save({ installed: false }); // le navigateur propose l'installation : elle n'est donc pas faite
    refresh();
  });

  window.addEventListener("appinstalled", () => {
    deferred = null;
    save({ installed: true });
    closeGuide();
    refresh();
  });

  $("#install-now").addEventListener("click", promptInstall);
  $("#install-prompt").addEventListener("click", promptInstall);
  $("#install-later").addEventListener("click", snooze);
  // Le bouton du menu installe directement quand le navigateur le permet, sinon il ouvre le guide.
  $("#open-install").addEventListener("click", promptInstall);
  $("#dialog-install [data-close]").addEventListener("click", closeGuide);

  // Chrome / Edge : détecte une installation faite plus tôt quand on ouvre le site dans un onglet.
  if (navigator.getInstalledRelatedApps) {
    navigator
      .getInstalledRelatedApps()
      .then((apps) => {
        if (apps && apps.length && !deferred) {
          save({ installed: true });
          refresh();
        }
      })
      .catch(() => {});
  }

  refresh();
  return { platform, refresh, openGuide };
}
