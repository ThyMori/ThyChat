import { supabase, isConfigured } from "./supabase.js";
import { createChat } from "./chat.js";

const $ = (selector) => document.querySelector(selector);
const SCREENS = ["loading", "login", "set-password", "app"];

function show(name) {
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

// --- Démarrage ------------------------------------------------------------
async function main() {
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
      route(session);
    }, 0);
  });

  const { data } = await supabase.auth.getSession();
  // Le client a consommé le fragment d'URL : on le retire de la barre d'adresse.
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  await route(data.session);
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
  await supabase.auth.signOut();
});

main();
