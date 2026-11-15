import { supabase, isConfigured } from "./supabase.js";
import { createChat } from "./messagerie.js";
import { initInstall } from "./install.js";
import { VERSION } from "./version.js";
import { watchUpdates } from "./updates.js";

const $ = (selector) => document.querySelector(selector);

// Numéro de version, affiché en petit en bas de la connexion et de la barre latérale.
for (const node of document.querySelectorAll(".app-version")) node.textContent = `v${VERSION}`;

// iPhone, application installée : iOS donne parfois une marge de sécurité nulle au démarrage, et l'en-tête
// passe alors sous l'encoche / l'heure. On mesure la marge réelle et, si elle est nulle, on en impose une.
function fixSafeTop() {
  const standalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  const ios = /iPhone|iPad|iPod/.test(window.navigator.userAgent);
  const root = document.documentElement;
  if (!standalone || !ios) return;
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;padding-top:env(safe-area-inset-top, 0px)";
  document.body.append(probe);
  const real = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  const portrait = window.innerHeight > window.innerWidth;
  root.style.setProperty("--safe-top-min", real > 0 || !portrait ? "0px" : "54px");
}
fixSafeTop();
window.addEventListener("resize", fixSafeTop);
window.addEventListener("orientationchange", fixSafeTop);
document.addEventListener("visibilitychange", () => !document.hidden && fixSafeTop());

// Rappel et guide d'installation (écoute dès le départ : le navigateur n'envoie son invitation qu'une fois).
initInstall();
const SCREENS = ["loading", "login", "set-password", "app"];

function show(name) {
  if (name !== "loading") window.__booted = true;
  for (const screen of SCREENS) {
    $(`#screen-${screen}`).hidden = screen !== name;
  }
}

function setMessage(element, text, kind = "error") {
  element.textContent = text || "";
  element.dataset.kind = kind;
  element.hidden = !text;
}

function setBusy(button, busy, busyLabel) {
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyLabel;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
  button.disabled = busy;
}

// --- Service worker (PWA) -------------------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.warn("Service worker non enregistré :", err);
    });
  });
  // Nouvelle version prête : un bandeau propose de recharger (jamais de rechargement sans prévenir).
  watchUpdates({ onUpdate: () => ($("#update-bar").hidden = false) });
  $("#update-now").addEventListener("click", () => window.location.reload());
  $("#update-later").addEventListener("click", () => ($("#update-bar").hidden = true));
}

// --- Lecture du lien d'invitation / de réinitialisation -------------------
// Le fragment d'URL a été capturé dans index.html avant le chargement de Supabase.
const linkParams = new URLSearchParams((window.__initialHash || "").replace(/^#/, ""));
const linkType = linkParams.get("type"); // invite | recovery | ...
const linkErrorCode = linkParams.get("error_code");
const linkErrorText = linkParams.get("error_description");

let needsPassword = linkType === "invite" || linkType === "recovery";

function friendlyLinkError() {
  if (!linkErrorCode && !linkErrorText) return "";
  if (linkErrorCode === "otp_expired") {
    return "Ce lien a expiré ou a déjà été utilisé. Demande une nouvelle invitation, ou utilise « Mot de passe oublié ».";
  }
  return linkErrorText || "Le lien n'est pas valide.";
}

function friendlyAuthError(error) {
  const message = (error && error.message) || "";
  if (/invalid login credentials/i.test(message)) return "E-mail ou mot de passe incorrect.";
  if (/email not confirmed/i.test(message)) return "Ce compte n'est pas encore activé : utilise le lien reçu par e-mail.";
  if (/rate limit|too many/i.test(message)) return "Trop de tentatives. Réessaie dans quelques minutes.";
  if (/failed to fetch|network/i.test(message)) return "Connexion impossible. Vérifie ta connexion internet.";
  return message || "Une erreur est survenue.";
}

// Erreur au démarrage : on l'affiche avec un bouton de réinitialisation au lieu de rester bloqué.
function showStartupError(error) {
  console.error("Erreur de démarrage :", error);
  window.__lastError = (error && error.message) || String(error);
  show("loading");
  window.__showLoadingError();
}

// --- Routage selon l'état de session --------------------------------------
async function route(session) {
  if (!session) {
    stopChat();
    show("login");
    return;
  }
  if (needsPassword) {
    $("#name-field").hidden = linkType !== "invite";
    $("#set-password-title").textContent = linkType === "invite" ? "Bienvenue" : "Nouveau mot de passe";
    $("#set-password-subtitle").textContent =
      linkType === "invite"
        ? "Choisis ton mot de passe pour activer ton compte."
        : "Choisis un nouveau mot de passe.";
    show("set-password");
    return;
  }
  // Évite de tout recharger à chaque rafraîchissement de jeton ou retour d'onglet.
  if (chat && chat.userId === session.user.id && !$("#screen-app").hidden) return;

  show("app");
  await startChat(session);
}

// --- Messagerie -----------------------------------------------------------
let chat = null;

function startChat(session) {
  const user = session.user;
  if (!chat || chat.userId !== user.id) {
    stopChat();
    chat = createChat({ supabase, user });
  }
  return chat.start();
}

function stopChat() {
  if (chat) {
    chat.stop();
    chat = null;
  }
}

// Session gardée par Supabase dans le stockage local (utilisée seulement quand le réseau manque).
function storedSession() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!/^sb-.+-auth-token$/.test(key)) continue;
      const value = JSON.parse(localStorage.getItem(key));
      if (value && value.user && value.user.id) return value;
    }
  } catch {
    /* stockage indisponible */
  }
  return null;
}

// --- Démarrage ------------------------------------------------------------
async function main() {
  window.__step = "démarrage (main)";
  if (!isConfigured) {
    $("#config-warning").hidden = false;
    $("#login-submit").disabled = true;
    $("#forgot-password").disabled = true;
    show("login");
    return;
  }

  const initialError = friendlyLinkError();
  if (initialError) setMessage($("#login-message"), initialError);

  supabase.auth.onAuthStateChange((event, session) => {
    // Pas d'appel Supabase asynchrone directement dans ce callback : on sort du tick.
    setTimeout(() => {
      if (event === "PASSWORD_RECOVERY") needsPassword = true;
      if (event === "SIGNED_OUT") needsPassword = false;
      route(session).catch(showStartupError);
    }, 0);
  });

  window.__step = "lecture de la session (getSession)";
  const { data, error: sessionError } = await supabase.auth.getSession();
  window.__step = "session lue, routage";
  let session = data.session;
  // Sans réseau, le jeton expiré ne peut pas être renouvelé : on rouvre quand même la session gardée sur l'appareil.
  if (!session && (navigator.onLine === false || (sessionError && /fetch|network/i.test(sessionError.message || "")))) {
    session = storedSession();
  }
  // Le client a consommé le fragment d'URL : on le retire de la barre d'adresse.
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  await route(session);
}

// --- Connexion ------------------------------------------------------------
$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!isConfigured) return;

  const email = $("#email").value.trim();
  const password = $("#password").value;
  const message = $("#login-message");
  const button = $("#login-submit");

  if (!email || !password) {
    setMessage(message, "Renseigne ton e-mail et ton mot de passe.");
    return;
  }

  setMessage(message, "");
  setBusy(button, true, "Connexion…");
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  setBusy(button, false);

  if (error) setMessage(message, friendlyAuthError(error));
  // En cas de succès, onAuthStateChange déclenche le routage.
});

$("#forgot-password").addEventListener("click", async () => {
  if (!isConfigured) return;

  const email = $("#email").value.trim();
  const message = $("#login-message");

  if (!email) {
    setMessage(message, "Saisis d'abord ton e-mail dans le champ ci-dessus.");
    return;
  }

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: location.origin + location.pathname,
  });

  if (error) {
    setMessage(message, friendlyAuthError(error));
  } else {
    // Message volontairement identique que le compte existe ou non.
    setMessage(message, "Si un compte existe pour cet e-mail, un lien vient d'être envoyé.", "ok");
  }
});

// --- Demande d'inscription (personne sans compte) -------------------------
const accessDialog = $("#dialog-access");
$("#request-access-open").addEventListener("click", () => {
  setMessage($("#access-message"), "");
  $("#access-email").value = $("#email").value.trim();
  accessDialog.showModal();
  $("#access-name").focus();
});
$("#access-cancel").addEventListener("click", () => accessDialog.close());
accessDialog.addEventListener("click", (event) => {
  if (event.target === accessDialog) accessDialog.close(); // appui à l'extérieur de la fenêtre
});

$("#access-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("#access-message");
  const button = $("#access-submit");
  const name = $("#access-name").value.trim();
  const email = $("#access-email").value.trim();
  const production = $("#access-production").value.trim();

  if (!name || !email || !production) return setMessage(message, "Renseigne ton nom, ton e-mail et le spectacle ou la production.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setMessage(message, "Cette adresse e-mail n'a pas l'air valide.");
  if (!isConfigured) return setMessage(message, "Supabase n'est pas configuré.");

  setMessage(message, "");
  setBusy(button, true, "Envoi…");
  const { data, error } = await supabase.functions.invoke("request-access", {
    body: { name, email, production, website: $("#access-website").value },
  });
  setBusy(button, false);

  let detail = error ? "" : data && data.error;
  if (error) {
    try { detail = (await error.context.json()).error; } catch { /* réponse illisible */ }
  }
  if (error || (data && data.error)) {
    return setMessage(message, detail || "La demande n'a pas pu être envoyée. Vérifie ta connexion et réessaie.");
  }
  $("#access-form").reset();
  accessDialog.close();
  setMessage($("#login-message"), data && data.mail_sent === false
    ? "Ta demande est enregistrée. Elle sera traitée dans les meilleurs délais ; sans nouvelles, demande une invitation directement à ton équipe."
    : "Ta demande est transmise. Si elle est acceptée, tu recevras un e-mail de Supabase avec ton lien d'activation (regarde aussi dans tes courriers indésirables).", "ok");
});

// --- Définition du mot de passe (invitation / réinitialisation) -----------
$("#set-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = $("#new-name").value.trim();
  const password = $("#new-password").value;
  const confirm = $("#confirm-password").value;
  const message = $("#set-password-message");
  const button = $("#set-password-submit");

  if (password.length < 10) {
    setMessage(message, "Le mot de passe doit faire au moins 10 caractères.");
    return;
  }
  if (password !== confirm) {
    setMessage(message, "Les deux mots de passe ne correspondent pas.");
    return;
  }

  setMessage(message, "");
  setBusy(button, true, "Enregistrement…");

  const attributes = { password };
  if (name) attributes.data = { display_name: name };
  const { data, error } = await supabase.auth.updateUser(attributes);

  if (error) {
    setBusy(button, false);
    setMessage(message, friendlyAuthError(error));
    return;
  }

  if (name && data?.user) {
    const { error: profileError } = await supabase
      .from("profiles")
      .update({ display_name: name })
      .eq("id", data.user.id);
    if (profileError) console.warn("Profil non mis à jour :", profileError.message);
  }

  setBusy(button, false);
  needsPassword = false;
  $("#new-password").value = "";
  $("#confirm-password").value = "";
  const { data: sessionData } = await supabase.auth.getSession();
  await route(sessionData.session);
});

// --- Déconnexion ----------------------------------------------------------
$("#logout").addEventListener("click", async () => {
  const waiting = chat ? chat.pendingCount() : 0;
  if (waiting && !window.confirm(`${waiting} message${waiting > 1 ? "s" : ""} ne ${waiting > 1 ? "sont" : "est"} pas encore envoyé${waiting > 1 ? "s" : ""} : se déconnecter ${waiting > 1 ? "les" : "le"} supprimera. Continuer ?`)) return;
  // Les messages gardés sur l'appareil sont effacés à la déconnexion.
  if (chat) await chat.wipeOffline();
  await supabase.auth.signOut();
});

main().catch(showStartupError);
