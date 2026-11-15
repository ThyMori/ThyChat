// Interface de messagerie : espaces (une couleur chacun), salons, messages privés, messages en temps réel,
// non lus, silences, membres et invitations, profil.
// Le client Supabase est injecté (aucun import réseau ici) pour pouvoir tester hors navigateur.
// Tout le texte venant des utilisateurs est inséré via textContent : jamais d'innerHTML.

import { PALETTE, DEFAULT_THEME, themeFor, themeByKey, pickUnusedTheme, authorHue } from "./themes.js";
import { MUTE_CHOICES, muteFromChoice, muteKey, isMuted, channelMuted, choiceOf, muteLabel, badgeTotal, countLabel } from "./notify.js";
import { MAX_PDF_BYTES, cleanUrl, fileType, sizeLabel, uploadRoomSheet, uploadTagDocument, removeTagDocuments, signDocuments } from "./documents.js";
import { MAX_IMAGES, resizedJpeg, uploadMessageImage, removeMessageImages, removeChannelImages, signPaths, moveMessageImages, moveBack, copyMessageImages } from "./images.js";
import { createStore, withReadCache, isNetworkError } from "./offline.js";
import { pushStatus, enablePush, disablePush, syncPush, setBadge } from "./push.js";
import {
  safeAvatarUrl,
  uploadAvatar,
  removeAvatar,
  uploadWorkspaceAvatar,
  removeWorkspaceAvatar,
  saveName,
  changeEmail,
} from "./profile.js";

const LAST_KEY = "thychat:last";
const OPEN_KEY = "thychat:open";
const DM_OPEN_KEY = "thychat:dm-open";
const readDmOpen = () => {
  try {
    return localStorage.getItem(DM_OPEN_KEY) === "1"; // repliés par défaut
  } catch {
    return false;
  }
};
const PAGE_SIZE = 100;
const GROUP_WINDOW_MS = 5 * 60 * 1000;
const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
const THEME_SQL_HINT =
  "Pour enregistrer les couleurs, exécute supabase/migrations/002_workspace_theme.sql dans l'éditeur SQL de Supabase.";

const $ = (selector) => document.querySelector(selector);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function readLast() {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY)) || {};
  } catch {
    return {};
  }
}

function readOpen() {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPEN_KEY)) || []);
  } catch {
    return new Set();
  }
}

function writeOpen(set) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...set]));
  } catch {
    /* stockage indisponible : sans conséquence */
  }
}

function writeLast(patch) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ ...readLast(), ...patch }));
  } catch {
    /* stockage indisponible : sans conséquence */
  }
}

const timeFmt = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

function dayLabel(date) {
  const diff = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  if (diff === 0) return "Aujourd'hui";
  if (diff === 1) return "Hier";
  return dayFmt.format(date);
}

// Initiales pour les pastilles rondes (1 lettre pour un salon, jusqu'à 2 pour un espace).
function initials(name, max = 1) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return words.slice(0, max).map((word) => Array.from(word)[0]).join("");
}

// Mise en forme à la WhatsApp : *gras*, _italique_, ~barré~ (le marqueur colle au texte et n'est pas au milieu d'un mot).
const FORMAT_RE = /(^|[^\p{L}\p{N}])([*_~])(?!\2)(?=\S)((?:(?!\2)[^\n])*?(?!\2)\S)\2(?![\p{L}\p{N}])/u;
const FORMAT_TAGS = { "*": "strong", _: "em", "~": "s" };

function renderInline(container, text) {
  let rest = text;
  while (rest) {
    const match = FORMAT_RE.exec(rest);
    if (!match) break;
    const before = rest.slice(0, match.index) + match[1];
    if (before) container.append(document.createTextNode(before));
    const node = document.createElement(FORMAT_TAGS[match[2]]);
    renderInline(node, match[3]);
    container.append(node);
    rest = rest.slice(match.index + match[0].length);
  }
  if (rest) container.append(document.createTextNode(rest));
}

// Insère du texte brut en transformant les adresses http(s) en liens sûrs.
function renderBody(container, text) {
  text.split(URL_RE).forEach((part, index) => {
    if (index % 2 === 0) {
      if (part) renderInline(container, part);
      return;
    }
    const [, url, tail] = part.match(/^(.*?)([.,;:!?)\]]*)$/);
    const link = el("a", "", url);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    container.append(link);
    if (tail) container.append(document.createTextNode(tail));
  });
}

// Citation : les lignes de tête commençant par « > » s'affichent comme une citation.
function renderMessageBody(container, text, tags = []) {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].startsWith("> ")) {
    container.append(el("span", "quote-line", lines[i].slice(2)));
    i += 1;
  }
  const rest = lines.slice(i).join("\n").replace(/^\n+/, "");
  if (!rest) return;
  if (!tags.length) return renderBody(container, rest);
  // Les « #Date » choisies avec # s'affichent en pastille dans le texte.
  const byLabel = new Map(tags.map((tag) => [tag.label, tag]));
  const labels = [...byLabel.keys()].sort((a, b) => b.length - a.length).map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = rest.split(new RegExp(`#(${labels.join("|")})`));
  parts.forEach((part, index) => {
    if (index % 2 === 0) {
      if (part) renderBody(container, part);
      return;
    }
    const tag = byLabel.get(part);
    const pill = el("span", "hash-pill", "#" + part);
    pill.dataset.tag = tag.id;
    pill.style.setProperty("--h", String(tag.hue));
    container.append(pill);
  });
}

const plain = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const excerpt = (text, max = 90) => {
  const flat = String(text || "").replace(/^(> .*\n?)+/, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};
// Petites icônes sobres (traits) des actions d'un message ; contenu fixe, jamais de texte venant des utilisateurs.
const ACTION_ICONS = {
  reply: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v3"/>',
  quote: '<path d="M10 7C6 8 4 10 4 14v3h6v-6H7c0-2 1-3 3-4z"/><path d="M20 7c-4 1-6 3-6 7v3h6v-6h-3c0-2 1-3 3-4z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  forward: '<path d="m15 5 5 5-5 5"/><path d="M20 10H9a5 5 0 0 0-5 5v4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  strike: '<path d="M5 12h14"/><path d="M16 7.5C15 6 13.7 5.5 12 5.5c-2.2 0-4 1-4 3 0 4 8 2.5 8 7 0 2-1.8 3.5-4 3.5-1.9 0-3.4-.7-4.4-2"/>',
  unstrike: '<path d="M9 14 4 9l5-5"/><path d="M4 9h9a6 6 0 0 1 0 12h-3"/>',
  move: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 13h6m-2-2 2 2-2 2"/>',
  pin: '<path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 15v5"/>',
  unpin: '<path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 15v5M4 4l16 16"/>',
  delete: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
};
function actionIcon(name) {
  const holder = document.createElement("span");
  holder.className = "act-ic";
  holder.innerHTML = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ACTION_ICONS[name] || ""}</svg>`;
  return holder;
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (Math.random() * 16) >> (c / 4)).toString(16)));
const MESSAGE_COLS = "id, channel_id, user_id, parent_id, reply_to, tag_ids, struck_at, body, attachments, pinned, created_at, edited_at";
const PHOTO_LABEL = "📷 Photo";
const messageExcerpt = (message, max = 90) =>
  excerpt(message && message.body, max) || (message && message.attachments && message.attachments.length ? PHOTO_LABEL : "");
const shortDate = (iso) => (iso ? new Date(iso + "T00:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : "");

const pad2 = (n) => String(n).padStart(2, "0");
const toISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromISO = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d, n) => {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
};
const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
const weekdayShort = (d) => d.toLocaleDateString("fr-FR", { weekday: "short" });
const monthLabel = (d) => {
  const text = d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  return text.charAt(0).toUpperCase() + text.slice(1);
};

// « 12 mars 2027 », « 12–14 mars 2027 » ou « 28 févr. → 2 mars 2027 »
function rangeText(tag) {
  if (!tag.start_date) return "";
  const a = fromISO(tag.start_date);
  const b = fromISO(tag.end_date || tag.start_date);
  if (toISO(a) === toISO(b)) return shortDate(tag.start_date);
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) {
    return `${a.getDate()}–${b.getDate()} ${b.toLocaleDateString("fr-FR", { month: "short", year: "numeric" })}`;
  }
  return `${shortDate(tag.start_date)} → ${shortDate(tag.end_date)}`;
}

// Attribue une ligne (frise) à chaque date de tournée : deux plages qui se chevauchent ne partagent pas de ligne.
function assignLanes(tags) {
  const lanes = new Map();
  const ends = [];
  const dated = tags.filter((t) => t.start_date).sort((a, b) => a.start_date.localeCompare(b.start_date) || b.end_date.localeCompare(a.end_date));
  for (const tag of dated) {
    let lane = ends.findIndex((end) => end < tag.start_date);
    if (lane === -1) lane = ends.length;
    ends[lane] = tag.end_date;
    lanes.set(tag.id, lane);
  }
  return lanes;
}

// Bouton « Retour » du téléphone : sur mobile, on garde une entrée d'historique devant soi pour que « Retour »
// ferme la boîte de dialogue ou revienne à la liste des salons, au lieu de quitter l'application.
const isMobile = () => Boolean(window.matchMedia && window.matchMedia("(max-width: 760px)").matches);

// Chrome ignore (au bouton « Retour ») les entrées d'historique ajoutées sans geste de l'utilisateur : la protection
// posée au démarrage pouvait être sautée et « Retour » quittait l'application (écran noir). On note donc si l'entrée
// a été posée pendant un geste, et on en repose une dès qu'un geste le permet.
function guardHistory() {
  try {
    if (!isMobile()) return;
    const active = !navigator.userActivation || navigator.userActivation.isActive;
    const current = history.state;
    if (!(current && current.tcGuard) || (!current.act && active)) history.pushState({ tcGuard: true, act: active }, "");
  } catch {
    /* historique indisponible : sans conséquence */
  }
}

function openDialog(selector) {
  guardHistory();
  const dialog = $(selector);
  if (dialog.showModal) dialog.showModal();
  else dialog.setAttribute("open", "");
  return dialog;
}

function closeDialog(dialog) {
  if (dialog.close) dialog.close();
  else dialog.removeAttribute("open");
}

function setNotice(selector, text, kind = "error") {
  const node = $(selector);
  node.textContent = text || "";
  node.dataset.kind = kind;
  node.hidden = !text;
}

// Pastilles de couleur cliquables (création d'espace, réglages).
function renderSwatches(container, selectedKey, onPick) {
  container.replaceChildren();
  for (const theme of PALETTE) {
    const button = el("button", "swatch");
    button.type = "button";
    button.title = theme.label;
    button.setAttribute("aria-label", theme.label);
    button.setAttribute("aria-pressed", String(theme.key === selectedKey));
    button.dataset.key = theme.key;
    button.style.setProperty("--sw", String(theme.hue));
    button.addEventListener("click", () => onPick(theme.key));
    container.append(button);
  }
}

export function createChat({ supabase: rawSupabase, user, store = createStore() }) {
  // Lectures gardées sur l'appareil : sans réseau, on retrouve les derniers messages vus.
  const supabase = withReadCache(rawSupabase, {
    userId: user.id,
    store,
    onServed: () => setOffline(true),
    onLive: () => {
      if (navigator.onLine !== false) setOffline(false);
    },
  });
  const fallbackName = user.user_metadata?.display_name || user.email || "Moi";
  const state = {
    dmOpen: readDmOpen(), // messages privés dépliés dans le menu ?
    outbox: [], // messages écrits sans réseau, en attente d'envoi : { id, channel_id, body, reply_to, tag_ids, images, attachments, created_at, status, error }
    workspaces: [], // { id, name, role, theme }
    ws: null,
    allRooms: [], // salons (spectacles) visibles : { id, workspace_id, name, description, everyone }
    openRooms: readOpen(), // salons dépliés dans la barre latérale
    allChannels: [], // tous les sous-salons et messages privés visibles : { id, workspace_id, room_id, name, description, kind, everyone }
    dmMembers: new Map(), // id du message privé -> [ids des deux personnes]
    dmActivity: new Map(), // id du message privé -> date du dernier message
    sheets: [], // fiches techniques des spectacles : { id, room_id, name, path, version_date, size_bytes }
    tagDocs: [], // documents PDF des dates : { id, tag_id, name, path, size_bytes }
    focus: null, // message à montrer à l'ouverture d'un sous-salon (résultat de recherche) : { id, at }
    channel: null,
    messages: [],
    tags: [], // dates de tournée visibles : { id, room_id, label, start_date, end_date, shows }
    calendarOpen: false,
    calMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    calScope: "ws", // « ws » (cet espace), « all » (tous mes espaces) ou l'id d'un spectacle
    calDay: null, // jour touché dans le calendrier (AAAA-MM-JJ)
    pendingFilter: null, // date à filtrer à l'ouverture d'un spectacle depuis le calendrier
    tagFilter: new Set(), // dates sélectionnées pour filtrer le sous-salon ouvert
    pendingImages: [], // photos en attente d'envoi : { id, blob, width, height, url }
    imageUrls: new Map(), // chemin -> lien temporaire d'une photo
    composerTags: new Set(), // dates ajoutées au message en cours d'écriture
    editing: null, // { id, head } : message de moi en cours de modification
    postits: [], // Post-it du fil ouvert
    pins: [], // messages épinglés du fil ouvert : { message_id, pinned_by, pinned_at, expires_at }, du plus récent au plus ancien
    pinMsgs: new Map(), // contenu des messages épinglés : id → { id, user_id, body, attachments, created_at }
    pinIndex: 0, // épingle montrée dans le bandeau
    pinTarget: null, // message en cours d'épinglage (choix de la durée)
    postitStates: new Map(), // id -> « discarded » | « purged » (mon état)
    postitsReady: true, // false tant que la migration 020 n'est pas passée
    replyTo: null, // message auquel on répond
    quoted: new Map(), // id -> { user_id, body } des messages cités qui ne sont pas dans la liste
    selectedId: null, // message touché (affiche « Supprimer »)
    multi: new Set(), // messages cochés (appui long) pour agir par lot
    profiles: new Map(), // id -> { name, avatar }
    unread: new Map(), // id du salon -> nombre de messages non lus
    mutes: new Map(), // « scope:id » -> ligne de notification_mutes
    isSuper: false,
    realtime: null,
    loadToken: 0,
    themeColumn: true, // false tant que la migration SQL des couleurs n'est pas passée
    avatarColumn: true, // false tant que la migration 007 (photos d'espace) n'est pas passée
    pendingDeepLink: null, // { w, c } venant d'une notification
    pushStatus: "unsupported",
  };
  let controller = null; // détache tous les écouteurs à l'arrêt
  let stopped = false;
  let emptyAction = null;
  let toastTimer = null;
  let structureTimer = null;
  let expiryTimer = null;
  let pendingTheme = DEFAULT_THEME.key;
  let editingChannel = null; // sous-salon en cours de modification (null = création)
  let channelRoomId = null; // salon (spectacle) du sous-salon en cours de création
  let editingRoom = null; // salon (spectacle) en cours de modification (null = création)

  // --- Petits utilitaires d'interface ------------------------------------

  function toast(text, kind = "error") {
    const node = $("#toast");
    node.textContent = text;
    node.dataset.kind = kind;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.hidden = true;
    }, 6000);
  }

  function setView(mode, empty = {}) {
    const isChat = mode === "chat";
    const isCalendar = mode === "calendar";
    $("#messages").hidden = !isChat;
    $("#composer").hidden = !isChat;
    $("#calendar").hidden = !isCalendar;
    $("#empty-state").hidden = isChat || isCalendar;
    if (!isChat) {
      $("#empty-title").textContent = empty.title || "";
      $("#empty-text").textContent = empty.text || "";
      const action = $("#empty-action");
      action.hidden = !empty.action;
      action.textContent = empty.action || "";
      emptyAction = empty.onAction || null;
    }
  }

  // Geste horizontal net (> 60 px, plus horizontal que vertical) : appelle fn(-1) vers la gauche, fn(1) vers la droite.
  function onSwipe(node, fn, opts) {
    if (!node) return;
    let start = null;
    node.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      start = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY, target: e.target } : null;
    }, { ...opts, passive: true });
    node.addEventListener("touchend", (e) => {
      const t = e.changedTouches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      const origin = start.target;
      start = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) fn(dx < 0 ? -1 : 1, origin);
    }, opts);
  }

  let exitArmedAt = 0;

  function closeSidebar() {
    $("#screen-app").classList.remove("sidebar-open");
  }

  const visible = () => document.visibilityState !== "hidden";

  function authorName(userId) {
    return state.profiles.get(userId)?.name || "Membre";
  }

  function isAdmin() {
    return state.ws?.role === "admin";
  }

  // Pastille ronde : photo de la personne si elle en a une, sinon son initiale.
  function avatarFor(userId, extra = "soft") {
    const node = el("span", `avatar ${extra}`);
    node.setAttribute("aria-hidden", "true");
    const url = safeAvatarUrl(state.profiles.get(userId)?.avatar);
    if (url) {
      const img = el("img");
      img.src = url;
      img.alt = "";
      img.loading = "lazy";
      node.classList.add("has-photo");
      node.append(img);
    } else {
      node.textContent = initials(authorName(userId), 1);
    }
    return node;
  }

  // Pastille d'un espace : sa photo si elle en a une, sinon ses initiales.
  function fillWsAvatar(node, ws) {
    node.replaceChildren();
    node.classList.remove("has-photo");
    const url = ws ? safeAvatarUrl(ws.avatar) : "";
    if (url) {
      const img = el("img");
      img.src = url;
      img.alt = "";
      node.classList.add("has-photo");
      node.append(img);
    } else {
      node.textContent = ws ? initials(ws.name, 2) : "?";
    }
  }

  async function ensureProfiles(ids) {
    const missing = [...new Set(ids)].filter((id) => id && !state.profiles.has(id));
    if (!missing.length) return;
    const { data, error } = await supabase.from("profiles").select("id, display_name, avatar_url").in("id", missing);
    if (error) {
      console.warn("Profils illisibles :", error.message);
      return;
    }
    for (const profile of data || []) {
      state.profiles.set(profile.id, { name: profile.display_name || "Membre", avatar: profile.avatar_url || "" });
    }
  }

  // --- Salons, messages privés, silences ------------------------------------

  const byName = (a, b) => a.name.localeCompare(b.name, "fr");
  // Ouvert à tous d'abord (« Tous »), puis les accès restreints, chacun par ordre alphabétique.
  const bySalon = (a, b) => Number(b.everyone) - Number(a.everyone) || byName(a, b);
  const channelsOfWs = (wsId) => state.allChannels.filter((c) => c.workspace_id === wsId);
  const roomsOfWs = (wsId) => state.allRooms.filter((r) => r.workspace_id === wsId).sort(bySalon);
  // Le salon « Général » d'un spectacle (créé avec lui) en est la racine : le plus ancien sous-salon ouvert à tous.
  // Il n'apparaît pas dans la liste : c'est la ligne du spectacle qui l'ouvre.
  function rootOf(roomId) {
    const all = state.allChannels.filter((c) => c.kind === "channel" && c.room_id === roomId);
    const pick = (list) => list.slice().sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")) || a.name.localeCompare(b.name, "fr"))[0] || null;
    return pick(all.filter((c) => c.everyone)) || pick(all);
  }
  const ROOT_GLYPH = "⌂"; // le salon racine d'un spectacle (« Général ») porte une maison plutôt qu'un G
  const isRoot = (channel) => Boolean(channel && channel.kind === "channel" && rootOf(channel.room_id)?.id === channel.id);
  const subsOfRoom = (roomId) => state.allChannels.filter((c) => c.kind === "channel" && c.room_id === roomId).sort(bySalon);
  const roomById = (id) => state.allRooms.find((r) => r.id === id) || null;
  // Tous les sous-salons de l'espace courant, salon par salon.
  const salons = () => (state.ws ? roomsOfWs(state.ws.id).flatMap((room) => subsOfRoom(room.id)) : []);
  const dmPartner = (channel) => (state.dmMembers.get(channel.id) || []).find((id) => id !== user.id) || null;
  // Les messages privés ne dépendent d'aucun espace : ils apparaissent dans tous.
  const dms = () =>
    state.allChannels
      .filter((c) => c.kind === "dm")
      .sort((a, b) => dmLast(b).localeCompare(dmLast(a)) || channelTitle(a).localeCompare(channelTitle(b), "fr"));
  const dmLast = (channel) => state.dmActivity.get(channel.id) || channel.created_at || "";

  function channelTitle(channel) {
    if (channel.kind !== "dm") return channel.name;
    const partner = dmPartner(channel);
    return partner ? authorName(partner) : "Message privé";
  }

  const wsMute = (wsId) => state.mutes.get(muteKey("workspace", wsId));
  const channelMute = (id) => state.mutes.get(muteKey("channel", id));
  const muted = (channel) => channelMuted(state.mutes, channel);

  // Non lus d'un espace : { count (hors silences), all (tout), muted }.
  function wsUnread(wsId) {
    let count = 0;
    let all = 0;
    for (const channel of channelsOfWs(wsId)) {
      if (channel.kind === "dm") continue; // comptés à part : visibles dans tous les espaces
      const n = state.unread.get(channel.id) || 0;
      all += n;
      if (!muted(channel)) count += n;
    }
    return { count, all, muted: isMuted(state.mutes, "workspace", wsId) };
  }

  function roomUnread(room) {
    let count = 0;
    let all = 0;
    for (const channel of subsOfRoom(room.id)) {
      const n = state.unread.get(channel.id) || 0;
      all += n;
      if (!muted(channel)) count += n;
    }
    return { count, all, muted: isMuted(state.mutes, "room", room.id) || isMuted(state.mutes, "workspace", room.workspace_id) };
  }

  // Ligne de silence qui s'applique à un sous-salon : le sien, sinon celui du salon, sinon celui de l'espace.
  function mutedRowFor(channel) {
    if (isMuted(state.mutes, "channel", channel.id)) return channelMute(channel.id);
    if (channel.room_id && isMuted(state.mutes, "room", channel.room_id)) return state.mutes.get(muteKey("room", channel.room_id));
    if (channel.kind !== "dm" && isMuted(state.mutes, "workspace", channel.workspace_id)) return wsMute(channel.workspace_id);
    return null;
  }

  function totalBadge() {
    return badgeTotal(state.unread, state.allChannels, state.mutes);
  }

  async function loadStructure() {
    const roomsResult = await supabase.from("rooms").select("id, workspace_id, name, description, everyone").order("name");
    if (stopped) return false;
    if (roomsResult.error) {
      showFatal(roomsResult.error);
      return false;
    }
    state.allRooms = roomsResult.data || [];

    const channelsResult = await supabase
      .from("channels")
      .select("id, workspace_id, room_id, name, description, kind, everyone, created_at")
      .order("name");
    if (stopped) return false;
    if (channelsResult.error) {
      showFatal(channelsResult.error);
      return false;
    }
    state.allChannels = channelsResult.data || [];

    const tagsResult = await supabase.from("tour_tags").select("id, room_id, label, start_date, end_date, shows");
    if (stopped) return false;
    if (tagsResult.error) {
      showFatal(tagsResult.error);
      return false;
    }
    state.tags = tagsResult.data || [];
    // Documents des dates (migration 012 : sans elle, simplement aucun document).
    // Migration 017 : liens web et images ; sans elle, on relit les anciennes colonnes (PDF seulement).
    let docsResult = await supabase.from("tag_documents").select("id, tag_id, name, path, size_bytes, created_at, kind, url").order("created_at");
    if (docsResult.error) docsResult = await supabase.from("tag_documents").select("id, tag_id, name, path, size_bytes, created_at").order("created_at");
    state.tagDocs = docsResult.error ? [] : docsResult.data || [];
    // Fiches techniques (migration 013 : sans elle, simplement aucune fiche).
    let sheetsResult = await supabase.from("room_sheets").select("id, room_id, name, path, version_date, size_bytes, created_at, kind, url");
    if (sheetsResult.error) sheetsResult = await supabase.from("room_sheets").select("id, room_id, name, path, version_date, size_bytes, created_at");
    state.sheets = sheetsResult.error ? [] : sheetsResult.data || [];

    const dmIds = state.allChannels.filter((c) => c.kind === "dm").map((c) => c.id);
    state.dmMembers = new Map();
    if (dmIds.length) {
      const { data } = await supabase.from("channel_members").select("channel_id, user_id").in("channel_id", dmIds);
      for (const row of data || []) {
        const list = state.dmMembers.get(row.channel_id) || [];
        list.push(row.user_id);
        state.dmMembers.set(row.channel_id, list);
      }
      await ensureProfiles([...state.dmMembers.values()].flat());
      // Dernier message de chaque fil : le plus récent est classé en haut.
      const last = await supabase
        .from("messages")
        .select("channel_id, created_at")
        .in("channel_id", dmIds)
        .is("parent_id", null)
        .order("created_at", { ascending: false })
        .limit(1000);
      state.dmActivity = new Map();
      for (const row of last.data || []) if (!state.dmActivity.has(row.channel_id)) state.dmActivity.set(row.channel_id, row.created_at);
    }

    const mutes = await supabase.from("notification_mutes").select("scope, target_id, muted_until, forever");
    state.mutes = new Map();
    for (const row of mutes.data || []) state.mutes.set(muteKey(row.scope, row.target_id), row);

    await loadUnread();
    return !stopped;
  }

  async function loadUnread() {
    const { data, error } = await supabase.rpc("my_unread_counts");
    if (stopped) return;
    if (error) {
      console.warn("Non lus indisponibles :", error.message);
      return;
    }
    state.unread = new Map();
    for (const row of data || []) {
      if (state.channel && row.channel_id === state.channel.id && visible()) continue; // salon ouvert : déjà lu
      state.unread.set(row.channel_id, Number(row.unread));
    }
  }

  // Recharge salons, accès, silences et non lus (retour au premier plan, nouveau salon, accès modifié…).
  async function refreshStructure() {
    const ok = await loadStructure();
    if (!ok || stopped) return;
    if (state.channel && !state.allChannels.some((c) => c.id === state.channel.id)) {
      // Le salon ouvert n'est plus accessible.
      await selectChannel(pickChannel(null));
      return;
    }
    if (state.channel) state.channel = state.allChannels.find((c) => c.id === state.channel.id);
    renderAll();
  }

  function refreshStructureSoon() {
    clearTimeout(structureTimer);
    structureTimer = setTimeout(() => {
      if (!stopped) refreshStructure();
    }, 400);
  }

  function pickChannel(wanted) {
    const list = [...salons(), ...dms()];
    return (list.find((c) => c.id === wanted) || list[0] || { id: null }).id;
  }

  async function markRead(id) {
    if (!id) return;
    if (state.unread.delete(id)) renderBadges();
    const { error } = await supabase.rpc("mark_channel_read", { ch: id });
    if (error) console.warn("Lecture non enregistrée :", error.message);
  }

  // --- Thème de l'espace ---------------------------------------------------

  // Teinte toute l'interface avec la couleur de l'espace courant.
  function applyTheme() {
    const theme = state.ws ? themeFor(state.ws) : DEFAULT_THEME;
    $("#screen-app").style.setProperty("--h", String(theme.hue));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", `hsl(${theme.hue} 14% 11.5%)`);
    updateTitle();
  }

  function updateTitle() {
    const total = totalBadge();
    const base = state.ws ? `${state.ws.name} · ThyChat` : "ThyChat";
    document.title = total > 0 ? `(${total}) ${base}` : base;
  }

  function resetTheme() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", "#0e0e11");
    document.title = "ThyChat";
    setBadge(0);
  }

  // --- Rendu ---------------------------------------------------------------

  // Petites icônes au trait (sobres, de la couleur du texte).
  const ICON_PATHS = {
    file: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5", "M9 13h6M9 17h6"],
    link: ["M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7", "M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"],
    x: ["M18 6 6 18", "m6 6 12 12"],
    "bell-off": ["M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5", "M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7", "M10.3 21a1.94 1.94 0 0 0 3.4 0", "m2 2 20 20"],
  };
  function icon(name) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "ic");
    svg.setAttribute("aria-hidden", "true");
    for (const d of ICON_PATHS[name]) {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }

  function flag(text, className, title) {
    const node = el("span", className);
    if (text === "bell-off") node.append(icon("bell-off"));
    else node.textContent = text;
    if (title) node.title = title;
    return node;
  }

  function renderWorkspaceHeader() {
    const ws = state.ws;
    fillWsAvatar($("#ws-avatar"), ws);
    $("#ws-name").textContent = ws ? ws.name : "Espaces";
    $("#ws-sub").textContent = ws ? (ws.role === "admin" ? "Administrateur" : "Utilisateur") : "";
    $("#open-members").hidden = !ws;
    $("#new-channel").hidden = !ws || !isAdmin();
    $("#dm-title").hidden = !ws;
    $("#switch-new").hidden = !state.isSuper;
    renderSwitchList();
    renderBadges();
    applyTheme();
  }

  function roleLabel(role) {
    return role === "admin" ? "Administrateur" : "Utilisateur";
  }

  function renderSwitchList() {
    const list = $("#ws-list");
    list.replaceChildren();
    for (const ws of state.workspaces) {
      const item = el("li");
      const row = el("button", "ws-row");
      row.type = "button";
      row.dataset.id = ws.id;
      row.style.setProperty("--h", String(themeFor(ws).hue)); // chaque ligne garde la couleur de son espace
      if (state.ws && state.ws.id === ws.id) row.setAttribute("aria-current", "true");
      const info = wsUnread(ws.id);
      if (info.muted) row.classList.add("is-muted");
      const wsAvatar = el("span", "avatar");
      fillWsAvatar(wsAvatar, ws);
      row.append(wsAvatar);
      const text = el("span", "ws-text");
      text.append(el("strong", "", ws.name), el("small", "", roleLabel(ws.role)));
      row.append(text);
      const side = el("span", "ws-flags");
      if (info.muted) side.append(flag("bell-off", "mute-ic", muteLabel(wsMute(ws.id)) || "Espace en silence"));
      const n = info.muted ? info.all : info.count;
      if (n > 0) side.append(flag(countLabel(n), info.muted ? "unread muted" : "unread"));
      row.append(side);
      item.append(row);
      list.append(item);
    }
  }

  function channelItem(channel) {
    const item = el("button", "channel-item");
    item.type = "button";
    item.dataset.id = channel.id;
    if (channel.kind === "channel") item.classList.add("sub");
    if (state.channel && state.channel.id === channel.id) item.setAttribute("aria-current", "true");
    const isMuted = muted(channel);
    if (isMuted) item.classList.add("is-muted");

    if (channel.kind === "dm") {
      const partner = dmPartner(channel);
      item.classList.add("dm");
      item.append(partner ? avatarFor(partner, "tiny soft") : el("span", "avatar tiny soft", "?"));
    } else {
      item.append(el("span", "avatar tiny soft", isRoot(channel) ? ROOT_GLYPH : initials(channel.name, 1)));
    }

    const text = el("span", "channel-text");
    text.append(el("span", "channel-name", channelTitle(channel)));
    if (channel.kind === "channel" && channel.description) text.append(el("span", "channel-sub", channel.description));
    item.append(text);

    const side = el("span", "channel-side");
    if (channel.kind === "channel" && !channel.everyone) side.append(flag("🔒", "lock-ic", "Accès restreint"));
    if (isMuted) {
      const label = muteLabel(mutedRowFor(channel)) || "Silence";
      side.append(flag("bell-off", "mute-ic", label));
    }
    const n = state.unread.get(channel.id) || 0;
    if (n > 0) side.append(flag(countLabel(n), isMuted ? "unread muted" : "unread"));
    item.append(side);
    return item;
  }

  const roomOpen = (room) => state.openRooms.has(room.id);

  // Un salon (spectacle) : une ligne qui se déplie sur ses sous-salons.
  function roomGroup(room) {
    const group = el("div", "room-group");
    const open = roomOpen(room);
    const info = roomUnread(room);
    if (info.muted) group.classList.add("is-muted");

    const head = el("div", "room-head");
    const root = rootOf(room.id);
    const chev = el("button", "room-chev");
    chev.type = "button";
    chev.dataset.room = room.id;
    chev.setAttribute("aria-expanded", String(open));
    chev.setAttribute("aria-label", (open ? "Replier " : "Déplier ") + room.name);
    chev.append(el("span", "chev", open ? "▾" : "▸"));
    head.append(chev);

    // Le corps de la ligne ouvre le salon « Général » (la racine) ; sans racine accessible, il déplie.
    const toggle = el("button", root ? "channel-item room-root" : "room-toggle");
    toggle.type = "button";
    if (root) {
      if (info.muted || muted(root)) toggle.classList.add("is-muted");
      toggle.dataset.id = root.id;
      if (state.channel && state.channel.id === root.id) toggle.setAttribute("aria-current", "true");
    } else {
      toggle.dataset.room = room.id;
    }
    toggle.append(el("span", "avatar small soft", initials(room.name, 1)));
    const text = el("span", "channel-text");
    text.append(el("span", "channel-name", room.name));
    if (room.description) text.append(el("span", "channel-sub", room.description));
    toggle.append(text);
    const side = el("span", "channel-side");
    if (!room.everyone) side.append(flag("🔒", "lock-ic", "Accès restreint"));
    if (info.muted) side.append(flag("bell-off", "mute-ic", muteLabel(state.mutes.get(muteKey("room", room.id))) || "Spectacle en silence"));
    // Replié : tous les non lus du spectacle ; déplié : seulement ceux du « Général » (les autres sont dans leurs lignes).
    const own = root ? state.unread.get(root.id) || 0 : 0;
    const n = open ? own : info.muted ? info.all : info.count;
    if (n > 0) side.append(flag(countLabel(n), info.muted ? "unread muted" : "unread"));
    toggle.append(side);
    head.append(toggle);

    if (isAdmin()) {
      const edit = el("button", "icon-btn tiny", "⚙");
      edit.type = "button";
      edit.dataset.roomEdit = room.id;
      edit.title = "Réglages du spectacle";
      edit.setAttribute("aria-label", "Réglages du spectacle " + room.name);
      head.append(edit);
    }
    group.append(head);

    if (open) {
      const subs = subsOfRoom(room.id).filter((c) => !root || c.id !== root.id);
      for (const channel of subs) group.append(channelItem(channel));
      if (!subs.length && !isAdmin()) group.append(el("p", "muted empty-sub", "Pas d'autre sous-salon pour l'instant."));
      if (isAdmin()) {
        const add = el("button", "add-sub", "+ Nouveau sous-salon");
        add.type = "button";
        add.dataset.newSub = room.id;
        group.append(add);
      }
    }
    return group;
  }

  function renderChannels() {
    const list = $("#channel-list");
    list.replaceChildren();
    if (state.ws) for (const room of roomsOfWs(state.ws.id)) list.append(roomGroup(room));

    const dmList = $("#dm-list");
    dmList.replaceChildren();
    const privates = dms();
    for (const channel of privates) dmList.append(channelItem(channel));
    renderDmToggle();
  }

  // Titre « Messages privés » repliable ; replié, il garde le total des non lus (hors silence).
  function renderDmToggle() {
    const privates = state.ws ? dms() : [];
    const list = $("#dm-list");
    list.hidden = !privates.length || !state.dmOpen;
    const toggle = $("#dm-toggle");
    toggle.setAttribute("aria-expanded", String(state.dmOpen));
    toggle.classList.toggle("open", state.dmOpen);
    const badge = $("#dm-unread");
    let total = 0;
    for (const channel of privates) if (!muted(channel)) total += state.unread.get(channel.id) || 0;
    badge.hidden = state.dmOpen || total <= 0;
    badge.textContent = total > 0 ? countLabel(total) : "";
  }

  function renderHeader() {
    const channel = state.channel;
    // Les messages privés ne dépendent d'aucune production : couleurs neutres.
    document.querySelector("#screen-app .chat").classList.toggle("is-dm", Boolean(channel && channel.kind === "dm" && !state.calendarOpen));
    const avatar = $("#channel-avatar");
    if (state.calendarOpen) {
      avatar.hidden = true;
      $("#channel-title").textContent = "Calendrier";
      $("#channel-desc").textContent = state.ws ? state.ws.name : "";
      $("#channel-bell").hidden = true;
      $("#channel-edit").hidden = true;
      $("#channel-delete-dm").hidden = true;
      $("#channel-search").hidden = true;
      $("#channel-media").hidden = true;
      $("#channel-postits").hidden = true;
      $("#channel-people").hidden = true;
      return;
    }
    avatar.className = "avatar small soft";
    avatar.replaceChildren();
    if (channel && channel.kind === "dm" && dmPartner(channel)) {
      const partner = avatarFor(dmPartner(channel), "small soft");
      avatar.className = partner.className;
      avatar.append(...partner.childNodes);
    } else if (channel) {
      avatar.textContent = isRoot(channel) ? ROOT_GLYPH : initials(channel.name, 1);
    }
    avatar.hidden = !channel;
    const rootRoom = channel && isRoot(channel) ? roomById(channel.room_id) : null;
    $("#channel-title").textContent = rootRoom ? rootRoom.name : channel ? channelTitle(channel) : state.ws ? state.ws.name : "ThyChat";

    const parts = [];
    if (channel && state.ws && channel.kind !== "dm") parts.push(state.ws.name);
    if (channel && channel.kind === "dm") parts.push("Message privé");
    else if (channel) {
      const room = roomById(channel.room_id);
      if (room && !rootRoom) parts.push(room.name);
      if (rootRoom) parts.push("Général");
      if (channel.description) parts.push(channel.description);
    }
    const muteNote = channel ? muteLabel(mutedRowFor(channel)) : "";
    if (muteNote) parts.push(muteNote);
    $("#channel-desc").textContent = parts.join(" · ");

    const bell = $("#channel-bell");
    bell.hidden = !channel;
    const bellOff = Boolean(channel && muted(channel));
    bell.querySelector(".ic:first-child").style.display = bellOff ? "none" : "inline";
    bell.querySelector(".ic:last-child").style.display = bellOff ? "inline" : "none";
    bell.classList.toggle("is-muted", Boolean(channel && muted(channel)));
    bell.title = muteNote || "Sourdine de ce fil";
    const bellLabel = bellOff ? "Sourdine active : réglages de ce fil" : "Mettre ce fil en sourdine";
    bell.setAttribute("aria-label", bellLabel);
    $("#channel-edit").hidden = !channel || channel.kind !== "channel" || !isAdmin();
    $("#channel-delete-dm").hidden = !channel || channel.kind !== "dm";
    $("#channel-search").hidden = !channel;
    $("#channel-media").hidden = !channel;
    $("#channel-postits").hidden = !channel;
    $("#channel-people").hidden = !channel || channel.kind !== "channel";
  }

  // Pastilles de non lus : listes, bouton d'espace, titre de l'onglet et icône de l'application.
  function renderBadges() {
    renderChannels();
    renderSwitchList();
    if (state.ws) {
      const here = wsUnread(state.ws.id);
      $("#ws-muted").hidden = !here.muted;
      // Sur le bouton : les non lus des AUTRES espaces (ceux de l'espace courant sont dans la liste).
      let others = 0;
      for (const ws of state.workspaces) if (ws.id !== state.ws.id) others += wsUnread(ws.id).count;
      const badge = $("#ws-unread");
      badge.hidden = others <= 0;
      badge.textContent = countLabel(others);
    }
    updateTitle();
    setBadge(totalBadge());
  }

  function renderAll() {
    renderWorkspaceHeader();
    renderChannels();
    renderHeader();
    renderTagBar();
    renderCurrentButtons();
    if (state.calendarOpen) renderCalendar();
  }

  function renderMessages(forceBottom = false) {
    const box = $("#messages");
    const previousTop = box.scrollTop;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.replaceChildren();

    if (!state.messages.length && !pendingOfChannel().length) {
      box.append(
        el("p", "muted empty-note", state.tagFilter.size ? "Aucun message pour ces dates." : "Aucun message pour l'instant. Écris le premier !")
      );
    }

    const canModerate = isAdmin() && state.channel && state.channel.kind === "channel";
    let previous = null;
    for (const message of state.messages) {
      const date = new Date(message.created_at);
      const newDay = !previous || dayKey(new Date(previous.created_at)) !== dayKey(date);
      if (newDay) box.append(el("div", "day-divider", dayLabel(date)));

      const grouped =
        !newDay &&
        previous.user_id === message.user_id &&
        date - new Date(previous.created_at) < GROUP_WINDOW_MS;
      const mine = message.user_id === user.id;
      const deletable = mine || canModerate;

      const classes = ["msg", mine ? "mine" : "theirs"];
      if (grouped) classes.push("grouped");
      if (message.id === state.selectedId && !state.multi.size) classes.push("selected");
      if (state.multi.has(message.id)) classes.push("picked");
      if (message.struck_at) classes.push("struck");
      const pinned = isPinned(message.id);
      if (pinned) classes.push("pinned");
      const item = el("article", classes.join(" "));
      item.dataset.id = message.id;
      if (deletable) item.dataset.deletable = "true";

      const bubble = el("div", "bubble");
      if (!mine && !grouped) {
        const author = el("div", "msg-author", authorName(message.user_id));
        author.style.color = `hsl(${authorHue(message.user_id)} 70% 74%)`;
        bubble.append(author);
      }

      const quoted = replyInfo(message);
      if (message.reply_to) {
        const quote = el("div", "msg-quote");
        quote.dataset.reply = message.reply_to;
        quote.append(
          el("strong", "", quoted ? authorName(quoted.user_id) : "Message"),
          el("span", "", quoted ? messageExcerpt(quoted) : "Message introuvable")
        );
        bubble.append(quote);
      }

      const body = el("div", "msg-body");
      let text = message.body;
      const forwarded = /^↪ [^\n]*\n/.exec(text || "");
      if (forwarded) {
        bubble.append(el("div", "msg-forwarded", forwarded[0].trim()));
        text = text.slice(forwarded[0].length);
      }
      const bodyTags = (message.tag_ids || []).map(tagById).filter(Boolean).map((t) => ({ id: t.id, label: t.label, hue: hueOfTag(t) }));
      if (message.attachments && message.attachments.length) bubble.append(imagesBlock(message));
      renderMessageBody(body, text, bodyTags);
      if (message.edited_at) body.append(el("span", "msg-edited", "modifié"));
      const time = el("time", "msg-time", timeFmt.format(date));
      time.dateTime = date.toISOString();
      if (pinned) {
        const mark = el("span", "msg-pinmark");
        mark.title = "Message épinglé";
        mark.append(actionIcon("pin"));
        body.append(mark);
      }
      body.append(time);
      bubble.append(body);
      const messageTags = (message.tag_ids || []).map(tagById).filter(Boolean);
      if (messageTags.length) {
        const row = el("div", "msg-tags");
        for (const tag of messageTags) row.append(el("span", "msg-tag", tagText(tag)));
        bubble.append(row);
      }
      item.append(bubble);

      if (message.id === state.selectedId && !state.multi.size) {
        const actions = el("div", "msg-actions");
        const actionList = [["reply", "Répondre", "reply"], ["quote", "Citer", "quote"], ["copy", "Copier", "copy"], ["forward", "Transférer", "forward"], pinned ? ["unpin", "Détacher", "unpin"] : ["pin", "Épingler", "pin"]];
        if (mine) actionList.push(["edit", "Modifier", "edit"], ["strike", message.struck_at ? "Rétablir" : "Rayer", message.struck_at ? "unstrike" : "strike"]);
        if (isAdmin() && state.channel && state.channel.kind === "channel") actionList.push(["move", "Déplacer", "move"]);
        if (deletable) actionList.push(["delete", "Supprimer", "delete"]);
        for (const [action, label, icon] of actionList) {
          const button = el("button", "msg-act" + (action === "delete" ? " msg-del" : ""));
          button.type = "button";
          button.title = label;
          button.setAttribute("aria-label", label);
          button.dataset.action = action;
          button.dataset.id = message.id;
          button.append(actionIcon(icon));
          actions.append(button);
        }
        item.append(actions);
      }

      box.append(item);
      previous = message;
    }
    for (const entry of pendingOfChannel()) box.append(pendingNode(entry));

    box.classList.toggle("multi", state.multi.size > 0);
    renderSelectBar();
    box.scrollTop = forceBottom || nearBottom ? box.scrollHeight : previousTop;
  }

  // --- Sélection de plusieurs messages (appui long, comme sur WhatsApp) ----------------------

  const canDelete = (message) => message.user_id === user.id || (isAdmin() && state.channel && state.channel.kind === "channel");

  function renderSelectBar() {
    const bar = $("#select-bar");
    const n = state.multi.size;
    bar.hidden = n === 0;
    if (!n) return;
    $("#select-count").textContent = n === 1 ? "1 message" : `${n} messages`;
    const picked = state.messages.filter((m) => state.multi.has(m.id));
    const deletable = picked.length > 0 && picked.every(canDelete);
    const allMine = picked.length > 0 && picked.every((m) => m.user_id === user.id);
    const allStruck = picked.length > 0 && picked.every((m) => m.struck_at);
    $("#select-strike").textContent = allStruck ? "Rétablir" : "Rayer";
    $("#select-strike").disabled = !allMine;
    $("#select-strike").title = allMine ? "" : "Tu ne peux rayer que tes propres messages";
    $("#select-move").hidden = !(isAdmin() && state.channel && state.channel.kind === "channel");
    $("#select-delete").disabled = !deletable;
    $("#select-delete").title = deletable ? "Supprimer la sélection" : "Tu ne peux supprimer que tes propres messages";
  }

  function toggleMulti(id) {
    if (!state.messages.some((m) => m.id === id)) return;
    if (!state.multi.size) guardHistory(); // « Retour » quitte la sélection
    if (state.multi.has(id)) state.multi.delete(id);
    else state.multi.add(id);
    state.selectedId = null;
    renderMessages();
  }

  function clearMulti() {
    if (!state.multi.size) return;
    state.multi = new Set();
    renderMessages();
  }

  async function strikeSelected() {
    const picked = state.messages.filter((m) => state.multi.has(m.id));
    if (!picked.length || !picked.every((m) => m.user_id === user.id)) return;
    const struck_at = picked.every((m) => m.struck_at) ? null : new Date().toISOString();
    let failed = 0;
    for (const message of picked) {
      const { error } = await supabase.from("messages").update({ struck_at }).eq("id", message.id);
      if (error) failed++;
      else message.struck_at = struck_at;
    }
    state.multi = new Set();
    renderMessages();
    if (failed) toast(`${failed} message${failed > 1 ? "s" : ""} non modifié${failed > 1 ? "s" : ""}.`);
  }

  async function deleteSelected() {
    const picked = state.messages.filter((m) => state.multi.has(m.id));
    if (!picked.length || !picked.every(canDelete)) return;
    const n = picked.length;
    if (!window.confirm(n === 1 ? "Supprimer ce message ? Cette action est définitive." : `Supprimer ces ${n} messages ? Cette action est définitive.`)) return;
    let failed = 0;
    for (const message of picked) {
      if (!(await deleteMessage(message.id, false))) failed++;
    }
    state.multi = new Set();
    renderMessages();
    if (failed) toast(`${failed} message${failed > 1 ? "s" : ""} non supprimé${failed > 1 ? "s" : ""}.`);
  }

  // Copie le texte d'un ou plusieurs messages (le texte seul, sans la mention « Transféré »).
  const plainText = (message) => String(message.body || "").replace(/^↪ [^\n]*\n/, "");

  async function copyMessages(ids) {
    const picked = state.messages.filter((m) => ids.includes(m.id));
    if (!picked.length) return;
    const text = picked.length === 1 ? plainText(picked[0]) : picked.map((m) => `${authorName(m.user_id)} : ${plainText(m)}`).join("\n");
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.cssText = "position:fixed;opacity:0;top:0;left:0";
        document.body.append(area);
        area.select();
        ok = document.execCommand("copy");
        area.remove();
      } catch {
        ok = false;
      }
    }
    state.selectedId = null;
    state.multi = new Set();
    renderMessages();
    toast(ok ? (picked.length === 1 ? "Message copié." : `${picked.length} messages copiés.`) : "Copie impossible sur cet appareil.", ok ? "ok" : undefined);
  }

  // --- Transférer des messages ------------------------------------------------------------

  let forwardIds = [];

  function openForward(ids) {
    const picked = state.messages.filter((m) => ids.includes(m.id));
    if (!picked.length || !state.ws) return;
    forwardIds = picked.map((m) => m.id);
    $("#forward-title").textContent = picked.length === 1 ? "Transférer le message" : `Transférer ${picked.length} messages`;
    setNotice("#forward-message", "");
    const list = $("#forward-list");
    list.replaceChildren();
    for (const room of roomsOfWs(state.ws.id)) {
      const root = rootOf(room.id);
      const subs = state.allChannels.filter((c) => c.room_id === room.id && c.kind === "channel");
      if (!subs.length) continue;
      list.append(el("li", "move-room", room.name));
      for (const channel of subs) {
        const item = el("li");
        const button = el("button", "pick-button");
        button.type = "button";
        button.dataset.target = channel.id;
        button.append(el("span", "avatar small soft", isRoot(channel) ? ROOT_GLYPH : initials(channel.name, 1)), el("span", "pick-name", root && channel.id === root.id ? `${channel.name} (salon du spectacle)` : channel.name));
        item.append(button);
        list.append(item);
      }
    }
    const dms = state.allChannels.filter((c) => c.kind === "dm" && dmPartner(c));
    if (dms.length) {
      list.append(el("li", "move-room", "Messages privés"));
      for (const channel of dms) {
        const item = el("li");
        const button = el("button", "pick-button");
        button.type = "button";
        button.dataset.target = channel.id;
        button.append(avatarFor(dmPartner(channel), "small soft"), el("span", "pick-name", authorName(dmPartner(channel))));
        item.append(button);
        list.append(item);
      }
    }
    if (!list.children.length) list.append(el("li", "muted", "Aucun sous-salon."));
    openDialog("#dialog-forward");
  }

  async function forwardMessages(targetId) {
    const target = state.allChannels.find((c) => c.id === targetId);
    const picked = state.messages.filter((m) => forwardIds.includes(m.id));
    if (!target || !picked.length) return;
    const room = roomById(target.room_id);
    const dest = target.kind === "dm" ? authorName(dmPartner(target)) : `${room ? room.name + " › " : ""}${target.name}`;
    setNotice("#forward-message", "Transfert…", "info");
    let done = 0;
    for (const message of picked) {
      const head = /^↪ /.test(message.body) ? "" : `↪ Transféré de ${authorName(message.user_id)}\n`;
      const row = { channel_id: target.id, body: (head + message.body).slice(0, 8000) };
      let copied = [];
      try {
        const attachments = message.attachments || [];
        if (attachments.length) {
          copied = await copyMessageImages(supabase, attachments, target.id);
          row.attachments = copied;
        }
        const { data, error } = await supabase.from("messages").insert(row).select().single();
        if (error) throw error;
        done++;
        if (state.channel && state.channel.id === target.id) {
          await resolveImages([data]);
          addMessage(data, true);
        }
      } catch (error) {
        await removeMessageImages(supabase, copied.map((c) => c.path));
        setNotice("#forward-message", `Transfert impossible : ${error && error.message ? error.message : "erreur"}`);
        if (state.channel && state.channel.id === target.id) renderMessages();
        return;
      }
    }
    closeDialog($("#dialog-forward"));
    forwardIds = [];
    state.multi = new Set();
    state.selectedId = null;
    renderMessages();
    toast(`${done === 1 ? "Message transféré" : done + " messages transférés"} vers « ${dest} ».`, "ok");
  }

  // --- Chargement des données ---------------------------------------------

  function showFatal(error) {
    console.warn("Erreur de chargement :", error.message);
    setView("empty", {
      title: "La base n'est pas prête",
      text:
        "Exécute les fichiers supabase/migrations/005_rooms.sql, 006_tags_replies.sql, 007_strike_space_photo.sql, 008_date_ranges.sql, 009_message_images.sql puis 010_private_messages_global.sql (après 003 et 004, ou supabase/schema.sql) dans l'éditeur SQL de Supabase, puis recharge la page. (" +
        error.message +
        ")",
    });
  }

  async function fetchMemberships() {
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await supabase.from("workspace_members").select(`role, workspaces(${wsColumns()})`).eq("user_id", user.id);
      if (!result.error) break;
      // Migrations des couleurs (002) ou des photos d'espace (007) pas encore exécutées : on continue sans.
      if (/theme/i.test(result.error.message) && state.themeColumn) state.themeColumn = false;
      else if (/avatar_url/i.test(result.error.message) && state.avatarColumn) state.avatarColumn = false;
      else break;
    }
    return result;
  }

  const wsColumns = () => "id, name" + (state.themeColumn ? ", theme" : "") + (state.avatarColumn ? ", avatar_url" : "");

  async function loadWorkspaces(preferredId) {
    const { data, error } = await fetchMemberships();
    if (stopped) return;
    if (error) return showFatal(error);

    const byId = new Map();
    for (const row of data || []) {
      if (!row.workspaces) continue;
      byId.set(row.workspaces.id, {
        id: row.workspaces.id,
        name: row.workspaces.name,
        theme: row.workspaces.theme ?? null,
        avatar: row.workspaces.avatar_url || "",
        role: row.role,
      });
    }
    if (state.isSuper) {
      // L'administrateur général voit et administre tous les espaces.
      const all = await supabase.from("workspaces").select(wsColumns());
      for (const ws of all.data || []) {
        if (!byId.has(ws.id)) byId.set(ws.id, { id: ws.id, name: ws.name, theme: ws.theme ?? null, avatar: ws.avatar_url || "", role: "admin" });
      }
    }
    state.workspaces = [...byId.values()].sort(byName);

    if (!(await loadStructure())) return;
    if (stopped) return;

    if (!state.workspaces.length) {
      state.ws = null;
      state.channel = null;
      renderAll();
      setView("empty", {
        title: "Bienvenue",
        text: state.isSuper
          ? "Crée ton premier espace pour commencer."
          : "Tu n'es dans aucun espace pour l'instant : attends qu'un administrateur t'invite.",
        action: state.isSuper ? "Créer mon premier espace" : "",
        onAction: () => openWorkspaceDialog(),
      });
      return;
    }

    const deep = state.pendingDeepLink;
    state.pendingDeepLink = null;
    const wanted = preferredId || deep?.w || readLast().ws;
    const target = state.workspaces.find((ws) => ws.id === wanted) || state.workspaces[0];
    // Au démarrage on rouvre exactement ce qui était affiché (même un message privé) ; en changeant d'espace, non.
    const last = readLast();
    const reopen = deep?.c || (!preferredId && last.ws === target.id ? last.channel : undefined);
    await selectWorkspace(target.id, reopen);
  }

  async function selectWorkspace(id, channelId) {
    state.ws = state.workspaces.find((ws) => ws.id === id) || null;
    if (!state.ws) return;
    writeLast({ ws: id });
    state.selectedId = null;
    renderWorkspaceHeader();
    if (channelId && state.allChannels.some((c) => c.id === channelId)) return selectChannel(channelId);
    // Changement d'espace : dernier sous-salon ouvert dans CET espace, sinon le premier ; s'il n'y en a aucun, page vide.
    const mine = salons();
    const remembered = (readLast().chans || {})[id];
    const firstRoot = roomsOfWs(id).map((r) => rootOf(r.id)).find(Boolean);
    const target = mine.find((c) => c.id === remembered) || firstRoot || mine[0];
    await selectChannel(target ? target.id : null);
  }

  async function selectChannel(id) {
    const token = ++state.loadToken;
    const previousRoom = state.channel ? state.channel.room_id : null;
    state.calendarOpen = false;
    state.channel = state.allChannels.find((c) => c.id === id) || null;
    if (state.channel && state.channel.kind === "dm") state.dmOpen = true; // le message privé affiché reste visible dans le menu
    state.selectedId = null;
    state.multi = new Set();
    if (!state.channel || state.channel.room_id !== previousRoom || state.focus) state.tagFilter = new Set();
    if (state.pendingFilter) {
      if (state.channel && tagById(state.pendingFilter)) state.tagFilter = new Set([state.pendingFilter]);
      state.pendingFilter = null;
    }
    if (state.editing) $("#composer-input").value = "";
    state.editing = null;
    state.composerTags = defaultComposerTags();
    clearPendingImages();
    state.replyTo = null;
    renderChannels();
    renderHeader();

    if (!state.channel) {
      state.messages = [];
      state.postits = [];
      state.pins = [];
      renderPostitWall();
      renderPinBar();
      setView("empty", {
        title: "Aucun spectacle",
        text: isAdmin()
          ? "Crée le premier spectacle de cet espace : un spectacle, avec son salon « Général » et ses sous-salons (Technique, Musiciens…)."
          : "Tu n'as accès à aucun spectacle dans cet espace pour l'instant. Un administrateur peut t'y ajouter.",
        action: isAdmin() ? "Créer un spectacle" : "",
        onAction: () => openRoomDialog(null),
      });
      renderTagBar();
      renderComposerExtra();
      closeSidebar();
      return;
    }

    writeLast({ channel: state.channel.id });
    if (state.channel.kind !== "dm" && state.ws) writeLast({ chans: { ...(readLast().chans || {}), [state.ws.id]: state.channel.id } });
    if (state.channel.room_id && !isRoot(state.channel)) state.openRooms.add(state.channel.room_id);
    renderChannels();
    guardHistory();
    setView("chat");
    state.messages = [];
    renderTagBar();
    renderComposerExtra();
    renderMessages(true);
    closeSidebar();
    markRead(state.channel.id);

    state.pins = [];
    state.pinIndex = 0;
    renderPinBar();
    loadPostits(state.channel.id, token);
    loadPins(state.channel.id, token);
    await loadMessages(state.channel.id, token);
  }

  async function loadMessages(channelId, token) {
    let query = supabase
      .from("messages")
      .select(MESSAGE_COLS)
      .eq("channel_id", channelId)
      .is("parent_id", null);
    if (state.tagFilter.size) query = query.overlaps("tag_ids", [...state.tagFilter]);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(PAGE_SIZE);
    if (stopped || token !== state.loadToken) return;
    if (error) {
      if (isNetworkError(error, 0) || navigator.onLine === false) {
        state.messages = [];
        renderMessages(true);
        setOffline(true);
        toast("Pas de réseau : ce fil n'est pas encore enregistré sur l'appareil.");
        return;
      }
      toast("Messages illisibles : " + error.message + (/struck_at|reply_to|tag_ids/.test(error.message) ? " (exécute les migrations 006 et 007)" : ""));
      return;
    }
    state.messages = (data || []).slice().reverse();
    // Arrivée depuis une recherche : si le message est plus ancien que la page chargée, on charge depuis ce message.
    const focus = state.focus;
    state.focus = null;
    if (focus && !state.messages.some((m) => m.id === focus.id)) {
      const more = await supabase
        .from("messages")
        .select(MESSAGE_COLS)
        .eq("channel_id", channelId)
        .is("parent_id", null)
        .gte("created_at", focus.at)
        .order("created_at", { ascending: true })
        .limit(500);
      if (stopped || token !== state.loadToken) return;
      if (!more.error && more.data && more.data.length) state.messages = more.data;
    }
    await ensureProfiles(state.messages.map((m) => m.user_id));
    await loadQuoted(state.messages);
    await resolveImages(state.messages);
    if (stopped || token !== state.loadToken) return;
    renderMessages(true);
    if (focus) showMessage(focus.id);
  }

  // Récupère les messages auxquels répondent ceux-ci, quand ils ne sont pas déjà affichés.
  async function loadQuoted(messages) {
    const wanted = [
      ...new Set(
        messages
          .map((m) => m.reply_to)
          .filter((id) => id && !state.quoted.has(id) && !state.messages.some((m) => m.id === id))
      ),
    ];
    if (!wanted.length) return;
    const { data } = await supabase.from("messages").select("id, user_id, body, attachments").in("id", wanted);
    for (const row of data || []) state.quoted.set(row.id, { user_id: row.user_id, body: row.body, attachments: row.attachments });
    await ensureProfiles((data || []).map((row) => row.user_id));
  }

  const replyInfo = (message) => {
    if (!message.reply_to) return null;
    return state.messages.find((m) => m.id === message.reply_to) || state.quoted.get(message.reply_to) || null;
  };

  // --- Temps réel ------------------------------------------------------------
  // Un seul abonnement pour tous les messages visibles (le RLS filtre) : il alimente la conversation
  // ouverte et les pastilles de non lus des autres salons.

  function subscribe() {
    if (state.realtime) return;
    state.realtime = supabase
      .channel("thychat:live")
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, onRealtime)
      .on("postgres_changes", { event: "*", schema: "public", table: "postits" }, onPostitRealtime)
      .on("postgres_changes", { event: "*", schema: "public", table: "message_pins" }, onPinRealtime)
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms" }, refreshStructureSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "room_members" }, refreshStructureSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "tour_tags" }, refreshStructureSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "tag_documents" }, refreshStructureSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "room_sheets" }, refreshStructureSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "channels" }, refreshStructureSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "channel_members" }, refreshStructureSoon)
      .subscribe();
  }

  function unsubscribe() {
    if (state.realtime) {
      supabase.removeChannel(state.realtime);
      state.realtime = null;
    }
  }

  async function onRealtime(payload) {
    if (stopped) return;

    if (payload.eventType === "INSERT") {
      const message = payload.new;
      if (message.parent_id) return;
      const mine = message.user_id === user.id;
      if (state.dmActivity.has(message.channel_id) || state.allChannels.some((c) => c.id === message.channel_id && c.kind === "dm")) {
        state.dmActivity.set(message.channel_id, message.created_at);
        renderChannels();
      }

      if (!state.allChannels.some((c) => c.id === message.channel_id)) {
        refreshStructureSoon(); // nouveau salon ou nouveau message privé
        return;
      }

      const viewing = state.channel && state.channel.id === message.channel_id && !state.calendarOpen;
      if (viewing) {
        await ensureProfiles([message.user_id]);
        await loadQuoted([message]);
        await resolveImages([message]);
        if (stopped || !state.channel || state.channel.id !== message.channel_id) return;
        const hidden = state.tagFilter.size && !(message.tag_ids || []).some((t) => state.tagFilter.has(t));
        if (!hidden) addMessage(message, mine);
        if (!mine) {
          if (visible()) markRead(message.channel_id);
          else bumpUnread(message.channel_id);
        }
      } else if (!mine) {
        bumpUnread(message.channel_id);
      }
    } else if (payload.eventType === "UPDATE") {
      const message = payload.new;
      const index = state.messages.findIndex((m) => m.id === message.id);
      if (index !== -1 && message.channel_id && state.channel && message.channel_id !== state.channel.id) {
        removeMessage(message.id); // déplacé ailleurs
        return;
      }
      if (index === -1) {
        // Déplacé vers le sous-salon qu'on regarde : on l'ajoute.
        if (state.channel && !state.calendarOpen && message.channel_id === state.channel.id && !message.parent_id) {
          await ensureProfiles([message.user_id]);
          await loadQuoted([message]);
          await resolveImages([message]);
          if (!stopped && state.channel && state.channel.id === message.channel_id) addMessage(message);
        }
        return;
      }
      state.messages[index] = { ...state.messages[index], ...message };
      renderMessages();
    } else if (payload.eventType === "DELETE") {
      removeMessage(payload.old && payload.old.id);
    }
  }

  function bumpUnread(channelId) {
    state.unread.set(channelId, (state.unread.get(channelId) || 0) + 1);
    renderBadges();
  }

  function addMessage(message, forceBottom = false) {
    if (state.allChannels.some((c) => c.id === message.channel_id && c.kind === "dm")) {
      state.dmActivity.set(message.channel_id, message.created_at);
      renderChannels();
    }
    if (state.messages.some((m) => m.id === message.id)) return;
    state.messages.push(message);
    state.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    renderMessages(forceBottom);
  }

  // Déplacer un message (administrateurs) vers un autre sous-salon ou spectacle du même espace.
  let movingIds = [];

  function openMove(ids) {
    const list = [].concat(ids);
    const picked = state.messages.filter((m) => list.includes(m.id));
    if (!picked.length || !isAdmin() || !state.channel) return;
    movingIds = picked.map((m) => m.id);
    $("#move-title").textContent = picked.length === 1 ? "Déplacer le message" : `Déplacer ${picked.length} messages`;
    setNotice("#move-message", "");
    const box = $("#move-list");
    box.replaceChildren();
    for (const room of roomsOfWs(state.ws.id)) {
      const root = rootOf(room.id);
      const subs = subsOfRoom(room.id).filter((c) => c.id !== state.channel.id);
      if (!subs.length) continue;
      box.append(el("li", "move-room", room.name));
      for (const channel of subs) {
        const item = el("li");
        const button = el("button", "pick-button");
        button.type = "button";
        button.dataset.target = channel.id;
        button.append(el("span", "avatar small soft", isRoot(channel) ? ROOT_GLYPH : initials(channel.name, 1)), el("span", "pick-name", root && channel.id === root.id ? `${channel.name} (salon du spectacle)` : channel.name));
        item.append(button);
        box.append(item);
      }
    }
    if (!box.children.length) box.append(el("li", "muted", "Aucun autre sous-salon."));
    openDialog("#dialog-move");
  }

  async function moveMessage(targetId) {
    const picked = state.messages.filter((m) => movingIds.includes(m.id));
    const target = state.allChannels.find((c) => c.id === targetId);
    if (!picked.length || !target) return;
    const room = roomById(target.room_id);
    const dest = `${room ? room.name + " › " : ""}${target.name}`;
    const changesRoom = !state.channel || state.channel.room_id !== target.room_id;
    const warn = changesRoom && picked.some((m) => (m.tag_ids || []).length) ? " Leurs dates (#) seront retirées, car elles appartiennent à un spectacle." : "";
    const what = picked.length === 1 ? "ce message" : `ces ${picked.length} messages`;
    if (!window.confirm(`Déplacer ${what} vers « ${dest} » ?${warn}`)) return;
    let done = 0;
    for (const message of picked) {
      // Les photos sont déplacées d'abord (stockage), puis le message ; si le message échoue, on remet les photos.
      let moved = [];
      const paths = (message.attachments || []).map((a) => a.path).filter(Boolean);
      try {
        moved = await moveMessageImages(supabase, paths, target.id);
      } catch (e) {
        setNotice("#move-message", "Photos non déplacées : " + (e.message || e) + " (exécute la migration 016 dans Supabase)." + (done ? ` ${done} message${done > 1 ? "s" : ""} déjà déplacé${done > 1 ? "s" : ""}.` : ""));
        return;
      }
      const { error } = await supabase.rpc("move_message", { msg: message.id, target: target.id });
      if (error) {
        await moveBack(supabase, moved);
        const missing = /move_message|PGRST202/.test(error.message || "") || error.code === "PGRST202";
        setNotice("#move-message", (missing ? "Fonction absente : exécute la migration 015 dans Supabase." : "Déplacement impossible : " + error.message) + (done ? ` ${done} message${done > 1 ? "s" : ""} déjà déplacé${done > 1 ? "s" : ""}.` : ""));
        return;
      }
      done++;
      removeMessage(message.id);
    }
    closeDialog($("#dialog-move"));
    movingIds = [];
    state.multi = new Set();
    renderMessages();
    toast(`${done === 1 ? "Message déplacé" : done + " messages déplacés"} vers « ${dest} ».`, "ok");
  }

  function removeMessage(id) {
    if (!id || !state.messages.some((m) => m.id === id)) return;
    if (state.selectedId === id) state.selectedId = null;
    state.multi.delete(id);
    state.messages = state.messages.filter((m) => m.id !== id);
    renderMessages();
  }

  // --- Actions -----------------------------------------------------------------

  let sending = false;

  // --- Modifier un message (le sien, dans n'importe quel fil) ----------------------------------

  function startEdit(id) {
    const message = state.messages.find((m) => m.id === id);
    if (!message || message.user_id !== user.id) return;
    const head = (/^↪ [^\n]*\n/.exec(message.body || "") || [""])[0]; // la mention « Transféré » est conservée telle quelle
    state.editing = { id, head };
    state.replyTo = null;
    state.selectedId = null;
    clearPendingImages();
    state.composerTags = new Set(message.tag_ids || []);
    const input = $("#composer-input");
    input.value = String(message.body || "").slice(head.length);
    autosize();
    renderComposerExtra();
    renderMessages();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function cancelEdit() {
    if (!state.editing) return;
    state.editing = null;
    $("#composer-input").value = "";
    autosize();
    hideSuggest();
    state.composerTags = defaultComposerTags();
    renderComposerExtra();
  }

  async function saveEdit() {
    const editing = state.editing;
    const message = editing && state.messages.find((m) => m.id === editing.id);
    if (!message) return cancelEdit();
    const text = $("#composer-input").value.trim();
    if (!text && !(message.attachments || []).length) return toast("Un message ne peut pas être vide.");
    const body = (editing.head + text).slice(0, 8000);
    const tag_ids = [...state.composerTags].filter(tagById);
    const sameTags = tag_ids.length === (message.tag_ids || []).length && tag_ids.every((t) => (message.tag_ids || []).includes(t));
    if (body === message.body && sameTags) return cancelEdit();
    sending = true;
    $("#composer-send").disabled = true;
    try {
      const edited_at = new Date().toISOString();
      const { error } = await supabase.from("messages").update({ body, tag_ids, edited_at }).eq("id", message.id);
      if (error) return toast("Modification impossible : " + error.message);
      Object.assign(message, { body, tag_ids, edited_at });
      const cached = state.quoted.get(message.id);
      if (cached) cached.body = body;
      state.editing = null;
      $("#composer-input").value = "";
      autosize();
      hideSuggest();
      state.composerTags = defaultComposerTags();
      renderComposerExtra();
      renderMessages();
      toast("Message modifié.", "ok");
    } finally {
      sending = false;
      $("#composer-send").disabled = false;
    }
  }

  // --- Hors-ligne : bandeau et file d'attente des messages -------------------------------------------

  let offline = false;
  const isOnline = () => navigator.onLine !== false;
  const looksOffline = (error) => !isOnline() || isNetworkError(error && { message: error.message, code: error.code }, undefined);
  const pendingOfChannel = () => (state.channel ? state.outbox.filter((e) => e.channel_id === state.channel.id) : []);
  const pendingUrls = new Map(); // id d'une photo en attente -> adresse locale

  function setOffline(value) {
    offline = Boolean(value);
    renderOfflineBar();
  }

  function renderOfflineBar() {
    const bar = $("#offline-bar");
    if (!bar) return;
    const waiting = state.outbox.filter((e) => e.status === "pending").length;
    bar.hidden = !offline && !waiting;
    if (bar.hidden) return;
    const parts = [];
    if (offline) parts.push("Pas de réseau : tu vois les derniers messages enregistrés sur cet appareil.");
    if (waiting) parts.push(`${waiting} message${waiting > 1 ? "s" : ""} en attente d'envoi${offline ? ", ils partiront au retour du réseau." : "…"}`);
    bar.textContent = parts.join(" ");
  }

  function pendingNode(entry) {
    const failed = entry.status === "failed";
    const item = el("article", "msg mine pending" + (failed ? " failed" : ""));
    item.dataset.pending = entry.id;
    const bubble = el("div", "bubble");
    if (entry.reply_to) {
      const quoted = state.messages.find((m) => m.id === entry.reply_to) || state.quoted.get(entry.reply_to) || null;
      const quote = el("div", "msg-quote");
      quote.append(el("strong", "", quoted ? authorName(quoted.user_id) : "Message"), el("span", "", quoted ? messageExcerpt(quoted) : "Message"));
      bubble.append(quote);
    }
    if (entry.images.length) {
      const box = el("div", "msg-images");
      box.dataset.count = String(Math.min(entry.images.length, 4));
      entry.images.forEach((image, index) => {
        const img = document.createElement("img");
        img.alt = "Photo en attente";
        if (image.width && image.height) img.style.aspectRatio = `${image.width} / ${image.height}`;
        const keyed = `${entry.id}:${index}`;
        if (!pendingUrls.has(keyed) && image.blob && typeof URL.createObjectURL === "function") pendingUrls.set(keyed, URL.createObjectURL(image.blob));
        if (pendingUrls.get(keyed)) img.src = pendingUrls.get(keyed);
        box.append(img);
      });
      bubble.append(box);
    }
    const body = el("div", "msg-body");
    const bodyTags = (entry.tag_ids || []).map(tagById).filter(Boolean).map((t) => ({ id: t.id, label: t.label, hue: hueOfTag(t) }));
    renderMessageBody(body, entry.body, bodyTags);
    bubble.append(body);
    const note = el("div", "msg-pending-note");
    note.append(el("span", "", failed ? "⚠ Non envoyé" + (entry.error ? " : " + entry.error : "") : "⏳ En attente d'envoi"));
    if (failed) {
      const retry = el("button", "ghost small", "Réessayer");
      retry.type = "button";
      retry.dataset.pendingAction = "retry";
      retry.dataset.id = entry.id;
      note.append(retry);
    }
    const cancel = el("button", "ghost small danger", failed ? "Supprimer" : "Annuler");
    cancel.type = "button";
    cancel.dataset.pendingAction = "cancel";
    cancel.dataset.id = entry.id;
    note.append(cancel);
    bubble.append(note);
    item.append(bubble);
    return item;
  }

  function forgetPendingUrls(entry) {
    for (const key of [...pendingUrls.keys()]) {
      if (key.startsWith(entry.id + ":")) {
        if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(pendingUrls.get(key));
        pendingUrls.delete(key);
      }
    }
  }

  async function dropPending(entry) {
    state.outbox = state.outbox.filter((e) => e.id !== entry.id);
    forgetPendingUrls(entry);
    await store.outboxDelete(entry.id);
    renderOfflineBar();
  }

  async function queueMessage(entry) {
    state.outbox.push(entry);
    await store.outboxPut(entry);
    renderMessages(true);
    renderOfflineBar();
  }

  async function pendingAction(action, id) {
    const entry = state.outbox.find((e) => e.id === id);
    if (!entry) return;
    if (action === "cancel") {
      if (!window.confirm("Supprimer ce message qui n'est pas encore parti ?")) return;
      await dropPending(entry);
      renderMessages();
      return;
    }
    entry.status = "pending";
    entry.error = "";
    await store.outboxPut(entry);
    renderMessages();
    renderOfflineBar();
    flushOutbox();
  }

  // Envoie un message de la file ; rend « sent », « network » (on réessaiera) ou « failed ».
  async function sendQueued(entry) {
    try {
      while (entry.images.length) {
        entry.attachments.push(await uploadMessageImage(supabase, entry.channel_id, entry.images[0]));
        entry.images.shift();
        await store.outboxPut(entry);
      }
    } catch (error) {
      if (looksOffline(error)) return "network";
      return fail(entry, error && error.message ? error.message : "photo refusée");
    }
    const row = { id: entry.id, channel_id: entry.channel_id, body: entry.body };
    if (entry.reply_to) row.reply_to = entry.reply_to;
    if (entry.tag_ids && entry.tag_ids.length) row.tag_ids = entry.tag_ids;
    if (entry.attachments.length) row.attachments = entry.attachments;
    const { data, error, status } = await supabase.from("messages").insert(row).select().single();
    if (error) {
      if (isNetworkError(error, status) || !isOnline()) return "network";
      if (error.code === "23505") {
        await dropPending(entry); // déjà arrivé (la réponse s'était perdue) : rien à refaire
        return "sent";
      }
      return fail(entry, error.message);
    }
    await dropPending(entry);
    if (state.channel && state.channel.id === entry.channel_id && data) {
      await resolveImages([data]);
      addMessage(data, true);
    }
    return "sent";
  }

  async function fail(entry, message) {
    entry.status = "failed";
    entry.error = message;
    await store.outboxPut(entry);
    return "failed";
  }

  let flushing = false;
  async function flushOutbox() {
    if (flushing || stopped || !isOnline()) return;
    flushing = true;
    try {
      for (const entry of state.outbox.slice()) {
        if (stopped) break;
        if (entry.status !== "pending") continue;
        const result = await sendQueued(entry); // dans l'ordre d'écriture ; on s'arrête au premier échec de réseau
        if (result === "network") break;
      }
    } finally {
      flushing = false;
      if (!stopped) {
        renderOfflineBar();
        if (state.channel) renderMessages();
      }
    }
  }

  async function sendMessage() {
    if (state.editing) return saveEdit();
    if (sending || !state.channel) return;
    const input = $("#composer-input");
    const body = input.value.trim();
    const images = state.pendingImages.slice();
    if (!body && !images.length) return;

    const channelId = state.channel.id;
    const row = { channel_id: channelId, body };
    if (state.replyTo) row.reply_to = state.replyTo.id;
    if (state.composerTags.size) row.tag_ids = [...state.composerTags];
    const replied = state.replyTo;
    const entry = (extra) => ({
      id: newId(),
      user_id: user.id,
      channel_id: channelId,
      body,
      reply_to: row.reply_to || null,
      tag_ids: row.tag_ids || [],
      images: [],
      attachments: [],
      created_at: new Date().toISOString(),
      status: "pending",
      error: "",
      ...extra,
    });
    // Le message part dans la file (au lieu d'une erreur) quand le réseau manque, ou derrière ceux qui attendent déjà.
    const toQueue = async (extra) => {
      input.value = "";
      autosize();
      hideSuggest();
      if (replied) state.quoted.set(replied.id, { user_id: replied.user_id, body: replied.body, attachments: replied.attachments });
      state.replyTo = null;
      state.composerTags = defaultComposerTags();
      clearPendingImages();
      renderComposerExtra();
      await queueMessage(entry(extra));
      toast("Pas de réseau : ton message est en attente, il partira dès que la connexion revient.", "ok");
    };

    sending = true;
    $("#composer-send").disabled = true;
    const uploaded = [];
    try {
      if (!isOnline() || state.outbox.some((e) => e.status === "pending")) {
        await toQueue({ images: images.map(({ blob, width, height }) => ({ blob, width, height })) });
        flushOutbox();
        return;
      }
      for (const image of images) uploaded.push(await uploadMessageImage(supabase, channelId, image));
      if (uploaded.length) row.attachments = uploaded;
      input.value = "";
      autosize();
      hideSuggest();
      const { data, error, status } = await supabase.from("messages").insert(row).select().single();
      if (error) {
        if (isNetworkError(error, status)) {
          await toQueue({ attachments: uploaded });
          return;
        }
        input.value = body;
        autosize();
        await removeMessageImages(supabase, uploaded.map((u) => u.path));
        toast("Message non envoyé : " + error.message);
        return;
      }
      if (replied) state.quoted.set(replied.id, { user_id: replied.user_id, body: replied.body, attachments: replied.attachments });
      state.replyTo = null;
      state.composerTags = defaultComposerTags();
      clearPendingImages();
      renderComposerExtra();
      await resolveImages([data]);
      const hidden = state.tagFilter.size && !(data.tag_ids || []).some((t) => state.tagFilter.has(t));
      if (hidden) toast("Message envoyé (hors du filtre de dates actuel).");
      else if (state.channel && state.channel.id === channelId) addMessage(data, true);
    } catch (error) {
      if (looksOffline(error)) {
        await toQueue({ attachments: uploaded, images: images.slice(uploaded.length).map(({ blob, width, height }) => ({ blob, width, height })) });
        return;
      }
      await removeMessageImages(supabase, uploaded.map((u) => u.path));
      toast("Photo non envoyée : " + (error && error.message ? error.message : "erreur inconnue") + (/bucket|not found/i.test(String(error && error.message)) ? " (exécute la migration 009)" : ""));
    } finally {
      sending = false;
      $("#composer-send").disabled = false;
    }
  }

  // --- Photos dans les messages ------------------------------------------------------

  function clearPendingImages() {
    for (const image of state.pendingImages) URL.revokeObjectURL(image.url);
    state.pendingImages = [];
  }

  function renderPendingImages() {
    const box = $("#composer-images");
    box.replaceChildren();
    for (const image of state.pendingImages) {
      const thumb = el("div", "pending-image");
      const img = document.createElement("img");
      img.src = image.url;
      img.alt = "Photo à envoyer";
      const remove = el("button", "icon-btn tiny", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", "Retirer la photo");
      remove.addEventListener("click", () => {
        URL.revokeObjectURL(image.url);
        state.pendingImages = state.pendingImages.filter((i) => i.id !== image.id);
        renderComposerExtra();
      });
      thumb.append(img, remove);
      box.append(thumb);
    }
    box.hidden = !state.pendingImages.length;
  }

  async function addImages(files) {
    const list = [...files].filter((f) => f && /^image\//.test(f.type));
    if (!list.length) return;
    const room = MAX_IMAGES - state.pendingImages.length;
    if (room <= 0) return toast(`Au plus ${MAX_IMAGES} photos par message.`);
    if (list.length > room) toast(`Au plus ${MAX_IMAGES} photos par message.`);
    for (const file of list.slice(0, room)) {
      try {
        const { blob, width, height } = await resizedJpeg(file);
        state.pendingImages.push({ id: Math.random().toString(36).slice(2), blob, width, height, url: URL.createObjectURL(blob) });
      } catch {
        toast("Cette image ne peut pas être lue.");
      }
    }
    renderComposerExtra();
  }

  // Liens temporaires des photos des messages donnés.
  async function resolveImages(messages) {
    const paths = [];
    for (const m of messages) for (const a of m.attachments || []) if (a.path && !state.imageUrls.has(a.path)) paths.push(a.path);
    if (!paths.length) return;
    const urls = await signPaths(supabase, [...new Set(paths)]);
    for (const [path, url] of urls) state.imageUrls.set(path, url);
  }

  function imagesBlock(message) {
    const box = el("div", "msg-images");
    box.dataset.count = String(Math.min(message.attachments.length, 4));
    for (const attachment of message.attachments) {
      const img = document.createElement("img");
      img.alt = "Photo";
      img.loading = "lazy";
      if (attachment.w && attachment.h) img.style.aspectRatio = `${attachment.w} / ${attachment.h}`;
      const url = state.imageUrls.get(attachment.path);
      if (url) img.src = url;
      let retried = false;
      img.addEventListener("error", async () => {
        if (retried) return;
        retried = true;
        state.imageUrls.delete(attachment.path);
        await resolveImages([{ attachments: [attachment] }]);
        const fresh = state.imageUrls.get(attachment.path);
        if (fresh) img.src = fresh;
      });
      img.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!img.src) return;
        $("#lightbox-img").src = img.src;
        openDialog("#dialog-image");
      });
      box.append(img);
    }
    return box;
  }

  // --- Post-it : petits mots jaunes collés en haut du fil -------------------------------------------
  // Chaque personne les jette pour elle seule ; ils reviennent à chaque ouverture du fil tant qu'elle ne l'a pas fait.

  const POSTIT_MAX = 300;
  const PEEL_MS = 380; // durée de l'animation « décollé »
  const CRUMPLE_MS = 700; // durée de l'animation « froissé »
  let postitOpenId = null;
  let postitBusy = false;
  let postitFreshId = null; // à coller avec animation au prochain affichage

  const postitById = (id) => state.postits.find((p) => p.id === id);
  // To-Do : une ligne de `postits` avec kind = "todo", body = titre, items = [{ t, done }].
  const isTodo = (p) => p.kind === "todo";
  const todoItems = (p) => (Array.isArray(p.items) ? p.items : []);
  // Empreinte d'une To-Do (ordre des clés sans importance), pour repérer un vrai changement.
  const todoKey = (p) => JSON.stringify([p.body, todoItems(p).map((i) => [i.t, Boolean(i.done), i.by || ""])]);
  const todoSigners = (list) => list.flatMap((p) => (isTodo(p) ? todoItems(p).map((i) => i.by) : [])).filter(Boolean);
  const todoDone = (p) => isTodo(p) && todoItems(p).length > 0 && todoItems(p).every((i) => i.done);
  const activePostits = () => state.postits.filter((p) => !state.postitStates.has(p.id) && !todoDone(p));
  // Jetés par moi, ou To-Do terminées (sauf si je les ai jetées définitivement).
  const trashedPostits = () =>
    state.postits
      .filter((p) => {
        const mine = state.postitStates.get(p.id);
        return mine === "discarded" || (!mine && todoDone(p));
      })
      .slice()
      .reverse();
  // Inclinaison stable (-3° à +3°) propre à chaque Post-it.
  const tiltOf = (id) => {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 997;
    return ((h % 61) - 30) / 10;
  };

  async function loadPostits(channelId, token) {
    state.postits = [];
    state.postitStates = new Map();
    renderPostitWall();
    let posts = await supabase.from("postits").select("id, channel_id, user_id, body, kind, items, created_at").eq("channel_id", channelId).order("created_at", { ascending: true });
    // Sans la migration 022 : seulement les Post-it.
    if (posts.error) posts = await supabase.from("postits").select("id, channel_id, user_id, body, created_at").eq("channel_id", channelId).order("created_at", { ascending: true });
    if (stopped || token !== state.loadToken) return;
    state.postitsReady = !posts.error;
    if (posts.error) return renderPostitWall();
    state.postits = posts.data || [];
    const ids = state.postits.map((p) => p.id);
    if (ids.length) {
      const states = await supabase.from("postit_states").select("postit_id, state").in("postit_id", ids);
      if (stopped || token !== state.loadToken) return;
      for (const row of states.data || []) state.postitStates.set(row.postit_id, row.state);
    }
    await ensureProfiles([...state.postits.map((p) => p.user_id), ...todoSigners(state.postits)]);
    if (stopped || token !== state.loadToken) return;
    renderPostitWall(true);
  }

  // --- Messages épinglés (comme sur WhatsApp) ---------------------------------------------------
  // Toute personne du fil peut épingler un message ou une photo, pour tout le monde : 24 h, 7 jours ou 30 jours, trois au plus.

  const PIN_CHOICES = [[24, "24 heures"], [168, "7 jours"], [720, "30 jours"]];
  const activePins = () => state.pins.filter((pin) => new Date(pin.expires_at).getTime() > Date.now());
  const isPinned = (id) => activePins().some((pin) => pin.message_id === id);

  async function loadPins(channelId, token, { newest = false } = {}) {
    const { data, error } = await supabase
      .from("message_pins")
      .select("message_id, pinned_by, pinned_at, expires_at")
      .eq("channel_id", channelId)
      .gt("expires_at", new Date().toISOString())
      .order("pinned_at", { ascending: false });
    if (stopped || !state.channel || state.channel.id !== channelId || (token && token !== state.loadToken)) return;
    if (error) return; // sans la migration 025 : pas d'épingles
    const previous = newest ? null : activePins()[state.pinIndex];
    state.pins = data || [];
    const kept = previous ? state.pins.findIndex((pin) => pin.message_id === previous.message_id) : -1;
    state.pinIndex = kept === -1 ? 0 : kept;
    const missing = state.pins.map((pin) => pin.message_id).filter((id) => !state.messages.some((m) => m.id === id) && !state.pinMsgs.has(id));
    if (missing.length) {
      const rows = await supabase.from("messages").select("id, user_id, body, attachments, created_at").in("id", missing);
      if (stopped || !state.channel || state.channel.id !== channelId) return;
      for (const row of rows.data || []) state.pinMsgs.set(row.id, row);
      await ensureProfiles((rows.data || []).map((row) => row.user_id));
      await resolveImages(rows.data || []);
    }
    renderPinBar();
    renderMessages();
  }

  const pinnedMessage = (id) => state.messages.find((m) => m.id === id) || state.pinMsgs.get(id) || null;

  function renderPinBar() {
    const bar = $("#pin-bar");
    const list = state.calendarOpen || !state.channel ? [] : activePins();
    bar.hidden = !list.length;
    bar.replaceChildren();
    if (!list.length) return;
    if (state.pinIndex >= list.length) state.pinIndex = 0;
    const pin = list[state.pinIndex];
    const message = pinnedMessage(pin.message_id);
    const dots = el("span", "pin-dots");
    dots.setAttribute("aria-hidden", "true");
    list.forEach((_, index) => dots.append(el("i", index === state.pinIndex ? "on" : "")));
    const text = el("span", "pin-text");
    text.append(
      el("strong", "", list.length > 1 ? `Message épinglé · ${state.pinIndex + 1}/${list.length}` : "Message épinglé"),
      el("span", "pin-excerpt", message ? `${authorName(message.user_id)} : ${messageExcerpt(message, 80) || "Message"}` : "Message")
    );
    bar.append(dots);
    const photo = message && message.attachments && message.attachments[0];
    const url = photo && state.imageUrls.get(photo.path);
    if (url) {
      const thumb = document.createElement("img");
      thumb.className = "pin-thumb";
      thumb.alt = "";
      thumb.src = url;
      bar.append(thumb);
    }
    bar.append(text, actionIcon("pin"));
    bar.setAttribute("aria-label", "Aller au message épinglé");
  }

  // Toucher le bandeau mène au message épinglé, puis passe à l'épingle suivante.
  async function jumpToPin() {
    const list = activePins();
    if (!list.length || !state.channel) return;
    const pin = list[Math.min(state.pinIndex, list.length - 1)];
    state.pinIndex = (state.pinIndex + 1) % list.length;
    renderPinBar();
    if (state.messages.some((m) => m.id === pin.message_id)) return jumpToMessage(pin.message_id);
    const message = pinnedMessage(pin.message_id);
    if (!message) return toast("Ce message n'est plus disponible.");
    state.focus = { id: pin.message_id, at: message.created_at };
    state.tagFilter = new Set(); // le message épinglé peut ne pas porter la date filtrée
    renderTagBar();
    await loadMessages(state.channel.id, state.loadToken);
  }

  function openPin(id) {
    const message = state.messages.find((m) => m.id === id);
    if (!message || !state.channel) return;
    state.pinTarget = id;
    const full = activePins().length >= 3;
    $("#pin-note").textContent = full
      ? "Ce fil a déjà 3 messages épinglés : le plus ancien sera détaché."
      : "Le message reste en haut du fil, pour tout le monde, jusqu'à la fin de la durée choisie.";
    const box = $("#pin-choices");
    box.replaceChildren();
    for (const [hours, label] of PIN_CHOICES) {
      const item = el("li");
      const button = el("button", "pick-button");
      button.type = "button";
      button.dataset.hours = String(hours);
      button.append(el("span", "pick-name", label));
      item.append(button);
      box.append(item);
    }
    openDialog("#dialog-pin");
  }

  async function pinMessage(hours) {
    const id = state.pinTarget;
    state.pinTarget = null;
    closeDialog($("#dialog-pin"));
    if (!id) return;
    state.selectedId = null;
    const { error } = await supabase.rpc("pin_message", { msg: id, hours });
    if (error) {
      renderMessages();
      return toast(isNetworkError(error, 0) ? "Pas de réseau : le message n'est pas épinglé." : "Épinglage impossible : " + error.message + (/pin_message/.test(error.message) ? " (exécute la migration 025)" : ""));
    }
    await loadPins(state.channel.id, null, { newest: true });
    toast("Message épinglé.", "ok");
  }

  async function unpinMessage(id) {
    state.selectedId = null;
    const { error } = await supabase.rpc("unpin_message", { msg: id });
    if (error) {
      renderMessages();
      return toast(isNetworkError(error, 0) ? "Pas de réseau : le message reste épinglé." : "Impossible de détacher : " + error.message);
    }
    state.pins = state.pins.filter((pin) => pin.message_id !== id);
    renderPinBar();
    renderMessages();
    toast("Message détaché.", "ok");
  }

  let pinReload = null;
  function onPinRealtime() {
    if (stopped) return;
    clearTimeout(pinReload);
    pinReload = setTimeout(() => {
      if (!stopped && state.channel) loadPins(state.channel.id);
    }, 150);
  }

  // Un Post-it (collé en haut du fil, ou petit dans la liste des jetés).
  function todoNode(postit, options = {}) {
    const full = options.button === false && !options.mini;
    const node = el(options.button === false ? "div" : "button", "postit todo" + (options.mini ? " mini" : ""));
    if (options.button !== false) node.type = "button";
    node.dataset.id = postit.id;
    node.style.setProperty("--tilt", tiltOf(postit.id) + "deg");
    node.style.setProperty("--delay", (options.delay || 0) + "ms");
    const items = todoItems(postit);
    node.append(el("span", "postit-text", postit.body));
    if (full) {
      const list = el("ul", "todo-list");
      items.forEach((item, index) => {
        const label = el("label", "todo-item");
        const box = el("input");
        box.type = "checkbox";
        box.checked = Boolean(item.done);
        box.dataset.index = String(index);
        label.append(box, el("span", "todo-label", item.t));
        if (item.done && item.by) label.append(el("span", "todo-by", "— " + authorName(item.by)));
        const row = el("li");
        row.append(label);
        list.append(row);
      });
      node.append(list);
    } else if (options.mini) {
      const list = el("ul", "todo-static");
      for (const item of items) list.append(el("li", item.done ? "is-done" : "", (item.done ? "☑ " : "☐ ") + item.t + (item.done && item.by ? " — " + authorName(item.by) : "")));
      node.append(list);
    }
    node.append(el("span", "todo-count", `${items.filter((i) => i.done).length} / ${items.length}`), el("span", "postit-from", "— " + authorName(postit.user_id)));
    return node;
  }

  function postitNode(postit, options = {}) {
    if (isTodo(postit)) return todoNode(postit, options);
    const node = el(options.button === false ? "div" : "button", "postit" + (options.mini ? " mini" : ""));
    if (options.button !== false) node.type = "button";
    node.dataset.id = postit.id;
    node.style.setProperty("--tilt", tiltOf(postit.id) + "deg");
    node.style.setProperty("--delay", (options.delay || 0) + "ms");
    node.append(el("span", "postit-text", postit.body), el("span", "postit-from", "— " + authorName(postit.user_id)));
    return node;
  }

  function renderPostitWall(animate = false) {
    const wall = $("#postit-wall");
    wall.replaceChildren();
    const list = state.calendarOpen || !state.channel ? [] : activePostits();
    wall.hidden = !list.length;
    list.forEach((postit, index) => {
      const node = postitNode(postit, { delay: animate ? index * 110 : 0 });
      if (animate || postit.id === postitFreshId) node.classList.add("stick-in");
      wall.append(node);
    });
    postitFreshId = null;
  }

  let postitEditingId = null;

  function openPostitWrite(editId = null) {
    if (!state.channel) return;
    const editing = editId && postitById(editId);
    postitEditingId = editing ? editId : null;
    $("#postit-form-title").textContent = editing ? "Modifier le Post-it" : "Nouveau Post-it";
    $("#postit-form-note").hidden = Boolean(editing);
    $("#postit-submit").textContent = editing ? "Enregistrer" : "Coller";
    $("#postit-input").value = editing ? editing.body : "";
    $("#postit-count").textContent = `${$("#postit-input").value.length} / ${POSTIT_MAX}`;
    setNotice("#postit-message", "");
    openDialog("#dialog-postit");
    $("#postit-input").focus();
  }

  // --- To-Do : écriture ---------------------------------------------------------------------------------
  const TODO_MAX_ITEMS = 30;
  const TODO_ITEM_MAX = 100;
  let todoEditingId = null;

  function addTodoRow(text = "", done = false, focus = false, after = null, by = "") {
    const list = $("#todo-items");
    if (list.children.length >= TODO_MAX_ITEMS) return null;
    const row = el("li");
    row.dataset.done = done ? "1" : "";
    if (by) row.dataset.by = by;
    const input = el("input");
    input.type = "text";
    input.maxLength = TODO_ITEM_MAX;
    input.value = text;
    input.setAttribute("aria-label", "Ligne de la To-Do");
    input.autocomplete = "off";
    const remove = el("button", "", "×");
    remove.type = "button";
    remove.title = "Retirer la ligne";
    remove.setAttribute("aria-label", "Retirer la ligne");
    row.append(input, remove);
    if (after && after.nextSibling) list.insertBefore(row, after.nextSibling);
    else list.append(row);
    if (focus) input.focus();
    return row;
  }

  function openTodoWrite(editId = null) {
    if (!state.channel) return;
    const editing = editId && postitById(editId);
    todoEditingId = editing ? editId : null;
    $("#todo-form-title").textContent = editing ? "Modifier la To-Do" : "Nouvelle To-Do";
    $("#todo-form-note").hidden = Boolean(editing);
    $("#todo-submit").textContent = editing ? "Enregistrer" : "Coller";
    $("#todo-title").value = editing ? editing.body : "";
    $("#todo-items").replaceChildren();
    if (editing) todoItems(editing).forEach((item) => addTodoRow(item.t, item.done, false, null, item.by || ""));
    else for (let i = 0; i < 3; i++) addTodoRow();
    setNotice("#todo-message", "");
    openDialog("#dialog-todo");
    ($("#todo-items").querySelector("input") || $("#todo-title")).focus();
  }

  async function submitTodo(event) {
    event.preventDefault();
    if (!state.channel || postitBusy) return;
    const items = [...$("#todo-items").children]
      .map((row) => ({ t: row.querySelector("input").value.trim().slice(0, TODO_ITEM_MAX), done: Boolean(row.dataset.done), ...(row.dataset.done && row.dataset.by ? { by: row.dataset.by } : {}) }))
      .filter((item) => item.t);
    if (!items.length) return setNotice("#todo-message", "Écris au moins une ligne dans ta To-Do.");
    const title = $("#todo-title").value.trim().slice(0, 60) || "À faire";
    postitBusy = true;
    const channelId = state.channel.id;
    const editId = todoEditingId;
    const query = editId
      ? supabase.from("postits").update({ body: title, items }).eq("id", editId).select().single()
      : supabase.from("postits").insert({ channel_id: channelId, kind: "todo", body: title, items }).select().single();
    const { data, error } = await query;
    postitBusy = false;
    if (error) {
      return setNotice("#todo-message", "To-Do non enregistrée : " + error.message + (/kind|items|schema cache|permission|policy/i.test(error.message) ? " (exécute la migration 022 dans Supabase)." : ""));
    }
    closeDialog($("#dialog-todo"));
    todoEditingId = null;
    if (!state.channel || state.channel.id !== channelId) return;
    const known = postitById(data.id);
    if (known) Object.assign(known, { body: data.body, items: data.items });
    else state.postits.push(data);
    postitFreshId = data.id;
    renderPostitWall();
  }

  // Cocher / décocher : n'importe qui ayant accès au fil.
  async function setTodoItem(postit, index, done) {
    const { error } = await supabase.rpc("set_todo_item", { p_id: postit.id, p_index: index, p_done: done });
    if (error) return error;
    const items = todoItems(postit).map((item, i) => {
      if (i !== index) return item;
      const { by, ...rest } = item;
      return done ? { ...rest, done, by: user.id } : { ...rest, done };
    });
    postit.items = items;
    const mine = postitById(postit.id);
    if (mine && mine !== postit) mine.items = items;
    return null;
  }

  // Montre (ou retire) la signature à côté d'une case qui vient d'être cochée (ou décochée).
  function signTodoRow(box, postit) {
    const label = box.closest("label");
    if (!label) return;
    for (const old of label.querySelectorAll(".todo-by")) old.remove();
    const item = todoItems(postit)[Number(box.dataset.index)];
    if (item && item.done && item.by) label.append(el("span", "todo-by", "— " + authorName(item.by)));
  }

  // Chaque case cochée ou décochée demande une confirmation (la liste est commune à tout le monde).
  function confirmTodoCheck(postit, index, done) {
    const item = todoItems(postit)[index];
    return window.confirm(`${done ? "Cocher" : "Décocher"} « ${item ? item.t : ""} » ?`);
  }

  async function onTodoCheck(event) {
    const box = event.target.closest('input[type="checkbox"]');
    if (!box) return;
    const postit = postitById(postitOpenId);
    if (!postit || !isTodo(postit)) return;
    const done = box.checked;
    if (postitBusy || !confirmTodoCheck(postit, Number(box.dataset.index), done)) {
      box.checked = !done;
      return;
    }
    postitBusy = true;
    const error = await setTodoItem(postit, Number(box.dataset.index), done);
    postitBusy = false;
    if (error) {
      box.checked = !done;
      return setNotice("#postit-read-message", "Case non enregistrée : " + error.message);
    }
    setNotice("#postit-read-message", "");
    signTodoRow(box, postit);
    const count = $("#postit-read-note").querySelector(".todo-count");
    if (count) count.textContent = `${todoItems(postit).filter((i) => i.done).length} / ${todoItems(postit).length}`;
    if (todoDone(postit)) finishTodo();
  }

  // Toutes les cases cochées : la feuille se froisse et disparaît du haut du fil.
  async function finishTodo() {
    postitBusy = true;
    const note = $("#postit-read-note").firstChild;
    if (note) {
      note.classList.remove("lifted");
      note.classList.add("crumpling");
    }
    await new Promise((resolve) => setTimeout(resolve, CRUMPLE_MS));
    postitBusy = false;
    if (stopped) return;
    postitOpenId = null;
    closeDialog($("#dialog-postit-read"));
    renderPostitWall();
    toast("To-Do terminée ! Elle reste consultable dans « Post-it jetés » (menu ⋮).", "ok");
  }

  // Vue d'ensemble : toutes les To-Do en cours qui me concernent, classées par spectacle.
  let todoView = { room: null, list: [] };
  let todoToken = 0;

  async function openTodos() {
    if (!state.ws) return;
    const token = ++todoToken;
    todoView = { room: null, list: [] };
    setNotice("#todos-message", "");
    $("#todos-list").replaceChildren(el("p", "muted", "Chargement…"));
    $("#todos-back").hidden = true;
    openDialog("#dialog-todos");
    closeSidebar();
    const { data, error } = await supabase.from("postits").select("id, channel_id, user_id, body, kind, items, created_at").eq("kind", "todo").order("created_at", { ascending: true });
    if (token !== todoToken || stopped) return;
    if (error) {
      $("#todos-list").replaceChildren();
      return setNotice("#todos-message", "To-Do illisibles : " + error.message + (/kind|schema cache/i.test(error.message) ? " (exécute la migration 022 dans Supabase)." : ""));
    }
    const visible = (data || []).filter((p) => state.allChannels.some((c) => c.id === p.channel_id));
    let gone = new Set();
    if (visible.length) {
      const states = await supabase.from("postit_states").select("postit_id, state").in("postit_id", visible.map((p) => p.id));
      if (token !== todoToken || stopped) return;
      gone = new Set((states.data || []).map((r) => r.postit_id));
    }
    todoView.list = visible.filter((p) => !gone.has(p.id) && !todoDone(p));
    await ensureProfiles([...todoView.list.map((p) => p.user_id), ...todoSigners(todoView.list)]);
    if (token !== todoToken || stopped) return;
    renderTodos();
  }

  const todoGroupOf = (postit) => {
    const channel = state.allChannels.find((c) => c.id === postit.channel_id);
    return channel && channel.kind === "channel" && channel.room_id ? channel.room_id : "dm";
  };

  function renderTodos() {
    const box = $("#todos-list");
    box.replaceChildren();
    const room = todoView.room;
    $("#todos-back").hidden = !room;
    $("#todos-title").textContent = room ? (room === "dm" ? "To-Do · Messages privés" : `To-Do · ${roomById(room)?.name || ""}`) : "To-Do";
    $("#todos-note").hidden = Boolean(room);
    if (!room) {
      const counts = new Map();
      for (const postit of todoView.list) counts.set(todoGroupOf(postit), (counts.get(todoGroupOf(postit)) || 0) + 1);
      if (!counts.size) return box.append(el("p", "muted", "Aucune To-Do en cours. 🎉"));
      const order = [...state.allRooms.map((r) => r.id), "dm"].filter((id) => counts.has(id));
      for (const id of order) {
        const button = el("button", "ghost todos-room");
        button.type = "button";
        button.dataset.room = id;
        button.append(el("span", "", id === "dm" ? "Messages privés" : roomById(id).name), el("span", "badge-count", String(counts.get(id))));
        box.append(button);
      }
      return;
    }
    const list = todoView.list.filter((p) => todoGroupOf(p) === room);
    if (!list.length) return box.append(el("p", "muted", "Plus aucune To-Do en cours ici. 🎉"));
    for (const postit of list) {
      const sheet = el("div", "todos-sheet");
      const channel = state.allChannels.find((c) => c.id === postit.channel_id);
      const where = el("button", "todos-where", channel ? channelTitle(channel) : "Ouvrir le fil");
      where.type = "button";
      where.dataset.channel = postit.channel_id;
      sheet.append(where, postitNode(postit, { button: false }));
      box.append(sheet);
    }
  }

  async function onTodosCheck(event) {
    const box = event.target.closest('input[type="checkbox"]');
    const node = box && box.closest(".postit.todo");
    const postit = node && todoView.list.find((p) => p.id === node.dataset.id);
    if (!postit) return;
    const done = box.checked;
    if (!confirmTodoCheck(postit, Number(box.dataset.index), done)) {
      box.checked = !done;
      return;
    }
    const error = await setTodoItem(postit, Number(box.dataset.index), done);
    if (error) {
      box.checked = !done;
      return setNotice("#todos-message", "Case non enregistrée : " + error.message);
    }
    setNotice("#todos-message", "");
    signTodoRow(box, postit);
    const count = node.querySelector(".todo-count");
    if (count) count.textContent = `${todoItems(postit).filter((i) => i.done).length} / ${todoItems(postit).length}`;
    if (state.channel && state.channel.id === postit.channel_id) renderPostitWall();
    if (todoDone(postit)) {
      node.classList.add("crumpling");
      setTimeout(() => {
        if (stopped) return;
        todoView.list = todoView.list.filter((p) => p.id !== postit.id);
        if (todoView.room && !todoView.list.some((p) => todoGroupOf(p) === todoView.room)) todoView.room = null;
        if ($("#dialog-todos").hasAttribute("open")) renderTodos();
        toast("To-Do terminée !", "ok");
      }, CRUMPLE_MS);
    }
  }

  async function submitPostit(event) {
    event.preventDefault();
    if (!state.channel || postitBusy) return;
    const body = $("#postit-input").value.trim();
    if (!body) return setNotice("#postit-message", "Écris quelque chose sur ton Post-it.");
    if (postitEditingId) return savePostitEdit(body);
    postitBusy = true;
    const channelId = state.channel.id;
    const { data, error } = await supabase.from("postits").insert({ channel_id: channelId, body: body.slice(0, POSTIT_MAX) }).select().single();
    postitBusy = false;
    if (error) {
      return setNotice("#postit-message", "Post-it non collé : " + error.message + (/postits|relation|schema cache/i.test(error.message) ? " (exécute la migration 020 dans Supabase)." : ""));
    }
    closeDialog($("#dialog-postit"));
    if (state.channel && state.channel.id === channelId && !postitById(data.id)) {
      state.postits.push(data);
      postitFreshId = data.id;
      renderPostitWall();
    }
  }

  async function savePostitEdit(body) {
    const id = postitEditingId;
    const postit = id && postitById(id);
    if (!postit) return closeDialog($("#dialog-postit"));
    if (body === postit.body) {
      postitEditingId = null;
      return closeDialog($("#dialog-postit"));
    }
    postitBusy = true;
    const { data, error } = await supabase.from("postits").update({ body: body.slice(0, POSTIT_MAX) }).eq("id", id).select().single();
    postitBusy = false;
    if (error) {
      return setNotice("#postit-message", "Modification impossible : " + error.message + (/permission|policy|row-level/i.test(error.message) ? " (exécute la migration 021 dans Supabase)." : ""));
    }
    Object.assign(postit, { body: data ? data.body : body });
    postitEditingId = null;
    postitFreshId = id;
    closeDialog($("#dialog-postit"));
    renderPostitWall();
  }

  // Toucher un Post-it : il se décolle de l'écran, puis s'ouvre en grand.
  function peelPostit(id) {
    const postit = postitById(id);
    if (!postit || postitBusy) return;
    const stuck = $("#postit-wall").querySelector(`[data-id="${id}"]`);
    if (stuck) {
      stuck.classList.remove("stick-in");
      stuck.classList.add("peeling");
    }
    postitBusy = true;
    setTimeout(() => {
      postitBusy = false;
      if (stopped) return;
      showPostit(id);
    }, stuck ? PEEL_MS : 0);
  }

  function showPostit(id) {
    const postit = postitById(id);
    if (!postit) return renderPostitWall();
    postitOpenId = id;
    const holder = $("#postit-read-note");
    holder.replaceChildren(postitNode(postit, { button: false }));
    holder.firstChild.classList.add("lifted");
    const when = new Date(postit.created_at);
    $("#postit-read-when").textContent = `${authorName(postit.user_id)} · ${dayLabel(when)} à ${timeFmt.format(when)}`;
    $("#postit-read-hint").textContent = isTodo(postit) ? "Coche les cases ; touche la feuille ailleurs pour la laisser collée." : "Touche le Post-it pour le laisser collé.";
    $("#postit-throw").title = isTodo(postit) ? "Jeter la To-Do" : "Jeter le Post-it";
    $("#postit-edit").hidden = postit.user_id !== user.id;
    $("#postit-delete-all").hidden = !(postit.user_id === user.id || (isAdmin() && state.channel && state.channel.kind === "channel"));
    $("#postit-throw").disabled = false;
    setNotice("#postit-read-message", "");
    openDialog("#dialog-postit-read");
  }

  // Fermer sans jeter : le Post-it se recolle en haut du fil.
  function stickBack() {
    const id = postitOpenId;
    postitOpenId = null;
    if (!id || !postitById(id) || state.postitStates.has(id)) return renderPostitWall();
    postitFreshId = id;
    renderPostitWall();
  }

  // Jeter le Post-it : il se froisse, puis disparaît du haut du fil (pour moi seulement).
  async function throwPostit() {
    const id = postitOpenId;
    if (!id || postitBusy) return;
    postitBusy = true;
    $("#postit-throw").disabled = true;
    const note = $("#postit-read-note").firstChild;
    if (note) {
      note.classList.remove("lifted");
      note.classList.add("crumpling");
    }
    const { error } = await supabase.from("postit_states").upsert({ postit_id: id, user_id: user.id, state: "discarded" }, { onConflict: "postit_id,user_id" });
    await new Promise((resolve) => setTimeout(resolve, CRUMPLE_MS));
    postitBusy = false;
    if (error) {
      if (note) note.classList.remove("crumpling");
      $("#postit-throw").disabled = false;
      return setNotice("#postit-read-message", "Impossible de jeter le Post-it : " + error.message);
    }
    state.postitStates.set(id, "discarded");
    postitOpenId = null;
    closeDialog($("#dialog-postit-read"));
    renderPostitWall();
    if (!$("#dialog-postit-trash").hasAttribute("open")) toast("Post-it jeté. Il reste consultable dans « Post-it jetés » (menu ⋮).", "ok");
  }

  // Retirer pour tout le monde (auteur ou administrateur).
  async function deletePostitForAll() {
    const id = postitOpenId;
    const postit = id && postitById(id);
    if (!postit || !window.confirm("Retirer ce Post-it pour tout le monde ? Cette action est définitive.")) return;
    const { error } = await supabase.from("postits").delete().eq("id", id);
    if (error) return setNotice("#postit-read-message", "Suppression impossible : " + error.message);
    removePostit(id);
    postitOpenId = null;
    closeDialog($("#dialog-postit-read"));
  }

  function removePostit(id) {
    state.postits = state.postits.filter((p) => p.id !== id);
    state.postitStates.delete(id);
    renderPostitWall();
    if ($("#dialog-postit-trash").hasAttribute("open")) renderPostitTrash();
  }

  async function onPostitRealtime(payload) {
    if (stopped) return;
    if (payload.eventType === "INSERT") {
      const postit = payload.new;
      if (!state.channel || postit.channel_id !== state.channel.id || postitById(postit.id)) return;
      await ensureProfiles([postit.user_id]);
      if (!state.channel || postit.channel_id !== state.channel.id || postitById(postit.id)) return;
      state.postits.push(postit);
      postitFreshId = postit.id;
      renderPostitWall();
    } else if (payload.eventType === "UPDATE") {
      const postit = payload.new;
      const mine = postit && postitById(postit.id);
      if (mine) await ensureProfiles(todoSigners([postit]));
      const changed = mine && !stopped && (postit.body !== mine.body || todoKey(postit) !== todoKey(mine));
      if (changed) {
        const itemsOnly = postit.body === mine.body && isTodo(mine);
        mine.body = postit.body;
        if (postit.items) mine.items = postit.items;
        if (!itemsOnly) postitFreshId = mine.id;
        if (postitOpenId === mine.id && isTodo(mine) && !postitBusy) {
          if (todoDone(mine)) {
            postitOpenId = null;
            closeDialog($("#dialog-postit-read"));
          } else {
            showPostit(mine.id);
          }
        }
        renderPostitWall();
      }
    } else if (payload.eventType === "DELETE") {
      const id = payload.old && payload.old.id;
      if (id && postitById(id)) {
        if (postitOpenId === id) {
          postitOpenId = null;
          closeDialog($("#dialog-postit-read"));
        }
        removePostit(id);
      }
    }
  }

  // « Post-it jetés » : consulter les vieux Post-it du fil, les remettre ou les jeter définitivement.
  function openPostitTrash() {
    if (!state.channel) return;
    setNotice("#postit-trash-message", "");
    renderPostitTrash();
    openDialog("#dialog-postit-trash");
  }

  function renderPostitTrash() {
    const box = $("#postit-trash-list");
    box.replaceChildren();
    const list = trashedPostits();
    $("#postit-trash-title").textContent = state.channel ? `Post-it jetés · ${channelTitle(state.channel)}` : "Post-it jetés";
    $("#postit-empty").hidden = !list.length;
    if (!list.length) return box.append(el("p", "muted", "Aucun Post-it jeté dans ce fil."));
    for (const postit of list) {
      const row = el("div", "postit-trash-row");
      const when = new Date(postit.created_at);
      const note = postitNode(postit, { mini: true, button: false });
      const side = el("div", "postit-trash-side");
      side.append(el("small", "muted", `${dayLabel(when)} · ${timeFmt.format(when)}`));
      const back = el("button", "ghost small", "Remettre");
      back.type = "button";
      back.dataset.restore = postit.id;
      const purge = el("button", "ghost small danger", "Jeter définitivement");
      purge.type = "button";
      purge.dataset.purge = postit.id;
      if (todoDone(postit)) side.append(el("small", "muted", "Terminée"), purge);
      else side.append(back, purge);
      row.append(note, side);
      box.append(row);
    }
  }

  async function restorePostit(id) {
    const { error } = await supabase.from("postit_states").delete().eq("postit_id", id).eq("user_id", user.id);
    if (error) return setNotice("#postit-trash-message", "Impossible de remettre le Post-it : " + error.message);
    state.postitStates.delete(id);
    postitFreshId = id;
    renderPostitWall();
    renderPostitTrash();
    toast("Post-it remis en haut du fil.", "ok");
  }

  // Vider la poubelle : tout jeter définitivement (pour moi seulement).
  async function purgeAllPostits() {
    const list = trashedPostits();
    if (!list.length) return;
    if (!window.confirm(`Jeter définitivement ${list.length > 1 ? "ces " + list.length + " éléments" : "cet élément"} ? Ils disparaîtront de cette liste (pour toi seulement).`)) return;
    const rows = list.map((p) => ({ postit_id: p.id, user_id: user.id, state: "purged" }));
    const { error } = await supabase.from("postit_states").upsert(rows, { onConflict: "postit_id,user_id" });
    if (error) return setNotice("#postit-trash-message", "Impossible de vider la poubelle : " + error.message);
    for (const row of rows) state.postitStates.set(row.postit_id, "purged");
    renderPostitTrash();
    toast("Poubelle vidée.", "ok");
  }

  async function purgePostit(id) {
    if (!window.confirm("Jeter définitivement ce Post-it ? Il disparaîtra aussi de cette liste (pour toi seulement).")) return;
    const { error } = await supabase.from("postit_states").upsert({ postit_id: id, user_id: user.id, state: "purged" }, { onConflict: "postit_id,user_id" });
    if (error) return setNotice("#postit-trash-message", "Impossible de jeter le Post-it : " + error.message);
    state.postitStates.set(id, "purged");
    renderPostitTrash();
  }

  // Médias du fil : toutes les photos envoyées dans ce fil, la plus récente d'abord, filtrables par date de tournée (#).
  let mediaToken = 0;
  let mediaItems = [];
  let mediaTags = new Set();

  async function openMedia() {
    const channel = state.channel;
    if (!channel) return;
    const token = ++mediaToken;
    mediaItems = [];
    mediaTags = new Set();
    $("#media-title").textContent = `Médias · ${channelTitle(channel)}`;
    $("#media-filter").replaceChildren();
    const grid = $("#media-grid");
    grid.replaceChildren(el("p", "muted", "Chargement…"));
    openDialog("#dialog-media");
    const { data, error } = await supabase
      .from("messages")
      .select("id, user_id, created_at, attachments, tag_ids")
      .eq("channel_id", channel.id)
      .is("parent_id", null)
      .order("created_at", { ascending: false })
      .limit(1000);
    if (token !== mediaToken || stopped) return;
    if (error) return grid.replaceChildren(el("p", "notice", "Médias illisibles : " + error.message));
    for (const message of data || []) {
      for (const attachment of message.attachments || []) {
        if (attachment.path) mediaItems.push({ ...attachment, at: message.created_at, user_id: message.user_id, tag_ids: message.tag_ids || [] });
      }
    }
    mediaItems.sort((a, b) => new Date(b.at) - new Date(a.at));
    await ensureProfiles(mediaItems.map((i) => i.user_id));
    await resolveImages([{ attachments: mediaItems }]);
    if (token !== mediaToken || stopped) return;
    renderMedia();
  }

  function renderMedia() {
    const channel = state.channel;
    if (!channel) return;
    // Dates de tournée du spectacle : seules celles qui ont au moins une photo.
    const used = new Set(mediaItems.flatMap((i) => i.tag_ids));
    const tags = channel.kind === "channel" ? tagsOfRoom(channel.room_id).filter((t) => used.has(t.id)) : [];
    const bar = $("#media-filter");
    bar.replaceChildren();
    bar.hidden = !tags.length;
    for (const tag of tags) {
      bar.append(
        tagChip(tag, mediaTags.has(tag.id), () => {
          if (mediaTags.has(tag.id)) mediaTags.delete(tag.id);
          else mediaTags.add(tag.id);
          renderMedia();
        })
      );
    }
    const items = mediaTags.size ? mediaItems.filter((i) => i.tag_ids.some((t) => mediaTags.has(t))) : mediaItems;
    $("#media-title").textContent = `Médias · ${channelTitle(channel)}${items.length ? ` (${items.length})` : ""}`;
    const grid = $("#media-grid");
    grid.replaceChildren();
    if (!items.length) {
      return grid.append(el("p", "muted", mediaTags.size ? "Aucune photo pour ces dates." : "Aucune photo n'a encore été envoyée dans ce fil."));
    }
    let day = "";
    let row = null;
    for (const item of items) {
      const date = new Date(item.at);
      const key = dayKey(date);
      if (key !== day) {
        day = key;
        grid.append(el("h4", "media-day", dayLabel(date)));
        row = el("div", "media-row");
        grid.append(row);
      }
      const thumb = el("button", "media-thumb");
      thumb.type = "button";
      thumb.title = `${authorName(item.user_id)} · ${timeFmt.format(date)}`;
      const img = document.createElement("img");
      img.alt = `Photo de ${authorName(item.user_id)}`;
      img.loading = "lazy";
      const url = state.imageUrls.get(item.path);
      if (url) img.src = url;
      thumb.append(img, el("small", "", `${authorName(item.user_id)} · ${timeFmt.format(date)}`));
      thumb.addEventListener("click", () => {
        if (!img.src) return;
        $("#lightbox-img").src = img.src;
        openDialog("#dialog-image");
      });
      row.append(thumb);
    }
  }

  function toggleAttachMenu(force) {
    const menu = $("#attach-menu");
    const open = force === undefined ? menu.hidden : force;
    menu.hidden = !open;
    $("#composer-attach").setAttribute("aria-expanded", String(open));
  }

  // --- Dates de tournée, réponses et citations -------------------------------------

  const currentRoomId = () => (state.channel && state.channel.kind === "channel" ? state.channel.room_id : null);
  const tagById = (id) => state.tags.find((t) => t.id === id);
  // « 9–13 nov. », « 29 nov. → 2 déc. », « 13 nov. » (sans l'année : lisible en badge).
  function shortRange(tag) {
    if (!tag.start_date) return "";
    const a = fromISO(tag.start_date);
    const b = fromISO(tag.end_date || tag.start_date);
    const m = (d) => d.toLocaleDateString("fr-FR", { month: "short" });
    if (toISO(a) === toISO(b)) return `${a.getDate()} ${m(a)}`;
    if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) return `${a.getDate()}–${b.getDate()} ${m(b)}`;
    return `${a.getDate()} ${m(a)} → ${b.getDate()} ${m(b)}`;
  }
  const tagText = (tag) => (tag.start_date ? `${tag.label} · ${rangeText(tag)}` : tag.label);
  // Dernier jour d'une date (fin, sinon dernière représentation, sinon début) ; une date est passée quand il est avant aujourd'hui.
  const tagLastDay = (tag) => tag.end_date || [...(tag.shows || [])].sort().pop() || tag.start_date || "";
  // Barrée à partir du surlendemain du dernier jour : le lendemain (retour) compte encore comme « en cours ».
  const tagIsPast = (tag) => {
    const last = tagLastDay(tag);
    if (!last) return false;
    const limit = fromISO(last);
    limit.setDate(limit.getDate() + 1);
    return toISO(limit) < toISO(new Date());
  };
  const firstShow = (tag) => [...(tag.shows || [])].sort()[0] || null;
  // À venir d'abord (par ordre chronologique), puis sans date, puis les passées (rayées) à la fin.
  const tagsOfRoom = (roomId) =>
    state.tags
      .filter((t) => t.room_id === roomId)
      .sort(
        (a, b) =>
          Number(tagIsPast(a)) - Number(tagIsPast(b)) ||
          (a.start_date || "9999").localeCompare(b.start_date || "9999") ||
          a.label.localeCompare(b.label, "fr"),
      );

  function tagChip(tag, active, onClick) {
    const chip = el("button", "tag-chip", tag.label);
    chip.type = "button";
    chip.dataset.tag = tag.id;
    chip.setAttribute("aria-pressed", String(active));
    if (tagIsPast(tag)) chip.classList.add("is-past");
    if (tag.start_date) chip.append(el("small", "", rangeText(tag)));
    chip.addEventListener("click", onClick);
    return chip;
  }

  const DATES_KEY = "thychat:dates-open";
  function datesOpen() {
    try {
      return localStorage.getItem(DATES_KEY) === "1";
    } catch {
      return false;
    }
  }
  function setDatesOpen(open) {
    try {
      localStorage.setItem(DATES_KEY, open ? "1" : "0");
    } catch {
      /* sans conséquence */
    }
    renderTagBar();
  }

  function renderTagBar() {
    const roomId = currentRoomId();
    const tags = roomId ? tagsOfRoom(roomId) : [];
    const manage = Boolean(roomId) && isAdmin();
    const sheets = roomId ? sheetsOfRoom(roomId) : [];
    $("#tag-bar").hidden = state.calendarOpen || !roomId || (!tags.length && !manage && !sheets.length);
    $("#room-sheet").hidden = !roomId || (!sheets.length && !manage);
    $("#room-sheet-label").textContent = sheets.length ? `Fiche technique · ${shortDate(sheets[0].version_date)}` : "Fiche technique";
    $("#channel-dates").hidden = !manage || state.calendarOpen;
    const open = datesOpen();
    $("#tags-toggle").setAttribute("aria-expanded", String(open));
    $(".tag-bar-chev").textContent = open ? "⌄" : "›";
    $("#tag-bar").classList.toggle("dates-open", open);
    const box = $("#tag-filter");
    box.replaceChildren();
    for (const id of [...state.tagFilter]) if (!tagById(id)) state.tagFilter.delete(id);
    if (open && !tags.length) box.append(el("span", "muted", "Aucune date de tournée pour ce spectacle."));
    // Replié : seules les dates qui filtrent le fil restent visibles (sinon le filtre serait invisible).
    for (const tag of tags) {
      if (!open && !state.tagFilter.has(tag.id)) continue;
      const item = el("span", "tag-item");
      item.append(tagChip(tag, state.tagFilter.has(tag.id), () => toggleTagFilter(tag.id)));
      const count = docsOfTag(tag.id).length;
      if (count || manage) {
        const badge = el("button", "doc-badge");
        badge.type = "button";
        badge.dataset.docsTag = tag.id;
        badge.title = `Documents · ${tag.label}`;
        badge.setAttribute("aria-label", `Documents de ${tag.label} (${count})`);
        badge.append(icon("file"), el("span", "", String(count)));
        item.append(badge);
      }
      box.append(item);
    }
    if (state.tagFilter.size) {
      const clear = el("button", "tag-chip", "Toutes");
      clear.type = "button";
      clear.dataset.clear = "true";
      clear.addEventListener("click", () => {
        state.tagFilter = new Set();
        reloadMessages();
      });
      box.prepend(clear);
    }
    renderWeekStrip();
    renderCurrentButtons();
  }

  function toggleTagFilter(id) {
    if (state.tagFilter.has(id)) state.tagFilter.delete(id);
    else state.tagFilter.add(id);
    reloadMessages();
  }

  async function reloadMessages() {
    renderTagBar();
    if (!state.channel) return;
    const token = ++state.loadToken;
    await loadMessages(state.channel.id, token);
  }

  function renderComposerExtra() {
    const editingMessage = state.editing ? state.messages.find((m) => m.id === state.editing.id) : null;
    const reply = editingMessage || state.replyTo;
    $("#reply-bar").hidden = !reply;
    if (reply) {
      $("#reply-author").textContent = editingMessage ? "Modifier le message" : authorName(reply.user_id);
      $("#reply-excerpt").textContent = messageExcerpt(reply);
    }
    $("#composer-attach").disabled = Boolean(editingMessage);
    const box = $("#composer-tags");
    box.replaceChildren();
    for (const id of state.composerTags) {
      const tag = tagById(id);
      if (!tag) continue;
      const chip = tagChip(tag, true, () => {
        state.composerTags.delete(id);
        const input = $("#composer-input");
        input.value = input.value.split("#" + tag.label).join("").replace(/ {2,}/g, " ");
        autosize();
        renderComposerExtra();
      });
      chip.classList.add("on");
      chip.append(el("small", "", "×"));
      box.append(chip);
    }
    box.hidden = !box.childNodes.length;
    renderPendingImages();
    $("#composer-extra").hidden = state.calendarOpen || (!reply && box.hidden && $("#composer-images").hidden);
  }

  // --- Dates en cours : accès rapide depuis n'importe où -----------------------------------

  // Dates en cours : de la veille du début au lendemain de la fin (trajets aller et retour), dans tous les spectacles accessibles.
  const dayBefore = (iso) => toISO(addDays(fromISO(iso), -1));
  const dayAfter = (iso) => toISO(addDays(fromISO(iso), 1));
  // Date en cours du spectacle ouvert, proposée d'office dans chaque nouveau message (un appui sur son badge la retire).
  // Sur place (du premier au dernier jour) d'abord ; sinon les jours de trajet (veille, lendemain).
  function defaultComposerTags() {
    const roomId = currentRoomId();
    if (!roomId) return new Set();
    const today = toISO(new Date());
    const list = currentDates().filter((t) => t.room_id === roomId);
    const onSite = list.filter((t) => today >= t.start_date && today <= (t.end_date || t.start_date));
    return new Set((onSite.length ? onSite : list).map((t) => t.id));
  }

  function currentDates() {
    const today = toISO(new Date());
    return state.tags
      .filter((t) => t.start_date && dayBefore(t.start_date) <= today && today <= dayAfter(t.end_date || t.start_date) && roomById(t.room_id))
      .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.label.localeCompare(b.label, "fr"));
  }

  // Une pastille par couleur de production concernée (la plus proche en premier), au plus 3.
  function fillDots(box, list) {
    box.replaceChildren();
    const hues = [...new Set(list.map(hueOfTag))].slice(0, 3);
    for (const hue of hues) {
      const dot = el("span", "live-dot");
      dot.style.setProperty("--h", String(hue));
      box.append(dot);
    }
    return hues[0];
  }

  function renderCurrentButtons() {
    const list = currentDates();
    const n = list.length;
    const hue = fillDots($("#current-dots"), list);
    fillDots($("#channel-current-dots"), list);
    for (const sel of ["#open-current", "#channel-current"]) {
      if (hue === undefined) $(sel).style.removeProperty("--btn-h");
      else $(sel).style.setProperty("--btn-h", String(hue));
    }
    $("#open-current").hidden = !n;
    $("#current-count").textContent = String(n);
    $("#current-label").textContent = n === 1 ? "1 date en cours" : "Dates en cours";
    $("#channel-current").hidden = !n;
    $("#channel-current-count").textContent = String(n);
    $("#channel-current").title = n === 1 ? "1 date en cours" : `${n} dates en cours`;
  }

  function openCurrent() {
    setNotice("#current-message", "");
    renderCurrent();
    openDialog("#dialog-current");
  }

  function renderCurrent() {
    const box = $("#current-list");
    box.replaceChildren();
    const today = toISO(new Date());
    const list = currentDates();
    if (!list.length) {
      box.append(el("p", "muted", "Aucune date n'est en cours aujourd'hui."));
      return;
    }
    for (const tag of list) {
      const room = roomById(tag.room_id);
      const ws = state.workspaces.find((w) => w.id === room.workspace_id);
      const section = el("section", "docs-tag colored");
      section.style.setProperty("--h", String(hueOfTag(tag)));
      const head = el("div", "docs-tag-head");
      head.append(el("span", "live-dot"), el("strong", "", `${room.name} · ${tag.label}`));
      head.append(el("small", "muted", [state.workspaces.length > 1 && ws ? ws.name : "", rangeText(tag)].filter(Boolean).join(" · ")));
      const go = el("button", "ghost small", "Ouvrir le spectacle");
      go.type = "button";
      go.dataset.goTag = tag.id;
      head.append(go);
      section.append(head);
      if (today < tag.start_date) section.append(el("p", "travel-note", "Veille : début demain"));
      else if (today > (tag.end_date || tag.start_date)) section.append(el("p", "travel-note", "Lendemain : retour"));
      if ((tag.shows || []).includes(today)) section.append(el("p", "show-today", "★ Représentation aujourd'hui"));
      for (const sheet of latestSheets(tag.room_id)) {
        const open = docLink(sheet, "doc-open latest");
        const text = el("span", "doc-name two");
        text.append(el("strong", "", sheet.name), el("small", "muted", `Fiche technique · version du ${shortDate(sheet.version_date)}`));
        open.append(docIcon(sheet), text, el("small", "muted", docMeta(sheet)));
        section.append(open);
      }
      const docs = docsOfTag(tag.id);
      if (!docs.length) section.append(el("p", "muted docs-empty", "Aucun document pour cette date."));
      for (const doc of docs) {
        const open = docLink(doc, "doc-open");
        open.append(docIcon(doc), el("span", "doc-name", doc.name), el("small", "muted", docMeta(doc)));
        section.append(open);
      }
      box.append(section);
    }
  }

  // --- Documents PDF des dates -------------------------------------------------------------

  const docsOfTag = (tagId) => state.tagDocs.filter((d) => d.tag_id === tagId);
  const docsOfRoom = (roomId) => {
    const ids = new Set(state.tags.filter((t) => t.room_id === roomId).map((t) => t.id));
    return state.tagDocs.filter((d) => ids.has(d.tag_id));
  };
  let docsTarget = null; // date qui reçoit les fichiers choisis

  // Fiches techniques : la version la plus récente d'abord.
  const sheetsOfRoom = (roomId) =>
    state.sheets
      .filter((s) => s.room_id === roomId)
      .sort((a, b) => b.version_date.localeCompare(a.version_date) || String(b.created_at).localeCompare(String(a.created_at)));

  // Fiche technique en vigueur : tous les fichiers et liens de la version la plus récente (plan son, plan lumière…).
  const latestSheets = (roomId) => {
    const all = sheetsOfRoom(roomId);
    return all.filter((s) => all[0] && s.version_date === all[0].version_date);
  };

  function openSheet() {
    const roomId = currentRoomId();
    if (!roomId) return;
    const room = roomById(roomId);
    $("#sheet-title").textContent = room ? `Fiche technique · ${room.name}` : "Fiche technique";
    $("#sheet-note").textContent = isAdmin()
      ? "Une fiche technique peut réunir plusieurs fichiers (plan son, plan lumière…) : PDF, images (15 Mo au plus) ou liens. Ajoute-les avec la date de la version : la plus récente est mise en avant, les précédentes restent consultables."
      : "La version la plus récente est mise en avant ; les précédentes restent consultables.";
    $("#sheet-form").hidden = !isAdmin();
    $("#sheet-date").value = toISO(new Date());
    $("#sheet-label").value = "";
    $("#sheet-url").value = "";
    setNotice("#sheet-message", "");
    renderSheet();
    openDialog("#dialog-sheet");
  }

  function sheetRow(sheet, latest) {
    const row = el("div", "doc-row");
    const open = docLink(sheet, "doc-open" + (latest ? " latest" : ""));
    open.append(docIcon(sheet), el("span", "doc-name", sheet.name), el("small", "muted", docMeta(sheet)));
    row.append(open);
    if (isAdmin()) {
      const del = el("button", "icon-btn tiny", "");
      del.type = "button";
      del.dataset.delSheet = sheet.id;
      del.title = "Retirer ce document";
      del.setAttribute("aria-label", "Retirer « " + sheet.name + " »");
      del.append(icon("x"));
      row.append(del);
    }
    return row;
  }

  function renderSheet() {
    const box = $("#sheet-list");
    box.replaceChildren();
    const list = sheetsOfRoom(currentRoomId());
    if (!list.length) {
      box.append(el("p", "muted", "Aucune fiche technique pour l'instant."));
      return;
    }
    // Une section par date de version ; la plus récente en tête.
    const dates = [...new Set(list.map((s) => s.version_date))];
    dates.forEach((date, index) => {
      const section = el("section", "docs-tag");
      section.append(el("strong", "", index === 0 ? `Version la plus récente · ${shortDate(date)}` : `Version du ${shortDate(date)}`));
      for (const sheet of list.filter((s) => s.version_date === date)) section.append(sheetRow(sheet, index === 0));
      box.append(section);
    });
  }

  // Ajoute à la fiche des fichiers (PDF, images) ; un intitulé n'est pris en compte que pour un fichier seul.
  async function addSheetFiles(files) {
    const roomId = currentRoomId();
    if (!roomId || !isAdmin() || !files.length) return;
    const date = $("#sheet-date").value;
    if (!date) return setNotice("#sheet-message", "Indique la date de la version.");
    const label = $("#sheet-label").value.trim().slice(0, 160);
    const problems = [];
    setNotice("#sheet-message", "Envoi…", "info");
    for (const file of files) {
      if (!fileType(file)) {
        problems.push(`« ${file.name} » n'est ni un PDF ni une image.`);
        continue;
      }
      if (file.size > MAX_PDF_BYTES) {
        problems.push(`« ${file.name} » dépasse 15 Mo.`);
        continue;
      }
      let stored = null;
      try {
        stored = await uploadRoomSheet(supabase, roomId, file);
        if (label && files.length === 1) stored.name = label;
        const { data, error } = await supabase.from("room_sheets").insert({ room_id: roomId, version_date: date, ...stored }).select().single();
        if (error) throw error;
        state.sheets.push(data);
      } catch (error) {
        if (stored) await removeTagDocuments(supabase, [stored.path]);
        const text = error && error.message ? error.message : "envoi impossible";
        problems.push(`« ${file.name} » : ${text}${/bucket|not found|room_sheets|mime/i.test(text) ? " (exécute les migrations 012, 013 et 017)" : ""}`);
      }
    }
    setNotice("#sheet-message", problems.join(" "));
    if (!problems.length) $("#sheet-label").value = "";
    renderSheet();
    renderTagBar();
  }

  async function addSheetLink() {
    const roomId = currentRoomId();
    if (!roomId || !isAdmin()) return;
    const date = $("#sheet-date").value;
    if (!date) return setNotice("#sheet-message", "Indique la date de la version.");
    const url = cleanUrl($("#sheet-url").value);
    if (!url) return setNotice("#sheet-message", "Cette adresse n'est pas un lien web valable (https://…).");
    const name = $("#sheet-label").value.trim().slice(0, 160) || new URL(url).hostname.replace(/^www\./, "");
    const { data, error } = await supabase.from("room_sheets").insert({ room_id: roomId, version_date: date, kind: "link", url, name }).select().single();
    if (error) {
      return setNotice("#sheet-message", `Ajout impossible : ${error.message}${/kind|url|constraint/i.test(error.message) ? " (exécute la migration 017)" : ""}`);
    }
    state.sheets.push(data);
    $("#sheet-url").value = "";
    $("#sheet-label").value = "";
    setNotice("#sheet-message", "");
    renderSheet();
    renderTagBar();
  }

  async function deleteSheet(id) {
    const sheet = state.sheets.find((s) => s.id === id);
    if (!sheet || !window.confirm(`Retirer « ${sheet.name} » (version du ${shortDate(sheet.version_date)}) ?`)) return;
    const { error } = await supabase.from("room_sheets").delete().eq("id", id);
    if (error) return setNotice("#sheet-message", "Suppression impossible : " + error.message);
    state.sheets = state.sheets.filter((s) => s.id !== id);
    await removeTagDocuments(supabase, [sheet.path]); // sans effet pour un lien
    renderSheet();
    renderTagBar();
  }

  let docsOnlyTag = null;

  function openDocs(tagId) {
    if (!currentRoomId()) return;
    docsOnlyTag = typeof tagId === "string" ? tagId : null;
    const room = roomById(currentRoomId());
    const only = docsOnlyTag ? tagById(docsOnlyTag) : null;
    $("#docs-title").textContent = only ? `Documents · ${only.label}` : room ? `Documents · ${room.name}` : "Documents du spectacle";
    $("#docs-note").textContent = isAdmin()
      ? "Ajoute à chaque date des PDF, des images (15 Mo au plus) ou des liens : feuilles de route, billets, livrets d'accueil… Toutes les personnes ayant accès au spectacle peuvent les ouvrir. Ils sont effacés automatiquement 10 jours après la fin de la date."
      : "Feuilles de route, billets, livrets d'accueil… rangés par date de tournée.";
    setNotice("#docs-message", "");
    linkTarget = null;
    $("#docs-link-form").hidden = true;
    renderDocs();
    openDialog("#dialog-docs");
  }

  function renderDocs() {
    const box = $("#docs-list");
    box.replaceChildren();
    const roomId = currentRoomId();
    if (!roomId) return;
    const admin = isAdmin();
    const tags = tagsOfRoom(roomId).filter((t) => (admin || docsOfTag(t.id).length) && (!docsOnlyTag || t.id === docsOnlyTag));
    if (!tags.length) {
      box.append(el("p", "muted", admin ? "Crée d'abord une date de tournée (menu ⋮ > « Gérer les dates de tournée »)." : "Aucun document pour l'instant."));
      return;
    }
    for (const tag of tags) {
      const section = el("section", "docs-tag");
      const head = el("div", "docs-tag-head");
      head.append(el("strong", "", tag.label));
      if (tag.start_date) head.append(el("small", "muted", rangeText(tag)));
      if (admin) {
        const add = el("button", "ghost small", "+ Fichier");
        add.type = "button";
        add.dataset.addDoc = tag.id;
        const addLink = el("button", "ghost small", "+ Lien");
        addLink.type = "button";
        addLink.dataset.addLink = tag.id;
        head.append(add, addLink);
      }
      section.append(head);
      const docs = docsOfTag(tag.id);
      if (!docs.length) section.append(el("p", "muted docs-empty", "Aucun document."));
      for (const doc of docs) {
        const row = el("div", "doc-row");
        const open = docLink(doc, "doc-open");
        open.append(docIcon(doc), el("span", "doc-name", doc.name), el("small", "muted", docMeta(doc)));
        row.append(open);
        if (admin) {
          const del = el("button", "icon-btn tiny", "");
          del.type = "button";
          del.dataset.delDoc = doc.id;
          del.title = "Retirer ce document";
          del.setAttribute("aria-label", "Retirer le document " + doc.name);
          del.append(icon("x"));
          row.append(del);
        }
        section.append(row);
      }
      box.append(section);
    }
  }

  let linkTarget = null; // date qui reçoit le lien en cours de saisie

  async function addDocumentLink() {
    const tag = linkTarget && tagById(linkTarget);
    if (!tag || !isAdmin()) return;
    const url = cleanUrl($("#docs-link-url").value);
    if (!url) return setNotice("#docs-message", "Cette adresse n'est pas un lien web valable (https://…).");
    const name = $("#docs-link-name").value.trim().slice(0, 160) || new URL(url).hostname.replace(/^www\./, "");
    const { data, error } = await supabase.from("tag_documents").insert({ tag_id: tag.id, kind: "link", url, name }).select().single();
    if (error) {
      return setNotice("#docs-message", `Ajout impossible : ${error.message}${/kind|url|constraint/i.test(error.message) ? " (exécute la migration 017)" : ""}`);
    }
    state.tagDocs.push(data);
    linkTarget = null;
    $("#docs-link-form").hidden = true;
    setNotice("#docs-message", "");
    renderDocs();
    renderTagBar();
  }

  async function addDocuments(files) {
    const tag = docsTarget && tagById(docsTarget);
    docsTarget = null;
    if (!tag || !isAdmin()) return;
    const list = [...files];
    const problems = [];
    for (const file of list) {
      if (!fileType(file)) {
        problems.push(`« ${file.name} » n'est ni un PDF ni une image.`);
        continue;
      }
      if (file.size > MAX_PDF_BYTES) {
        problems.push(`« ${file.name} » dépasse 15 Mo.`);
        continue;
      }
      let stored = null;
      try {
        stored = await uploadTagDocument(supabase, tag.room_id, tag.id, file);
        const { data, error } = await supabase.from("tag_documents").insert({ tag_id: tag.id, ...stored }).select().single();
        if (error) throw error;
        state.tagDocs.push(data);
      } catch (error) {
        if (stored) await removeTagDocuments(supabase, [stored.path]);
        problems.push(`« ${file.name} » : ${error && error.message ? error.message : "envoi impossible"}${/bucket|not found|tag_documents/i.test(String(error && error.message)) ? " (exécute les migrations 012 et 017)" : ""}`);
      }
    }
    setNotice("#docs-message", problems.join(" "));
    renderDocs();
    renderTagBar();
  }

  // Les PDF sont de vrais liens (touchés directement par la personne) : aucun blocage de fenêtre, même sur téléphone.
  const docUrls = new Map(); // chemin -> { url, at }
  let signQueue = new Map(); // chemin -> liens à renseigner
  let signTimer = null;

  const isLinkDoc = (doc) => doc.kind === "link";
  const docIcon = (doc) => icon(isLinkDoc(doc) ? "link" : "file");
  // Précision affichée à droite : taille du fichier, ou site du lien.
  function docMeta(doc) {
    if (!isLinkDoc(doc)) return sizeLabel(doc.size_bytes);
    try {
      return new URL(cleanUrl(doc.url)).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  function docLink(doc, className) {
    const link = el("a", className);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (isLinkDoc(doc)) {
      const safe = cleanUrl(doc.url); // jamais d'autre schéma que http(s)
      if (safe) link.href = safe;
      return link;
    }
    const cached = docUrls.get(doc.path);
    if (cached && Date.now() - cached.at < 50 * 60 * 1000) {
      link.href = cached.url;
    } else {
      link.setAttribute("aria-busy", "true");
      if (!signQueue.has(doc.path)) signQueue.set(doc.path, []);
      signQueue.get(doc.path).push(link);
      clearTimeout(signTimer);
      signTimer = setTimeout(flushSigns, 0);
    }
    link.addEventListener("click", (event) => {
      if (!link.getAttribute("href")) {
        event.preventDefault();
        toast("Le lien se prépare, touche à nouveau dans un instant.");
      }
    });
    return link;
  }

  async function flushSigns() {
    const queue = signQueue;
    signQueue = new Map();
    if (!queue.size) return;
    let urls;
    try {
      urls = await signDocuments(supabase, [...queue.keys()]);
    } catch (error) {
      toast("Documents indisponibles : " + (error && error.message ? error.message : "lien impossible"));
      return;
    }
    for (const [path, links] of queue) {
      const url = urls.get(path);
      if (!url) continue;
      docUrls.set(path, { url, at: Date.now() });
      for (const link of links) {
        link.href = url;
        link.removeAttribute("aria-busy");
      }
    }
  }

  async function deleteDocument(id) {
    const doc = state.tagDocs.find((d) => d.id === id);
    if (!doc || !window.confirm(`Retirer le document « ${doc.name} » ?`)) return;
    const { error } = await supabase.from("tag_documents").delete().eq("id", id);
    if (error) return setNotice("#docs-message", "Suppression impossible : " + error.message);
    state.tagDocs = state.tagDocs.filter((d) => d.id !== id);
    await removeTagDocuments(supabase, [doc.path]);
    setNotice("#docs-message", "");
    renderDocs();
    renderTagBar();
  }

  // --- Calendrier et frise hebdomadaire ---------------------------------------------

  const hueOfTag = (tag) => {
    const room = roomById(tag.room_id);
    const ws = room && state.workspaces.find((w) => w.id === room.workspace_id);
    return themeFor(ws || state.ws).hue;
  };

  // Grille d'une semaine (ou d'une frise) : cases des jours, ★ des représentations et frises des dates.
  function weekGrid(days, tags, lanes, opts = {}) {
    const isos = days.map(toISO);
    const placed = tags.filter((t) => t.start_date && isos.some((x) => x >= t.start_date && x <= t.end_date));
    const laneCount = placed.length ? Math.max(...placed.map((t) => lanes.get(t.id) ?? 0)) + 1 : 0;
    const barH = opts.compact ? 18 : 22;
    const grid = el("div", "cal-week" + (opts.compact ? " compact" : ""));
    grid.style.gridTemplateColumns = `repeat(${days.length}, minmax(0, 1fr))`;
    const headH = opts.compact ? 40 : 30;
    const tail = opts.compact ? 4 : Math.max(10, 76 - headH - laneCount * barH); // jour toujours assez haut pour être touché
    grid.style.gridTemplateRows = `${headH}px repeat(${laneCount}, ${barH}px) ${tail}px`;
    const today = toISO(new Date());

    days.forEach((day, index) => {
      const cell = el("div", "cal-day");
      cell.dataset.day = isos[index];
      cell.style.gridColumn = String(index + 1);
      cell.style.gridRow = `1 / span ${laneCount + 2}`;
      if (isos[index] === today) cell.classList.add("today");
      if (isos[index] === state.calDay && !opts.compact) cell.classList.add("picked");
      if (opts.month !== undefined && day.getMonth() !== opts.month) cell.classList.add("outside");
      const head = el("div", "cal-day-head");
      if (opts.compact) head.append(el("small", "", weekdayShort(day)));
      head.append(el("span", "cal-num", String(day.getDate())));
      cell.append(head);
      grid.append(cell);
    });

    for (const tag of placed) {
      const first = isos.findIndex((x) => x >= tag.start_date && x <= tag.end_date);
      let last = first;
      while (last + 1 < isos.length && isos[last + 1] <= tag.end_date) last += 1;
      const label = opts.showRoom ? `${roomById(tag.room_id)?.name || ""} · ${tag.label}` : tag.label;
      const bar = el("div", "cal-bar", label);
      bar.dataset.tag = tag.id;
      bar.style.gridColumn = `${first + 1} / ${last + 2}`;
      bar.style.gridRow = String((lanes.get(tag.id) ?? 0) + 2);
      bar.style.setProperty("--h", String(hueOfTag(tag)));
      if (isos[first] !== tag.start_date) bar.classList.add("cont-left");
      if (isos[last] !== tag.end_date) bar.classList.add("cont-right");
      bar.title = `${label} · ${rangeText(tag)}`;
      grid.append(bar);
    }

    // ★ des représentations : au milieu de la journée, posée sur la frise de la date (ou sous les frises si elle n'en a pas ce jour-là).
    for (const tag of tags) {
      const perDay = new Map();
      for (const iso of tag.shows || []) perDay.set(iso, (perDay.get(iso) || 0) + 1);
      for (const [iso, count] of perDay) {
        const index = isos.indexOf(iso);
        if (index < 0) continue;
        const onBar = Boolean(tag.start_date) && iso >= tag.start_date && iso <= tag.end_date;
        const star = el("span", "cal-star" + (onBar ? " on-bar" : " alone"), count > 1 ? `★${count}` : "★");
        if (count > 1) star.title = `${count} représentations`;
        star.style.gridColumn = String(index + 1);
        star.style.gridRow = String(onBar ? (lanes.get(tag.id) ?? 0) + 2 : laneCount + 2);
        star.style.setProperty("--h", String(hueOfTag(tag)));
        grid.append(star);
      }
    }
    return grid;
  }

  // Frise glissante dans l'en-tête du spectacle : la veille et les 6 jours suivants.
  function renderWeekStrip() {
    const strip = $("#week-strip");
    const roomId = currentRoomId();
    const tags = roomId ? tagsOfRoom(roomId).filter((t) => t.start_date || (t.shows || []).length) : [];
    strip.hidden = state.calendarOpen || !roomId || !tags.length;
    strip.replaceChildren();
    if (strip.hidden) return;
    const start = addDays(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()), -1);
    const days = Array.from({ length: 8 }, (_, i) => addDays(start, i));
    strip.append(weekGrid(days, tags, assignLanes(tags), { compact: true }));
  }

  function visibleCalendarTags() {
    let rooms;
    if (state.calScope === "all") rooms = state.allRooms;
    else if (state.calScope === "ws" || !roomById(state.calScope)) rooms = state.ws ? roomsOfWs(state.ws.id) : [];
    else rooms = [roomById(state.calScope)];
    const ids = new Set(rooms.map((r) => r.id));
    return state.tags.filter((t) => ids.has(t.room_id) && (t.start_date || (t.shows || []).length));
  }

  function openCalendar(roomId) {
    if (!state.ws) return;
    state.calendarOpen = true;
    state.selectedId = null;
    state.multi = new Set();
    renderPostitWall();
    renderPinBar();
    if (roomId && roomById(roomId)) state.calScope = roomId;
    else if (state.calScope !== "all" && !roomById(state.calScope)) state.calScope = "ws";
    const now = new Date();
    state.calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    state.calDay = toISO(now);
    hideSuggest();
    setView("calendar");
    renderHeader();
    renderTagBar();
    renderComposerExtra();
    renderCalendar();
    closeSidebar();
    guardHistory();
  }

  function shiftMonth(delta) {
    state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + delta, 1);
    state.calDay = null;
    renderCalendar();
  }

  function renderCalendar() {
    if (!state.calendarOpen) return;
    $("#cal-title").textContent = monthLabel(state.calMonth);

    const select = $("#cal-scope");
    select.replaceChildren();
    const options = [["ws", "Tous les spectacles de cet espace"]];
    if (state.workspaces.length > 1) options.push(["all", "Tous mes espaces"]);
    for (const room of state.ws ? roomsOfWs(state.ws.id) : []) options.push([room.id, room.name]);
    for (const [value, text] of options) {
      const option = el("option", "", text);
      option.value = value;
      select.append(option);
    }
    if (!options.some(([value]) => value === state.calScope)) state.calScope = "ws";
    select.value = state.calScope;

    const labels = $("#cal-days");
    labels.replaceChildren();
    for (let i = 0; i < 7; i++) labels.append(el("span", "", weekdayShort(addDays(mondayOf(new Date(2024, 0, 1)), i))));

    const tags = visibleCalendarTags();
    const month = state.calMonth.getMonth();
    const first = mondayOf(state.calMonth);
    const lastDay = new Date(state.calMonth.getFullYear(), month + 1, 0);
    const weeks = Math.ceil((mondayOf(lastDay) - first) / (7 * 86400000)) + 1;
    const lanes = assignLanes(tags);
    const grid = $("#cal-grid");
    grid.replaceChildren();
    const single = state.calScope !== "ws" && state.calScope !== "all";
    for (let w = 0; w < weeks; w++) {
      const days = Array.from({ length: 7 }, (_, i) => addDays(first, w * 7 + i));
      grid.append(weekGrid(days, tags, lanes, { month, showRoom: !single }));
    }
    if (!tags.length) grid.append(el("p", "muted empty-note", "Aucune date de tournée pour l'instant."));
    renderDayDetail(tags);
  }

  function renderDayDetail(tags) {
    const box = $("#cal-detail");
    box.replaceChildren();
    box.hidden = !state.calDay;
    if (!state.calDay) return;
    box.append(el("strong", "", fromISO(state.calDay).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })));
    const that = tags.filter(
      (t) => (t.start_date && state.calDay >= t.start_date && state.calDay <= t.end_date) || (t.shows || []).includes(state.calDay)
    );
    if (!that.length) box.append(el("p", "muted", "Rien de prévu ce jour-là."));
    for (const tag of that) {
      const row = el("button", "cal-detail-row");
      row.type = "button";
      row.dataset.openTag = tag.id;
      row.style.setProperty("--h", String(hueOfTag(tag)));
      const nShows = (tag.shows || []).filter((d) => d === state.calDay).length;
      const star = nShows ? ` ★ ${nShows > 1 ? nShows + " représentations" : "représentation"}` : "";
      row.append(el("span", "cal-swatch"), el("span", "", `${roomById(tag.room_id)?.name || ""} · ${tag.label}${star}`));
      box.append(row);
      for (const doc of docsOfTag(tag.id)) {
        const open = docLink(doc, "doc-open");
        open.append(docIcon(doc), el("span", "doc-name", doc.name), el("small", "muted", docMeta(doc)));
        box.append(open);
      }
    }
  }

  // Touche une frise : ouvre le spectacle sur cette date (en changeant d'espace si besoin).
  async function openTagFromCalendar(tagId, { filtered = true } = {}) {
    const tag = tagById(tagId);
    const room = tag && roomById(tag.room_id);
    if (!room) return;
    const sub = subsOfRoom(room.id)[0];
    if (!sub) return toast("Aucun sous-salon accessible dans ce spectacle.");
    state.pendingFilter = filtered ? tagId : null;
    if (!filtered) state.tagFilter = new Set(); // un filtre déjà posé dans ce spectacle est retiré aussi
    if (state.ws && room.workspace_id !== state.ws.id) await selectWorkspace(room.workspace_id, sub.id);
    else await selectChannel(sub.id);
  }

  // L'auteur raye son message (il reste lisible, barré) ou le rétablit.
  async function toggleStrike(id) {
    const message = state.messages.find((m) => m.id === id);
    if (!message || message.user_id !== user.id) return;
    const struck_at = message.struck_at ? null : new Date().toISOString();
    const { error } = await supabase.from("messages").update({ struck_at }).eq("id", id);
    if (error) return toast("Impossible de modifier le message : " + error.message);
    message.struck_at = struck_at;
    state.selectedId = null;
    renderMessages();
  }

  function startReply(id) {
    const message = state.messages.find((m) => m.id === id);
    if (!message) return;
    state.replyTo = message;
    state.selectedId = null;
    renderComposerExtra();
    renderMessages();
    $("#composer-input").focus();
  }

  function startQuote(id) {
    const message = state.messages.find((m) => m.id === id);
    if (!message) return;
    const input = $("#composer-input");
    const line = `> ${authorName(message.user_id)} : ${messageExcerpt(message, 140)}\n\n`;
    input.value = line + input.value.replace(/^(> .*\n)+\n?/, "");
    state.selectedId = null;
    renderMessages();
    autosize();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function jumpToMessage(id) {
    const target = [...document.querySelectorAll("#messages .msg")].find((node) => node.dataset.id === id);
    if (!target) return toast("Ce message est plus ancien que ceux qui sont affichés.");
    target.scrollIntoView({ block: "center" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1500);
  }

  // Saisie de « # » : propose les dates du salon ; le choix ajoute la date au message.
  let suggestIndex = 0;
  let suggestItems = [];

  function hashQuery() {
    const input = $("#composer-input");
    const before = input.value.slice(0, input.selectionStart ?? input.value.length);
    const match = before.match(/(^|\s)#([^\s#]*)$/);
    return match ? { query: match[2], start: before.length - match[2].length - 1 } : null;
  }

  function updateSuggest() {
    const roomId = currentRoomId();
    const found = roomId ? hashQuery() : null;
    if (!found) return hideSuggest();
    const q = plain(found.query);
    suggestItems = tagsOfRoom(roomId).filter(
      (tag) => !state.composerTags.has(tag.id) && plain(tagText(tag)).includes(q)
    );
    const box = $("#tag-suggest");
    box.replaceChildren();
    if (!suggestItems.length) return hideSuggest();
    suggestIndex = Math.min(suggestIndex, suggestItems.length - 1);
    suggestItems.forEach((tag, index) => {
      const item = el("li", "", tagText(tag));
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === suggestIndex));
      item.dataset.tag = tag.id;
      // mousedown : le choix se fait avant que le champ perde le focus
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        pickSuggest(tag.id);
      });
      box.append(item);
    });
    box.hidden = false;
  }

  function hideSuggest() {
    suggestIndex = 0;
    suggestItems = [];
    const box = $("#tag-suggest");
    box.hidden = true;
    box.replaceChildren();
  }

  function pickSuggest(id) {
    const found = hashQuery();
    if (!found || !tagById(id)) return hideSuggest();
    const input = $("#composer-input");
    const end = found.start + 1 + found.query.length;
    const token = "#" + tagById(id).label + " ";
    input.value = input.value.slice(0, found.start) + token + input.value.slice(end);
    const caret = found.start + token.length;
    input.setSelectionRange(caret, caret);
    state.composerTags.add(id);
    hideSuggest();
    renderComposerExtra();
    autosize();
    input.focus();
  }

  // Gestion des dates de tournée (administrateurs) --------------------------------

  let editingTag = null;
  let tagFormOpen = false; // formulaire masqué tant qu'on n'ajoute ni ne modifie rien

  function openTagsDialog() {
    const roomId = currentRoomId();
    if (!roomId || !isAdmin()) return;
    const room = roomById(roomId);
    $("#tags-title").textContent = `Dates de tournée · ${room.name}`;
    editingTag = null;
    tagFormOpen = false;
    resetTagForm();
    renderTagList();
    setNotice("#tags-message", "");
    openDialog("#dialog-tags");
  }

  let editingShows = []; // une entrée par représentation (un même jour peut en avoir plusieurs : matinée, soirée…)
  let rangePicker = null;
  let showsPicker = null;
  let pendingShowDay = null;

  const showCounts = () => {
    const counts = new Map();
    for (const iso of editingShows) counts.set(iso, (counts.get(iso) || 0) + 1);
    return counts;
  };

  // Mini-calendrier d'un mois : mark(iso, bouton) décore un jour ; onTap(iso) à l'appui ; onDrag(a, b) au glissé (facultatif).
  function makeMonthPicker(host, { mark, onTap, onDrag }, on) {
    let month = new Date();
    month = new Date(month.getFullYear(), month.getMonth(), 1);
    const head = el("div", "mini-cal-head");
    const prev = el("button", "ghost small mini-nav", "‹");
    const next = el("button", "ghost small mini-nav", "›");
    prev.type = next.type = "button";
    prev.setAttribute("aria-label", "Mois précédent");
    next.setAttribute("aria-label", "Mois suivant");
    const title = el("strong", "mini-title");
    head.append(prev, title, next);
    const week = el("div", "mini-cal-week");
    for (const d of ["L", "M", "M", "J", "V", "S", "D"]) week.append(el("span", "", d));
    const grid = el("div", "mini-cal-grid");
    host.replaceChildren(head, week, grid);

    function render() {
      title.textContent = month.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
      grid.replaceChildren();
      const lead = (month.getDay() + 6) % 7;
      for (let i = 0; i < lead; i++) grid.append(el("span", "mini-blank"));
      const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
      for (let d = 1; d <= days; d++) {
        const iso = toISO(new Date(month.getFullYear(), month.getMonth(), d));
        const button = el("button", "mini-day", String(d));
        button.type = "button";
        button.dataset.iso = iso;
        if (iso === toISO(new Date())) button.classList.add("is-today");
        mark(iso, button);
        grid.append(button);
      }
    }
    const go = (delta) => {
      month = new Date(month.getFullYear(), month.getMonth() + delta, 1);
      render();
    };
    on(prev, "click", () => go(-1));
    on(next, "click", () => go(1));

    let suppress = false;
    let anchor = null;
    let dragged = false;
    const dayAt = (event) => {
      const node = document.elementFromPoint ? document.elementFromPoint(event.clientX, event.clientY) : event.target;
      return node && node.closest ? node.closest(".mini-day") : null;
    };
    if (onDrag) {
      on(grid, "pointerdown", (event) => {
        const day = event.target.closest && event.target.closest(".mini-day");
        anchor = day ? day.dataset.iso : null;
        dragged = false;
      });
      on(grid, "pointermove", (event) => {
        if (!anchor) return;
        const day = dayAt(event);
        if (!day || (day.dataset.iso === anchor && !dragged)) return;
        dragged = true;
        const [a, b] = anchor <= day.dataset.iso ? [anchor, day.dataset.iso] : [day.dataset.iso, anchor];
        onDrag(a, b);
      });
      const finish = () => {
        if (dragged) {
          suppress = true;
          setTimeout(() => (suppress = false), 60);
        }
        anchor = null;
        dragged = false;
      };
      on(grid, "pointerup", finish);
      on(grid, "pointercancel", finish);
    }
    on(grid, "click", (event) => {
      const day = event.target.closest(".mini-day");
      if (!day || suppress) return;
      onTap(day.dataset.iso);
    });
    return {
      render,
      goTo(iso) {
        const d = iso ? fromISO(iso) : new Date();
        month = new Date(d.getFullYear(), d.getMonth(), 1);
        render();
      },
    };
  }

  function setRange(start, end) {
    $("#tag-start").value = start || "";
    $("#tag-end").value = end || "";
    renderRangeSummary();
    rangePicker.render();
    showsPicker.render();
  }

  function renderRangeSummary() {
    const start = $("#tag-start").value;
    const end = $("#tag-end").value;
    const f = (iso) => fromISO(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
    $("#tag-range-summary").textContent = !start
      ? "Aucun jour choisi."
      : !end
        ? `Début : ${f(start)} — touche le dernier jour (ou le même jour s'il n'y en a qu'un).`
        : start === end
          ? `Le ${f(start)}`
          : `Du ${f(start)} au ${f(end)}`;
  }

  function resetTagForm() {
    $("#tag-label").value = editingTag ? editingTag.label : "";
    $("#tag-start").value = editingTag?.start_date || "";
    $("#tag-end").value = editingTag?.end_date || "";
    editingShows = [...(editingTag?.shows || [])].sort();
    pendingShowDay = null;
    $("#show-choice").hidden = true;
    $("#tag-add").textContent = editingTag ? "Enregistrer" : "Ajouter";
    const formShown = tagFormOpen || !!editingTag;
    $("#tags-form").hidden = !formShown;
    $("#tag-new").hidden = formShown;
    if (rangePicker) {
      rangePicker.goTo($("#tag-start").value || null);
      showsPicker.goTo(editingShows[0] || $("#tag-start").value || null);
      renderRangeSummary();
    }
    renderShowChips();
  }

  function renderShowChips() {
    const box = $("#tag-shows");
    box.replaceChildren();
    for (const [iso, n] of [...showCounts()].sort()) {
      const chip = el("button", "tag-chip on", "★ " + shortDate(iso) + (n > 1 ? ` ×${n}` : ""));
      chip.type = "button";
      chip.dataset.show = iso;
      chip.append(el("small", "", "×"));
      chip.setAttribute("aria-label", "Retirer une représentation du " + shortDate(iso));
      box.append(chip);
    }
    $("#tag-shows-count").textContent = editingShows.length ? `(${editingShows.length})` : "";
    if (showsPicker) showsPicker.render();
  }

  function tapRange(iso) {
    const start = $("#tag-start").value;
    const end = $("#tag-end").value;
    if (!start || end) return setRange(iso, ""); // nouveau début
    if (iso < start) return setRange(iso, start);
    setRange(start, iso);
  }

  function tapShow(iso) {
    const n = showCounts().get(iso) || 0;
    if (!n) {
      editingShows.push(iso);
      editingShows.sort();
      return renderShowChips();
    }
    pendingShowDay = iso;
    $("#show-choice-text").textContent = `Le ${shortDate(iso)} compte déjà ${n} représentation${n > 1 ? "s" : ""}.`;
    $("#show-choice").hidden = false;
  }

  function answerShowChoice(choice) {
    const iso = pendingShowDay;
    pendingShowDay = null;
    $("#show-choice").hidden = true;
    if (!iso) return;
    if (choice === "add") editingShows.push(iso);
    if (choice === "remove") {
      const at = editingShows.indexOf(iso);
      if (at >= 0) editingShows.splice(at, 1);
    }
    editingShows.sort();
    renderShowChips();
  }

  function setupTagPickers(on) {
    rangePicker = makeMonthPicker($("#tag-range-picker"), {
      mark(iso, button) {
        const start = $("#tag-start").value;
        const end = $("#tag-end").value || start;
        if (start && iso >= start && iso <= end) button.classList.add("in-range");
        if (iso === start) button.classList.add("range-start");
        if (end && iso === end) button.classList.add("range-end");
      },
      onTap: tapRange,
      onDrag: (a, b) => setRange(a, b),
    }, on);
    showsPicker = makeMonthPicker($("#tag-shows-picker"), {
      mark(iso, button) {
        const start = $("#tag-start").value;
        const end = $("#tag-end").value || start;
        if (start && iso >= start && iso <= end) button.classList.add("in-range");
        const n = showCounts().get(iso) || 0;
        if (n) {
          button.classList.add("has-show");
          button.append(el("small", "mini-star", n > 1 ? `★${n}` : "★"));
        }
      },
      onTap: tapShow,
    }, on);
    rangePicker.render();
    showsPicker.render();
    renderRangeSummary();
  }

  function renderTagList() {
    const list = $("#tags-list");
    list.replaceChildren();
    const tags = tagsOfRoom(currentRoomId());
    if (!tags.length) list.append(el("li", "muted", "Aucune date pour l'instant."));
    for (const tag of tags) {
      const row = el("li", "tag-row");
      if (tagIsPast(tag)) row.classList.add("is-past");
      const text = el("span", "tag-row-text");
      text.append(el("strong", "", tag.label));
      const days = shortRange(tag);
      text.append(el("small", "muted", days || "sans date"));
      row.append(text);
      const edit = el("button", "ghost small tag-row-btn", "✎");
      edit.type = "button";
      edit.dataset.edit = tag.id;
      edit.setAttribute("aria-label", "Modifier " + tag.label);
      edit.title = "Modifier";
      const del = el("button", "ghost small tag-row-btn", "×");
      del.type = "button";
      del.dataset.del = tag.id;
      del.setAttribute("aria-label", "Supprimer " + tag.label);
      del.title = "Supprimer";
      row.append(edit, del);
      list.append(row);
    }
  }

  async function submitTag(event) {
    event.preventDefault();
    const roomId = currentRoomId();
    const label = $("#tag-label").value.trim().replace(/^#+\s*/, "");
    let start = $("#tag-start").value;
    let end = $("#tag-end").value;
    if (!label) return setNotice("#tags-message", "Donne un nom à la date.");
    if (start && !end) end = start;
    if (end && !start) start = end;
    if (start && end < start) return setNotice("#tags-message", "La fin doit être le même jour que le début, ou après.");
    const fields = { label, start_date: start || null, end_date: end || null, shows: [...editingShows].sort() };
    const request = editingTag
      ? supabase.from("tour_tags").update(fields).eq("id", editingTag.id).select().single()
      : supabase.from("tour_tags").insert({ room_id: roomId, ...fields }).select().single();
    const { data, error } = await request;
    if (error) {
      setNotice("#tags-message", error.code === "23505" ? "Une date porte déjà ce nom dans ce spectacle." : "Enregistrement impossible : " + error.message);
      return;
    }
    state.tags = state.tags.filter((t) => t.id !== data.id).concat(data);
    editingTag = null;
    tagFormOpen = false;
    resetTagForm();
    setNotice("#tags-message", "");
    renderTagList();
    renderTagBar();
    renderMessages();
    if (state.calendarOpen) renderCalendar();
  }

  async function deleteTag(id) {
    const tag = tagById(id);
    if (!tag) return;
    const nDocs = docsOfTag(id).length;
    const docsNote = nDocs ? ` Ses ${nDocs} PDF seront aussi supprimés.` : "";
    if (!window.confirm(`Supprimer la date « ${tag.label} » ? Elle sera retirée des messages qui la portent.${docsNote} Cette action est définitive.`)) return;
    const docPaths = docsOfTag(id).map((d) => d.path);
    const { error } = await supabase.from("tour_tags").delete().eq("id", id);
    if (error) return setNotice("#tags-message", "Suppression impossible : " + error.message);
    removeTagDocuments(supabase, docPaths);
    state.tagDocs = state.tagDocs.filter((d) => d.tag_id !== id);
    state.tags = state.tags.filter((t) => t.id !== id);
    state.tagFilter.delete(id);
    state.composerTags.delete(id);
    state.messages = state.messages.map((m) => ({ ...m, tag_ids: (m.tag_ids || []).filter((t) => t !== id) }));
    if (editingTag && editingTag.id === id) {
      editingTag = null;
      tagFormOpen = false;
      resetTagForm();
    }
    renderTagList();
    renderTagBar();
    renderComposerExtra();
    renderMessages();
    if (state.calendarOpen) renderCalendar();
  }

  async function deleteMessage(id, ask = true) {
    if (ask && !window.confirm("Supprimer ce message ? Cette action est définitive.")) return false;
    const target = state.messages.find((m) => m.id === id);
    const { error } = await supabase.from("messages").delete().eq("id", id);
    if (error) {
      toast("Suppression impossible : " + error.message);
      return false;
    }
    if (target && target.attachments && target.attachments.length) {
      removeMessageImages(supabase, target.attachments.map((a) => a.path).filter(Boolean));
    }
    removeMessage(id);
    return true;
  }

  function autosize() {
    const input = $("#composer-input");
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }

  // --- Boîtes de dialogue : espaces ----------------------------------------------

  function openSwitch() {
    if (!state.workspaces.length) return state.isSuper ? openWorkspaceDialog() : undefined;
    renderSwitchList();
    openDialog("#dialog-switch");
  }

  function refreshWorkspaceSwatches() {
    const dialog = $("#dialog-workspace");
    const theme = themeByKey(pendingTheme) || DEFAULT_THEME;
    dialog.style.setProperty("--h", String(theme.hue)); // aperçu en direct de la couleur choisie
    renderSwatches($("#workspace-colors"), pendingTheme, (key) => {
      pendingTheme = key;
      refreshWorkspaceSwatches();
    });
  }

  function openWorkspaceDialog() {
    if (!state.isSuper) return;
    const switcher = $("#dialog-switch");
    if (switcher.hasAttribute("open")) closeDialog(switcher);
    $("#workspace-name").value = "";
    setNotice("#workspace-message", "");
    const used = state.workspaces.map((ws) => themeFor(ws).key);
    pendingTheme = pickUnusedTheme(used, `${user.id}:${state.workspaces.length}`).key;
    refreshWorkspaceSwatches();
    openDialog("#dialog-workspace");
    $("#workspace-name").focus();
  }

  async function submitWorkspace(event) {
    event.preventDefault();
    const name = $("#workspace-name").value.trim();
    if (!name) return setNotice("#workspace-message", "Donne un nom à l'espace.");

    const button = $("#workspace-submit");
    button.disabled = true;
    setNotice("#workspace-message", "");

    let result = await supabase.from("workspaces").insert({ name, theme: pendingTheme }).select().single();
    if (result.error && /theme/i.test(result.error.message)) {
      state.themeColumn = false;
      result = await supabase.from("workspaces").insert({ name }).select().single();
    }
    const { data, error } = result;
    if (error) {
      button.disabled = false;
      return setNotice("#workspace-message", "Création impossible : " + error.message);
    }
    // Le créateur est devenu administrateur (trigger SQL) : on crée un premier salon et son sous-salon « Tous ».
    const roomId = newId();
    const room = await supabase.from("rooms").insert({ id: roomId, workspace_id: data.id, name: "Général", everyone: true });
    if (!room.error) {
      await supabase.from("channels").insert({ id: newId(), workspace_id: data.id, room_id: roomId, name: "Général", everyone: true });
    }
    button.disabled = false;
    closeDialog($("#dialog-workspace"));
    if (!state.themeColumn) toast(THEME_SQL_HINT, "info");
    await loadWorkspaces(data.id);
  }

  function renderSpacePhoto() {
    $("#space-photo-section").hidden = !isAdmin();
    $("#space-photo-hint").hidden = state.avatarColumn;
    $("#space-photo-pick").disabled = !state.avatarColumn;
    if (!state.ws) return;
    fillWsAvatar($("#space-photo"), state.ws);
    $("#space-photo-remove").hidden = !safeAvatarUrl(state.ws.avatar);
  }

  async function pickSpacePhoto(file) {
    if (!file || !state.ws || !isAdmin()) return;
    if (!state.avatarColumn) return setNotice("#members-message", "Exécute d'abord la migration 007 dans Supabase (README).");
    if (!/^image\//.test(file.type)) return setNotice("#members-message", "Choisis une image.");
    setNotice("#members-message", "Envoi de la photo…", "ok");
    try {
      const url = await uploadWorkspaceAvatar(supabase, state.ws.id, file);
      setWsAvatar(url);
      setNotice("#members-message", "Photo de l'espace enregistrée.", "ok");
    } catch (error) {
      const hint = /bucket|not found|policy|row-level|avatar_url/i.test(error.message || "") ? " (exécute la migration 007)" : "";
      setNotice("#members-message", "Photo non enregistrée : " + (error.message || error) + hint);
    }
  }

  async function removeSpacePhoto() {
    if (!state.ws || !isAdmin()) return;
    try {
      await removeWorkspaceAvatar(supabase, state.ws.id);
      setWsAvatar("");
      setNotice("#members-message", "Photo retirée.", "ok");
    } catch (error) {
      setNotice("#members-message", "Impossible de retirer la photo : " + (error.message || error));
    }
  }

  function setWsAvatar(url) {
    state.ws.avatar = url;
    const known = state.workspaces.find((w) => w.id === state.ws.id);
    if (known) known.avatar = url;
    renderSpacePhoto();
    renderWorkspaceHeader();
    renderSwitchList();
  }

  function renderThemeSettings() {
    renderSpacePhoto();
    $("#theme-section").hidden = !isAdmin();
    if (!isAdmin()) return;
    renderSwatches($("#theme-swatches"), themeFor(state.ws).key, changeTheme);
  }

  async function changeTheme(key) {
    if (!state.ws || !isAdmin()) return;
    const { error } = await supabase.from("workspaces").update({ theme: key }).eq("id", state.ws.id);
    if (error) {
      toast(/theme/i.test(error.message) ? THEME_SQL_HINT : "Couleur non enregistrée : " + error.message);
      return;
    }
    state.ws.theme = key;
    applyTheme();
    renderSwitchList();
    renderThemeSettings();
  }

  // --- Boîtes de dialogue : salons ------------------------------------------------

  // Utilisateurs (non administrateurs) de l'espace courant, pour choisir qui a accès à un salon.
  async function workspaceUsers(wsId) {
    const { data, error } = await supabase.from("workspace_members").select("user_id, role").eq("workspace_id", wsId);
    if (error) return [];
    await ensureProfiles((data || []).map((row) => row.user_id));
    return (data || []).slice().sort((a, b) => authorName(a.user_id).localeCompare(authorName(b.user_id), "fr"));
  }

  function renderPick(container, rows, checkedIds) {
    container.replaceChildren();
    for (const row of rows) {
      const item = el("li");
      const label = el("label", "pick-row");
      const box = el("input");
      box.type = "checkbox";
      box.value = row.user_id;
      box.checked = checkedIds.has(row.user_id);
      label.append(box, avatarFor(row.user_id, "small soft"), el("span", "pick-name", authorName(row.user_id)));
      if (row.role === "admin") label.append(el("span", "badge", "Admin"));
      item.append(label);
      container.append(item);
    }
  }

  const accessMode = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value || "everyone";

  // Utilisateurs (non administrateurs) qui ont accès à un salon : base du choix pour ses sous-salons.
  async function roomUsers(room) {
    const users = (await workspaceUsers(state.ws.id)).filter((row) => row.role !== "admin");
    if (room.everyone) return users;
    const { data } = await supabase.from("room_members").select("user_id").eq("room_id", room.id);
    const ids = new Set((data || []).map((row) => row.user_id));
    return users.filter((row) => ids.has(row.user_id));
  }

  // Aligne une table d'assignations (room_members ou channel_members) sur la liste cochée.
  async function syncMembers(table, keyColumn, keyValue, wanted) {
    const { data: current } = await supabase.from(table).select("user_id").eq(keyColumn, keyValue);
    const have = new Set((current || []).map((row) => row.user_id));
    const want = new Set(wanted);
    const added = [...want].filter((id) => !have.has(id));
    const removed = [...have].filter((id) => !want.has(id));
    if (added.length) await supabase.from(table).insert(added.map((id) => ({ [keyColumn]: keyValue, user_id: id })));
    if (removed.length) await supabase.from(table).delete().eq(keyColumn, keyValue).in("user_id", removed);
  }

  // --- Salons (spectacles) ---

  async function openRoomDialog(room) {
    if (!state.ws || !isAdmin()) return;
    editingRoom = room || null;
    $("#room-dialog-title").textContent = room ? "Spectacle" : "Nouveau spectacle";
    $("#room-submit").textContent = room ? "Enregistrer" : "Créer";
    $("#room-delete").hidden = !room;
    $("#room-name").value = room ? room.name : "";
    $("#room-description").value = room?.description || "";
    const mode = room && !room.everyone ? "some" : "everyone";
    for (const radio of document.querySelectorAll('input[name="room-access"]')) radio.checked = radio.value === mode;
    setNotice("#room-message", "");
    $("#room-pick").hidden = mode !== "some";
    openDialog("#dialog-room");
    $("#room-name").focus();

    let checked = new Set();
    if (room) {
      const { data } = await supabase.from("room_members").select("user_id").eq("room_id", room.id);
      checked = new Set((data || []).map((row) => row.user_id));
    }
    const users = (await workspaceUsers(state.ws.id)).filter((row) => row.role !== "admin");
    renderPick($("#room-pick"), users, checked);
  }

  async function submitRoom(event) {
    event.preventDefault();
    const name = $("#room-name").value.trim();
    const description = $("#room-description").value.trim();
    if (!name) return setNotice("#room-message", "Donne un nom au spectacle.");
    const everyone = accessMode("room-access") === "everyone";
    const picked = [...document.querySelectorAll("#room-pick input:checked")].map((box) => box.value);

    const button = $("#room-submit");
    button.disabled = true;
    setNotice("#room-message", "");
    const fail = (error) => {
      button.disabled = false;
      setNotice("#room-message", error.code === "23505" ? "Un spectacle porte déjà ce nom." : "Enregistrement impossible : " + error.message);
    };

    let room;
    let firstChannel = null;
    if (editingRoom) {
      const { data, error } = await supabase
        .from("rooms")
        .update({ name, description: description || null, everyone })
        .eq("id", editingRoom.id)
        .select()
        .single();
      if (error) return fail(error);
      room = data;
      if (!everyone) await syncMembers("room_members", "room_id", room.id, picked);
    } else {
      // Identifiant créé ici et pas de « .select() » : la règle de lecture ne voit pas encore la ligne en cours d'insertion.
      const roomId = newId();
      const { error } = await supabase
        .from("rooms")
        .insert({ id: roomId, workspace_id: state.ws.id, name, description: description || null, everyone });
      if (error) return fail(error);
      room = { id: roomId };
      if (!everyone && picked.length) {
        await supabase.from("room_members").insert(picked.map((id) => ({ room_id: room.id, user_id: id })));
      }
      // Chaque spectacle démarre avec son salon « Général » (la racine, ouverte à tous ceux qui ont accès au spectacle).
      const firstId = newId();
      const first = await supabase
        .from("channels")
        .insert({ id: firstId, workspace_id: state.ws.id, room_id: room.id, name: "Général", everyone: true });
      if (!first.error) firstChannel = { id: firstId };
    }

    button.disabled = false;
    const created = !editingRoom;
    editingRoom = null;
    closeDialog($("#dialog-room"));
    if (created) state.openRooms.add(room.id);
    await refreshStructure();
    if (created && firstChannel) await selectChannel(firstChannel.id);
  }

  async function deleteRoom() {
    if (!editingRoom) return;
    if (!window.confirm(`Supprimer le spectacle « ${editingRoom.name} », ses sous-salons et tous leurs messages ? Cette action est définitive.`)) return;
    const docPaths = [...docsOfRoom(editingRoom.id), ...sheetsOfRoom(editingRoom.id)].map((d) => d.path);
    const { error } = await supabase.from("rooms").delete().eq("id", editingRoom.id);
    if (error) return setNotice("#room-message", "Suppression impossible : " + error.message);
    removeTagDocuments(supabase, docPaths);
    closeDialog($("#dialog-room"));
    editingRoom = null;
    await refreshStructure();
  }

  // --- Sous-salons ---

  async function openChannelDialog(channel, roomId) {
    if (!state.ws || !isAdmin()) return;
    editingChannel = channel || null;
    channelRoomId = channel ? channel.room_id : roomId;
    const room = roomById(channelRoomId);
    if (!room) return;
    $("#channel-dialog-title").textContent = channel ? "Sous-salon" : "Nouveau sous-salon";
    $("#channel-room-note").textContent = `Dans le spectacle « ${room.name} ».`;
    $("#channel-everyone-label").textContent = room.everyone
      ? "Tous les utilisateurs de l'espace"
      : `Tous ceux qui ont accès à « ${room.name} »`;
    $("#channel-submit").textContent = channel ? "Enregistrer" : "Créer";
    $("#channel-delete").hidden = !channel || isRoot(channel);
    $("#channel-name").value = channel ? channel.name : "";
    $("#channel-description").value = channel?.description || "";
    const mode = channel && !channel.everyone ? "some" : "everyone";
    for (const radio of document.querySelectorAll('input[name="channel-access"]')) radio.checked = radio.value === mode;
    setNotice("#channel-message", "");
    $("#channel-pick").hidden = mode !== "some";
    openDialog("#dialog-channel");
    $("#channel-name").focus();

    let checked = new Set();
    if (channel) {
      const { data } = await supabase.from("channel_members").select("user_id").eq("channel_id", channel.id);
      checked = new Set((data || []).map((row) => row.user_id));
    }
    renderPick($("#channel-pick"), await roomUsers(room), checked);
  }

  async function submitChannel(event) {
    event.preventDefault();
    const name = $("#channel-name").value.trim().replace(/^#+\s*/, "");
    const description = $("#channel-description").value.trim();
    if (!name) return setNotice("#channel-message", "Donne un nom au sous-salon.");

    const everyone = accessMode("channel-access") === "everyone";
    const picked = [...document.querySelectorAll("#channel-pick input:checked")].map((box) => box.value);

    const button = $("#channel-submit");
    button.disabled = true;
    setNotice("#channel-message", "");

    let channel;
    if (editingChannel) {
      const { data, error } = await supabase
        .from("channels")
        .update({ name, description: description || null, everyone })
        .eq("id", editingChannel.id)
        .select()
        .single();
      if (error) return channelError(error, button);
      channel = data;
      // Ouvert à tous : les assignations n'ont plus d'effet, on les garde pour un éventuel retour.
      if (!everyone) await syncMembers("channel_members", "channel_id", channel.id, picked);
    } else {
      // L'identifiant est créé ici : on évite de relire la ligne juste après l'insertion
      // (la règle de lecture ne la « voit » pas encore et refuserait toute l'opération).
      const id = newId();
      const { error } = await supabase
        .from("channels")
        .insert({ id, workspace_id: state.ws.id, room_id: channelRoomId, name, description: description || null, everyone });
      if (error) return channelError(error, button);
      channel = { id };
      if (!everyone && picked.length) {
        await supabase.from("channel_members").insert(picked.map((id) => ({ channel_id: channel.id, user_id: id })));
      }
    }

    button.disabled = false;
    const created = !editingChannel;
    editingChannel = null;
    closeDialog($("#dialog-channel"));
    if (created) state.openRooms.add(channelRoomId);
    await refreshStructure();
    if (created) await selectChannel(channel.id);
  }

  function channelError(error, button) {
    button.disabled = false;
    const text = error.code === "23505" ? "Un sous-salon porte déjà ce nom dans ce spectacle." : "Enregistrement impossible : " + error.message;
    setNotice("#channel-message", text);
  }

  async function deleteChannel() {
    if (!editingChannel) return;
    if (!window.confirm(`Supprimer le sous-salon « ${editingChannel.name} » et tous ses messages ? Cette action est définitive.`)) return;
    const { error } = await supabase.from("channels").delete().eq("id", editingChannel.id);
    if (error) return setNotice("#channel-message", "Suppression impossible : " + error.message);
    closeDialog($("#dialog-channel"));
    editingChannel = null;
    await refreshStructure();
  }

  // --- Recherche dans les messages -----------------------------------------------------

  let searchTimer = null;
  let searchToken = 0;

  function openSearch(scope) {
    const select = $("#search-scope");
    select.querySelector('option[value="here"]').disabled = !state.channel;
    select.value = scope === "here" && state.channel ? "here" : "all";
    $("#search-status").textContent = "";
    $("#search-results").replaceChildren();
    openDialog("#dialog-search");
    $("#search-input").value = "";
    setTimeout(() => $("#search-input").focus(), 50);
  }

  function scheduleSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 300);
  }

  // Nom lisible du lieu d'un message : « Hamlet · Technique » ou « Message privé · Camille ».
  function placeOf(channel) {
    if (channel.kind === "dm") return "Message privé · " + channelTitle(channel);
    const room = roomById(channel.room_id);
    const ws = state.workspaces.length > 1 ? state.workspaces.find((w) => w.id === channel.workspace_id) : null;
    return [ws && ws.name, room && room.name, channel.name].filter(Boolean).join(" · ");
  }

  // Même texte sans accents ni majuscules, avec la position de chaque lettre dans le texte d'origine.
  function folded(text) {
    let out = "";
    const origin = [];
    let index = 0;
    for (const ch of String(text)) {
      const f = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      for (let k = 0; k < f.length; k++) {
        out += f[k];
        origin.push(index);
      }
      index += ch.length;
    }
    return { out, origin, length: index };
  }

  // Extrait autour de la première occurrence, occurrences surlignées (sans innerHTML), accents et majuscules ignorés.
  function highlighted(text, needle) {
    const box = el("span", "search-excerpt");
    const flat = String(text || "").replace(/\s+/g, " ").trim();
    const f = folded(flat);
    const key = folded(needle).out;
    const at = key ? f.out.indexOf(key) : -1;
    let from = 0;
    let to = flat.length;
    if (flat.length > 160 && at >= 0) {
      from = Math.max(0, f.origin[at] - 50);
      to = Math.min(flat.length, from + 160);
    } else if (flat.length > 160) {
      to = 160;
    }
    if (from > 0) box.append("…");
    let i = from;
    let pos = key ? f.out.indexOf(key) : -1;
    while (pos >= 0 && f.origin[pos] < from) pos = f.out.indexOf(key, pos + 1);
    while (pos >= 0 && f.origin[pos] < to) {
      const start = f.origin[pos];
      const endIndex = pos + key.length;
      const end = endIndex < f.origin.length ? f.origin[endIndex] : f.length;
      if (start > i) box.append(flat.slice(i, start));
      box.append(el("mark", "", flat.slice(start, Math.min(end, to))));
      i = Math.min(end, to);
      pos = f.out.indexOf(key, pos + key.length);
    }
    if (i < to) box.append(flat.slice(i, to));
    if (to < flat.length) box.append("…");
    return box;
  }

  async function runSearch() {
    const needle = $("#search-input").value.trim();
    const results = $("#search-results");
    const status = $("#search-status");
    const token = ++searchToken;
    if (needle.length < 2) {
      results.replaceChildren();
      status.textContent = needle ? "Tape au moins 2 caractères." : "";
      return;
    }
    status.textContent = "Recherche…";
    const scopeChannel = $("#search-scope").value === "here" && state.channel ? state.channel.id : null;
    // Recherche sans accents ni majuscules (migration 011) ; à défaut, simple recherche sans majuscules.
    let { data, error } = await supabase.rpc("search_messages", { needle, in_channel: scopeChannel, max_rows: 50 });
    if (error && /search_messages|PGRST202|42883|schema cache/i.test(`${error.code || ""} ${error.message || ""}`)) {
      const escaped = needle.replace(/[\\%_]/g, (m) => "\\" + m);
      let query = supabase.from("messages").select("id, channel_id, user_id, body, created_at").ilike("body", `%${escaped}%`).is("parent_id", null);
      if (scopeChannel) query = query.eq("channel_id", scopeChannel);
      ({ data, error } = await query.order("created_at", { ascending: false }).limit(50));
    }
    if (stopped || token !== searchToken) return;
    results.replaceChildren();
    if (error) {
      status.textContent = "Recherche impossible : " + error.message;
      return;
    }
    const rows = (data || []).filter((m) => state.allChannels.some((c) => c.id === m.channel_id));
    await ensureProfiles(rows.map((m) => m.user_id));
    if (stopped || token !== searchToken) return;
    status.textContent = rows.length ? (rows.length === 50 ? "50 résultats les plus récents." : `${rows.length} résultat${rows.length > 1 ? "s" : ""}.`) : "Aucun message trouvé.";
    for (const message of rows) {
      const channel = state.allChannels.find((c) => c.id === message.channel_id);
      const item = el("li");
      const button = el("button", "search-hit");
      button.type = "button";
      button.dataset.id = message.id;
      button.dataset.channel = message.channel_id;
      button.dataset.at = message.created_at;
      const meta = el("span", "search-meta");
      meta.append(el("strong", "", placeOf(channel)), ` · ${authorName(message.user_id)} · ${dayLabel(new Date(message.created_at))} ${timeFmt.format(new Date(message.created_at))}`);
      button.append(meta, highlighted(message.body, needle));
      item.append(button);
      results.append(item);
    }
  }

  async function openFoundMessage(button) {
    const channel = state.allChannels.find((c) => c.id === button.dataset.channel);
    if (!channel) return;
    closeDialog($("#dialog-search"));
    state.focus = { id: button.dataset.id, at: button.dataset.at };
    if (channel.kind !== "dm" && state.ws && channel.workspace_id !== state.ws.id) await selectWorkspace(channel.workspace_id, channel.id);
    else await selectChannel(channel.id);
  }

  function showMessage(id) {
    const node = document.querySelector(`#messages .msg[data-id="${id}"]`);
    if (!node) return;
    if (node.scrollIntoView) node.scrollIntoView({ block: "center" });
    node.classList.add("flash");
    setTimeout(() => node.classList.remove("flash"), 2400);
  }

  // --- Messages privés ----------------------------------------------------------------

  let dmCandidates = [];

  async function openDmPicker() {
    if (!state.ws) return;
    setNotice("#dm-message", "");
    $("#dm-search").value = "";
    openDialog("#dialog-dm");
    const people = (await workspaceUsers(state.ws.id)).filter((row) => row.user_id !== user.id).map((row) => row.user_id);
    // Les fils déjà ouverts d'abord (du plus récent au plus ancien), puis les autres personnes de l'espace.
    const threads = dms().map((channel) => ({ user_id: dmPartner(channel), thread: channel })).filter((c) => c.user_id);
    const withThread = new Set(threads.map((c) => c.user_id));
    const others = people
      .filter((id) => !withThread.has(id))
      .map((id) => ({ user_id: id, thread: null }))
      .sort((a, b) => authorName(a.user_id).localeCompare(authorName(b.user_id), "fr"));
    dmCandidates = [...threads, ...others];
    renderDmPick();
    setTimeout(() => $("#dm-search").focus(), 50);
  }

  function renderDmPick() {
    const list = $("#dm-pick");
    list.replaceChildren();
    const q = plain($("#dm-search").value.trim());
    const rows = dmCandidates.filter((c) => !q || plain(authorName(c.user_id)).includes(q));
    if (!rows.length) {
      list.append(el("li", "muted", dmCandidates.length ? "Personne ne correspond." : "Personne d'autre dans cet espace pour l'instant."));
      return;
    }
    for (const row of rows) {
      const item = el("li");
      const button = el("button", "pick-button");
      button.type = "button";
      button.dataset.user = row.user_id;
      if (row.thread) button.dataset.thread = row.thread.id;
      button.append(avatarFor(row.user_id, "small soft"), el("span", "pick-name", authorName(row.user_id)));
      if (row.thread) button.append(el("small", "muted", "discussion en cours"));
      item.append(button);
      list.append(item);
    }
  }

  // Supprime toute la discussion privée, pour les deux personnes.
  async function deleteDm() {
    const channel = state.channel;
    if (!channel || channel.kind !== "dm") return;
    const partner = dmPartner(channel);
    const name = partner ? authorName(partner) : "cette personne";
    if (!window.confirm(`Supprimer toute la discussion privée avec ${name} ? Tous les messages et photos disparaissent pour vous deux. Cette action est définitive.`)) return;
    await removeChannelImages(supabase, channel.id);
    const { error } = await supabase.from("channels").delete().eq("id", channel.id);
    if (error) {
      toast("Suppression impossible : " + error.message);
      return;
    }
    toast("Discussion supprimée.", "ok");
    await refreshStructure();
  }

  // Personnes qui ont accès au sous-salon ouvert ; un appui ouvre le message privé avec elles.
  async function openPeople() {
    const channel = state.channel;
    if (!channel || channel.kind !== "channel" || !state.ws) return;
    $("#people-title").textContent = `Personnes · ${channel.name}`;
    setNotice("#people-message", "");
    const list = $("#people-list");
    list.replaceChildren(el("li", "muted", "Chargement…"));
    openDialog("#dialog-people");

    const users = await workspaceUsers(state.ws.id);
    const room = roomById(channel.room_id);
    let allowed = null; // null : tous les non-administrateurs de l'espace
    if (!channel.everyone) {
      const { data } = await supabase.from("channel_members").select("user_id").eq("channel_id", channel.id);
      allowed = new Set((data || []).map((row) => row.user_id));
    } else if (room && !room.everyone) {
      const { data } = await supabase.from("room_members").select("user_id").eq("room_id", room.id);
      allowed = new Set((data || []).map((row) => row.user_id));
    }
    if (state.channel !== channel) return;
    const rows = users.filter((row) => row.role === "admin" || !allowed || allowed.has(row.user_id));
    list.replaceChildren();
    for (const row of rows) {
      const item = el("li");
      const button = el("button", "pick-button");
      button.type = "button";
      const me = row.user_id === user.id;
      button.disabled = me;
      button.dataset.user = row.user_id;
      button.append(avatarFor(row.user_id, "small soft"), el("span", "pick-name", authorName(row.user_id) + (me ? " (toi)" : "")));
      if (row.role === "admin") button.append(el("span", "badge", "Admin"));
      item.append(button);
      list.append(item);
    }
    if (!list.children.length) list.append(el("li", "muted", "Personne pour l'instant."));
  }

  async function startDm(otherId) {
    const existing = dms().find((c) => dmPartner(c) === otherId);
    if (existing) {
      closeDialog($("#dialog-dm"));
      await selectChannel(existing.id);
      return;
    }
    const { data, error } = await supabase.rpc("open_dm", { ws: state.ws.id, other: otherId });
    if (error) return setNotice("#dm-message", error.message);
    closeDialog($("#dialog-dm"));
    await refreshStructure();
    await selectChannel(data);
  }

  // --- Membres, rôles, invitations ---------------------------------------------------

  async function openMembers() {
    if (!state.ws) return;
    $("#members-title").textContent = state.ws.name;
    $("#open-invite").hidden = !isAdmin();
    setNotice("#members-message", "");
    renderThemeSettings();
    openDialog("#dialog-members");
    $("#members-title").focus(); // évite que la première pastille de couleur prenne le focus
    await refreshMembers();
  }

  async function refreshMembers() {
    const list = $("#members-list");
    const rows = await workspaceUsers(state.ws.id);
    list.replaceChildren();
    for (const row of rows) {
      const item = el("li", "member");
      const who = el("span", "member-who");
      who.append(avatarFor(row.user_id, "small soft"), el("span", "member-name", authorName(row.user_id)));
      item.append(who);

      const others = row.user_id !== user.id;
      if (isAdmin() && others) {
        const select = el("select", "role-select");
        select.dataset.user = row.user_id;
        select.setAttribute("aria-label", "Rôle de " + authorName(row.user_id));
        for (const [value, label] of [["member", "Utilisateur"], ["admin", "Administrateur"]]) {
          const option = el("option", "", label);
          option.value = value;
          option.selected = row.role === value;
          select.append(option);
        }
        const remove = el("button", "ghost small", "Retirer");
        remove.type = "button";
        remove.dataset.remove = row.user_id;
        item.append(select, remove);
      } else {
        item.append(el("span", "badge", roleLabel(row.role)));
      }
      list.append(item);
    }
  }

  async function changeRole(userId, role) {
    const { error } = await supabase
      .from("workspace_members")
      .update({ role })
      .eq("workspace_id", state.ws.id)
      .eq("user_id", userId);
    if (error) setNotice("#members-message", "Changement impossible : " + error.message);
    else setNotice("#members-message", "Rôle modifié.", "ok");
    await refreshMembers();
  }

  async function removeMember(userId) {
    if (!window.confirm(`Retirer ${authorName(userId)} de l'espace « ${state.ws.name} » ?`)) return;
    const { error } = await supabase
      .from("workspace_members")
      .delete()
      .eq("workspace_id", state.ws.id)
      .eq("user_id", userId);
    if (error) setNotice("#members-message", "Retrait impossible : " + error.message);
    else setNotice("#members-message", "Personne retirée de l'espace.", "ok");
    await refreshMembers();
  }

  // Espaces où je peux inviter : tous pour l'administrateur général, sinon ceux que j'administre.
  const invitableSpaces = () => state.workspaces.filter((ws) => state.isSuper || ws.role === "admin");

  // Liste déroulante : les personnes déjà présentes dans mes espaces (hors moi), avec leurs espaces.
  async function fillInvitePeople() {
    const select = $("#invite-person");
    select.length = 1;
    select.value = "";
    $("#invite-new").hidden = false;
    const ids = state.workspaces.map((ws) => ws.id);
    const { data } = await supabase.from("workspace_members").select("workspace_id, user_id").in("workspace_id", ids);
    const spacesOf = new Map();
    for (const row of data || []) {
      if (row.user_id === user.id) continue;
      const names = spacesOf.get(row.user_id) || [];
      names.push(state.workspaces.find((ws) => ws.id === row.workspace_id)?.name || "");
      spacesOf.set(row.user_id, names);
    }
    await ensureProfiles([...spacesOf.keys()]);
    const people = [...spacesOf.keys()].sort((a, b) => authorName(a).localeCompare(authorName(b), "fr"));
    for (const id of people) {
      const option = el("option", "", `${authorName(id)} · ${spacesOf.get(id).filter(Boolean).join(", ")}`);
      option.value = id;
      select.append(option);
    }
  }

  function openInvite() {
    if (!state.ws || !isAdmin()) return;
    $("#invite-email").value = "";
    $("#invite-name").value = "";
    fillInvitePeople();
    setNotice("#invite-message", "");
    const list = $("#invite-spaces");
    list.replaceChildren();
    for (const ws of invitableSpaces()) {
      const item = el("li", "invite-space");
      const label = el("label", "pick-row");
      const box = el("input");
      box.type = "checkbox";
      box.value = ws.id;
      box.checked = ws.id === state.ws.id;
      label.append(box, el("span", "pick-name", ws.name));
      const role = el("select", "role-select");
      role.dataset.ws = ws.id;
      role.setAttribute("aria-label", "Rôle dans " + ws.name);
      for (const [value, text] of [["member", "Utilisateur"], ["admin", "Administrateur"]]) {
        const option = el("option", "", text);
        option.value = value;
        role.append(option);
      }
      item.append(label, role);
      list.append(item);
    }
    renderInviteSalons();
    closeDialog($("#dialog-members"));
    openDialog("#dialog-invite");
    $("#invite-email").focus();
  }

  // Salons à accès restreint des espaces cochés (pour les rôles « utilisateur »).
  function renderInviteSalons() {
    const box = $("#invite-salons");
    const kept = new Set([...box.querySelectorAll("input:checked")].map((input) => input.value));
    box.replaceChildren();
    let any = false;
    for (const row of document.querySelectorAll("#invite-spaces .invite-space")) {
      const checkbox = row.querySelector("input");
      const role = row.querySelector("select").value;
      if (!checkbox.checked || role === "admin") continue;
      const wsId = checkbox.value;
      const rooms = roomsOfWs(wsId);
      const entries = [];
      for (const room of rooms) {
        if (!room.everyone) entries.push({ kind: "room", id: room.id, label: room.name });
        for (const sub of subsOfRoom(room.id)) {
          if (!sub.everyone) entries.push({ kind: "channel", id: sub.id, label: `${room.name} › ${sub.name}` });
        }
      }
      if (!entries.length) continue;
      any = true;
      const ws = state.workspaces.find((w) => w.id === wsId);
      const group = el("div", "invite-group");
      group.append(el("strong", "", ws.name));
      for (const entry of entries) {
        const label = el("label", "pick-row");
        const input = el("input");
        input.type = "checkbox";
        input.value = entry.id;
        input.dataset.ws = ws.id;
        input.dataset.kind = entry.kind;
        input.checked = kept.has(entry.id);
        label.append(input, el("span", "pick-name", entry.label));
        group.append(label);
      }
      box.append(group);
    }
    $("#invite-salons-box").hidden = !any;
  }

  async function functionMessage(error) {
    try {
      const body = await error.context.json();
      if (body && body.error) return body.error;
    } catch {
      /* pas de détail disponible */
    }
    return error.message || "Erreur inconnue";
  }

  async function submitInvite(event) {
    event.preventDefault();
    const personId = $("#invite-person").value;
    const email = personId ? "" : $("#invite-email").value.trim();
    const displayName = $("#invite-name").value.trim();
    if (!personId && !email) return setNotice("#invite-message", "Choisis une personne ou saisis son adresse e-mail.");

    const assignments = [];
    for (const row of document.querySelectorAll("#invite-spaces .invite-space")) {
      const checkbox = row.querySelector("input");
      if (!checkbox.checked) continue;
      const role = row.querySelector("select").value;
      const picked =
        role === "admin"
          ? []
          : [...document.querySelectorAll(`#invite-salons input[data-ws="${checkbox.value}"]:checked`)];
      assignments.push({
        workspace_id: checkbox.value,
        role,
        room_ids: picked.filter((i) => i.dataset.kind === "room").map((i) => i.value),
        channel_ids: picked.filter((i) => i.dataset.kind === "channel").map((i) => i.value),
      });
    }
    if (!assignments.length) return setNotice("#invite-message", "Choisis au moins un espace.");

    const button = $("#invite-submit");
    button.disabled = true;
    setNotice("#invite-message", "");

    const inviteBody = personId
      ? { user_id: personId, assignments }
      : { email, display_name: displayName, assignments, redirect_to: location.origin + location.pathname };
    let { data, error } = await supabase.functions.invoke("invite-member", { body: inviteBody });
    // Session expirée en arrière-plan : on la renouvelle et on réessaie une fois.
    if (error && error.context?.status === 401 && supabase.auth.refreshSession) {
      const refreshed = await supabase.auth.refreshSession();
      if (!refreshed.error && refreshed.data?.session) {
        ({ data, error } = await supabase.functions.invoke("invite-member", { body: inviteBody }));
      }
    }
    if (error && error.context?.status === 401) {
      button.disabled = false;
      return setNotice("#invite-message", "Ta session a expiré. Déconnecte-toi, reconnecte-toi, puis recommence l'invitation.");
    }

    if (error) {
      const notDeployed = error.name === "FunctionsFetchError" || error.context?.status === 404;
      if (notDeployed && personId) {
        button.disabled = false;
        return setNotice("#invite-message", "La fonction d'invitation doit être redéployée pour ajouter une personne depuis la liste (voir README).");
      }
      if (notDeployed) {
        // Repli : ajout direct si le compte existe déjà (la fonction « invite-member » n'est pas déployée).
        let failure = "";
        for (const a of assignments) {
          const result = await supabase.rpc("add_member_by_email", { ws: a.workspace_id, member_email: email, member_role: a.role });
          if (result.error) failure = result.error.message;
        }
        button.disabled = false;
        if (failure) {
          return setNotice(
            "#invite-message",
            "La fonction d'invitation n'est pas encore déployée (voir README, « Fonctions Supabase »). " + failure
          );
        }
        closeDialog($("#dialog-invite"));
        toast("Personne ajoutée (compte existant). Pour inviter de nouveaux comptes, déploie la fonction invite-member.", "info");
        await refreshStructure();
        return;
      }
      button.disabled = false;
      return setNotice("#invite-message", await functionMessage(error));
    }

    button.disabled = false;
    closeDialog($("#dialog-invite"));
    toast(data?.invited ? `Invitation envoyée à ${email}.` : `${email} a été ajouté(e).`, "ok");
    await refreshStructure();
  }

  // --- Profil ------------------------------------------------------------------------

  function renderMeFooter() {
    $("#me-name").textContent = authorName(user.id);
    const avatar = $("#me-avatar");
    const fresh = avatarFor(user.id, "small soft");
    avatar.className = fresh.className;
    avatar.replaceChildren(...fresh.childNodes);
  }

  function renderProfileAvatar() {
    const avatar = $("#profile-avatar");
    const fresh = avatarFor(user.id, "big soft");
    avatar.className = fresh.className;
    avatar.replaceChildren(...fresh.childNodes);
    $("#profile-remove").hidden = !safeAvatarUrl(state.profiles.get(user.id)?.avatar);
  }

  function openProfile() {
    $("#profile-name").value = authorName(user.id);
    $("#profile-email").value = user.email || "";
    setNotice("#profile-message", "");
    renderProfileAvatar();
    openDialog("#dialog-profile");
    $("#profile-title").focus();
  }

  async function pickPhoto(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) return setNotice("#profile-message", "Choisis une image.");
    setNotice("#profile-message", "Envoi de la photo…", "ok");
    try {
      const url = await uploadAvatar(supabase, user.id, file);
      const profile = state.profiles.get(user.id) || { name: fallbackName };
      state.profiles.set(user.id, { ...profile, avatar: url });
      setNotice("#profile-message", "Photo enregistrée.", "ok");
      renderProfileAvatar();
      renderMeFooter();
    } catch (error) {
      const hint = /bucket|not found/i.test(error.message || "") ? " (exécute la migration 003)" : "";
      setNotice("#profile-message", "Photo non enregistrée : " + (error.message || error) + hint);
    }
  }

  async function removePhoto() {
    try {
      await removeAvatar(supabase, user.id);
      const profile = state.profiles.get(user.id) || { name: fallbackName };
      state.profiles.set(user.id, { ...profile, avatar: "" });
      renderProfileAvatar();
      renderMeFooter();
      setNotice("#profile-message", "Photo retirée.", "ok");
    } catch (error) {
      setNotice("#profile-message", "Impossible de retirer la photo : " + (error.message || error));
    }
  }

  async function submitProfile(event) {
    event.preventDefault();
    const name = $("#profile-name").value.trim();
    const email = $("#profile-email").value.trim();
    if (!name) return setNotice("#profile-message", "Le nom affiché ne peut pas être vide.");
    if (!email) return setNotice("#profile-message", "Saisis une adresse e-mail.");

    const button = $("#profile-submit");
    button.disabled = true;
    const notes = [];
    try {
      if (name !== authorName(user.id)) {
        await saveName(supabase, user.id, name);
        const profile = state.profiles.get(user.id) || {};
        state.profiles.set(user.id, { ...profile, name });
        renderMeFooter();
        renderAll();
        notes.push("Nom enregistré.");
      }
      if (email.toLowerCase() !== (user.email || "").toLowerCase()) {
        await changeEmail(supabase, email);
        notes.push("Un e-mail de confirmation vient d'être envoyé : l'adresse changera quand tu auras cliqué sur le lien.");
      }
      setNotice("#profile-message", notes.join(" ") || "Rien à modifier.", "ok");
    } catch (error) {
      setNotice("#profile-message", "Enregistrement impossible : " + (error.message || error));
    }
    button.disabled = false;
  }

  // --- Notifications : appareil, silences ----------------------------------------------

  const PUSH_TEXT = {
    unsupported: "Ce navigateur ne gère pas les notifications push.",
    "needs-install": "Sur iPhone et iPad, installe d'abord l'application sur l'écran d'accueil pour recevoir des notifications.",
    unconfigured: "Les notifications push ne sont pas encore configurées sur le serveur (voir README, « Notifications push »).",
    denied: "Les notifications sont bloquées pour ce site : autorise-les dans les réglages du navigateur, puis reviens ici.",
    off: "Désactivées sur cet appareil : tu ne seras pas prévenu(e) quand l'application est fermée.",
    on: "Activées sur cet appareil.",
  };

  async function refreshPushStatus() {
    state.pushStatus = await pushStatus();
    renderPushStatus();
  }

  function renderPushStatus() {
    const status = state.pushStatus;
    let dismissed = false;
    try {
      dismissed = sessionStorage.getItem("tc-push-reminder") === "1";
    } catch {
      /* stockage indisponible : le rappel reste affiché */
    }
    const remind = (status === "off" || status === "denied") && !dismissed;
    $("#push-reminder").hidden = !remind;
    document.querySelector("#screen-app .chat").classList.toggle("has-reminder", remind);
    const off = status !== "on";
    $("#notif-ic").querySelector(".ic:first-child").style.display = off ? "none" : "inline";
    $("#notif-ic").querySelector(".ic:last-child").style.display = off ? "inline" : "none";
    $("#notif-label").textContent = status === "off" ? "Activer les notifications" : "Notifications";
    $("#open-notifications").classList.toggle("is-warn", status === "off");
    $("#me-menu-button").classList.toggle("is-warn", status === "off");
    const box = $("#push-box");
    if (!box) return;
    box.dataset.status = status;
    $("#push-status").textContent = PUSH_TEXT[status] || "";
    const toggle = $("#push-toggle");
    toggle.hidden = status !== "on" && status !== "off";
    toggle.textContent = status === "on" ? "Désactiver sur cet appareil" : "Activer sur cet appareil";
    toggle.classList.toggle("primary", status === "off");
    toggle.classList.toggle("ghost", status === "on");
    $("#push-install").hidden = status !== "needs-install";
  }

  async function togglePush() {
    setNotice("#notif-message", "");
    try {
      if (state.pushStatus === "on") await disablePush(supabase);
      else await enablePush(supabase);
    } catch (error) {
      const code = error && error.message;
      if (code === "denied") setNotice("#notif-message", "Autorisation refusée par le navigateur.");
      else setNotice("#notif-message", "Activation impossible : " + (code || error));
    }
    await refreshPushStatus();
  }

  function muteRow(scope, id, name, extra) {
    const row = state.mutes.get(muteKey(scope, id));
    const choice = choiceOf(row);
    const item = el("li", "mute-row");
    if (choice !== "off") item.classList.add("is-muted");
    const text = el("span", "mute-text");
    const title = el("strong", "");
    if (choice !== "off") title.append(icon("bell-off"), " ");
    title.append(name);
    text.append(title);
    const sub = muteLabel(row) || extra || "";
    if (sub) text.append(el("small", "", sub));
    const select = el("select", "mute-select");
    select.dataset.scope = scope;
    select.dataset.id = id;
    select.setAttribute("aria-label", "Notifications de " + name);
    for (const option of MUTE_CHOICES) {
      const node = el("option", "", option.label);
      node.value = option.key;
      node.selected = option.key === choice;
      select.append(node);
    }
    item.append(text, select);
    return item;
  }

  function renderMuteLists() {
    const spaces = $("#mute-spaces");
    spaces.replaceChildren();
    for (const ws of state.workspaces) spaces.append(muteRow("workspace", ws.id, ws.name, ""));

    const rooms = $("#mute-rooms");
    rooms.replaceChildren();
    const roomList = state.ws ? roomsOfWs(state.ws.id) : [];
    $("#mute-rooms-title").textContent = state.ws ? `Spectacles de « ${state.ws.name} »` : "Spectacles";
    for (const room of roomList) {
      const extra = isMuted(state.mutes, "workspace", room.workspace_id) ? "Espace en silence" : "";
      rooms.append(muteRow("room", room.id, room.name, extra));
    }
    if (!roomList.length) rooms.append(el("li", "muted", "Aucun spectacle."));

    // Sous-salons du salon ouvert.
    const current = state.channel && state.channel.kind === "channel" ? roomById(state.channel.room_id) : null;
    const channels = $("#mute-channels");
    channels.replaceChildren();
    const subs = current ? subsOfRoom(current.id) : [];
    $("#mute-salons-title").textContent = current ? `Sous-salons de « ${current.name} »` : "Sous-salons";
    for (const channel of subs) {
      let extra = "";
      if (isMuted(state.mutes, "workspace", channel.workspace_id)) extra = "Espace en silence";
      else if (isMuted(state.mutes, "room", channel.room_id)) extra = "Spectacle en silence";
      channels.append(muteRow("channel", channel.id, channel.name, extra));
    }
    $("#mute-salons-title").hidden = !current;
    channels.hidden = !current;

    const dmList = state.ws ? dms() : [];
    const dmBox = $("#mute-dms");
    dmBox.replaceChildren();
    for (const channel of dmList) {
      const extra = isMuted(state.mutes, "workspace", channel.workspace_id) ? "Espace en silence" : "";
      dmBox.append(muteRow("channel", channel.id, channelTitle(channel), extra));
    }
    $("#mute-dms-title").hidden = !dmList.length;
    dmBox.hidden = !dmList.length;
  }

  // Sourdine rapide d'un seul fil (menu ⋮) ; les réglages complets restent dans « Notifications ».
  function openChannelMute() {
    const channel = state.channel;
    if (!channel) return;
    $("#mute-title").textContent = `Sourdine · ${channelTitle(channel)}`;
    const current = choiceOf(state.mutes.get(muteKey("channel", channel.id)));
    const box = $("#mute-choices");
    box.replaceChildren();
    for (const option of MUTE_CHOICES) {
      const item = el("li");
      const button = el("button", "pick-button", "");
      button.type = "button";
      button.dataset.choice = option.key;
      button.append(el("span", "pick-name", option.key === "off" ? "Notifications activées" : option.label), el("span", "", option.key === current ? "✓" : ""));
      item.append(button);
      box.append(item);
    }
    const inherited = isMuted(state.mutes, "channel", channel.id) ? "" : muteLabel(mutedRowFor(channel));
    $("#mute-note").textContent = inherited ? `Ce fil suit déjà un silence plus large : ${inherited.toLowerCase()}.` : "Ne concerne que ce fil : les autres fils continuent de notifier.";
    openDialog("#dialog-mute");
  }

  function openNotifications() {
    setNotice("#notif-message", "");
    renderMuteLists();
    renderPushStatus();
    openDialog("#dialog-notifications");
    $("#notif-title").focus();
    refreshPushStatus();
  }

  async function setMute(scope, id, choice) {
    const fields = muteFromChoice(choice);
    const key = muteKey(scope, id);
    let error;
    if (!fields) {
      ({ error } = await supabase.from("notification_mutes").delete().eq("scope", scope).eq("target_id", id));
      if (!error) state.mutes.delete(key);
    } else {
      const row = { user_id: user.id, scope, target_id: id, ...fields };
      ({ error } = await supabase.from("notification_mutes").upsert(row, { onConflict: "user_id,scope,target_id" }));
      if (!error) state.mutes.set(key, row);
    }
    if (error) {
      setNotice("#notif-message", "Réglage non enregistré : " + error.message);
      return;
    }
    setNotice("#notif-message", "");
    renderMuteLists();
    renderBadges();
    renderHeader();
  }

  // Un silence qui se termine remet les pastilles et les icônes à jour sans rien faire.
  function watchExpiry() {
    clearInterval(expiryTimer);
    expiryTimer = setInterval(() => {
      if (stopped) return;
      const now = Date.now();
      if (state.pins.some((pin) => new Date(pin.expires_at).getTime() <= now)) {
        state.pins = state.pins.filter((pin) => new Date(pin.expires_at).getTime() > now);
        renderPinBar();
        renderMessages();
      }
      let changed = false;
      for (const [key, row] of state.mutes) {
        if (!row.forever && row.muted_until && new Date(row.muted_until).getTime() <= now) {
          state.mutes.delete(key);
          changed = true;
        }
      }
      if (changed) {
        renderBadges();
        renderHeader();
      }
    }, 30000);
  }

  // --- Branchement des événements ---------------------------------------------

  function bind() {
    if (controller) return;
    controller = new AbortController();
    const opts = { signal: controller.signal };
    const on = (target, type, handler) => target.addEventListener(type, handler, opts);

    on($("#workspace-button"), "click", openSwitch);
    on($("#switch-new"), "click", openWorkspaceDialog);
    on($("#ws-list"), "click", (event) => {
      const row = event.target.closest(".ws-row");
      if (!row) return;
      closeDialog($("#dialog-switch"));
      selectWorkspace(row.dataset.id);
    });
    on($("#new-channel"), "click", () => openRoomDialog(null));
    on($("#channel-delete-dm"), "click", deleteDm);
    on($("#channel-people"), "click", openPeople);
    on($("#move-list"), "click", (event) => {
      const button = event.target.closest("button[data-target]");
      if (button) moveMessage(button.dataset.target);
    });
    on($("#people-list"), "click", (event) => {
      const button = event.target.closest("button[data-user]");
      if (!button || button.disabled) return;
      closeDialog($("#dialog-people"));
      startDm(button.dataset.user);
    });
    on($("#channel-edit"), "click", () => state.channel && openChannelDialog(state.channel));
    on($("#room-delete"), "click", deleteRoom);
    on($("#room-form"), "submit", submitRoom);
    on($("#channel-delete"), "click", deleteChannel);
    on($("#new-dm"), "click", openDmPicker);
    // Roue crantée du profil : regroupe espace et membres, notifications, installation, déconnexion.
    const meMenu = (open) => {
      $("#me-menu").hidden = !open;
      $("#me-menu-button").setAttribute("aria-expanded", String(open));
    };
    on($("#me-menu-button"), "click", (e) => {
      e.stopPropagation();
      meMenu($("#me-menu").hidden);
    });
    on($("#me-menu"), "click", () => meMenu(false));
    on(document, "click", () => meMenu(false));
    on($("#open-members"), "click", openMembers);
    on($("#open-invite"), "click", openInvite);
    on($("#open-notifications"), "click", openNotifications);
    on($("#channel-bell"), "click", openChannelMute);
    on($("#mute-all-settings"), "click", () => {
      closeDialog($("#dialog-mute"));
      openNotifications();
    });
    on($("#pin-bar"), "click", () => jumpToPin());
    on($("#pin-choices"), "click", (event) => {
      const button = event.target.closest("[data-hours]");
      if (button) pinMessage(Number(button.dataset.hours));
    });
    on($("#mute-choices"), "click", async (event) => {
      const button = event.target.closest("[data-choice]");
      if (!button || !state.channel) return;
      await setMute("channel", state.channel.id, button.dataset.choice);
      closeDialog($("#dialog-mute"));
      const row = state.mutes.get(muteKey("channel", state.channel.id));
      toast(row && isMuted(state.mutes, "channel", state.channel.id) ? "Ce fil est en sourdine : " + muteLabel(row).toLowerCase() + "." : "Notifications de ce fil réactivées.", "ok");
    });
    on($("#push-reminder-open"), "click", openNotifications);
    on($("#push-reminder-close"), "click", () => {
      try {
        sessionStorage.setItem("tc-push-reminder", "1");
      } catch {
        /* sans conséquence */
      }
      renderPushStatus();
    });
    // Glisser vers la droite dans un fil : ouvre le menu (hors calendrier).
    onSwipe($("#messages"), (dir, origin) => {
      if (state.calendarOpen) return;
      const row = origin && origin.closest ? origin.closest(".msg") : null;
      if (dir < 0) {
        // Glisser un message vers la gauche : ses options (répondre, citer, transférer, rayer, déplacer, supprimer).
        if (row && !row.dataset.pending && !state.multi.size) {
          guardHistory(); // « Retour » désélectionne
          state.selectedId = row.dataset.id;
          renderMessages();
        }
      } else if (isMobile() && !state.multi.size) {
        guardHistory();
        $("#screen-app").classList.add("sidebar-open");
      }
    }, opts);
    // Glisser un message vers la gauche : il suit le doigt (comme sur WhatsApp) et se met en surbrillance.
    {
      const box = $("#messages");
      let drag = null;
      const settle = (row) => {
        if (!row) return;
        row.classList.remove("swiping", "armed");
        row.classList.add("swipe-back");
        row.style.transform = "";
        setTimeout(() => row.classList.remove("swipe-back"), 220);
      };
      on(box, "touchstart", (event) => {
        const touch = event.touches[0];
        const row = event.target.closest && event.target.closest(".msg");
        drag = row && event.touches.length === 1 && touch && !row.dataset.pending && !state.multi.size && !state.calendarOpen ? { row, x: touch.clientX, y: touch.clientY, on: false } : null;
      }, { passive: true });
      on(box, "touchmove", (event) => {
        const touch = event.touches[0];
        if (!drag || !touch) return;
        const dx = touch.clientX - drag.x;
        const dy = touch.clientY - drag.y;
        if (!drag.on) {
          if (dx < -10 && Math.abs(dx) > Math.abs(dy) * 1.2) drag.on = true;
          else return;
        }
        const pulled = Math.min(Math.max(-dx, 0), 110);
        drag.row.classList.add("swiping");
        drag.row.style.transform = `translateX(${-pulled * 0.55}px)`;
        const armed = pulled > 60;
        if (armed && !drag.row.classList.contains("armed") && navigator.vibrate) navigator.vibrate(10);
        drag.row.classList.toggle("armed", armed);
      }, { passive: true });
      const end = () => {
        if (drag) settle(drag.row);
        drag = null;
      };
      on(box, "touchend", end);
      on(box, "touchcancel", end);
    }
    on($("#open-profile"), "click", openProfile);
    on($("#open-help"), "click", () => {
      openDialog("#dialog-help");
      $("#help-title").focus();
    });
    on($("#empty-action"), "click", () => emptyAction && emptyAction());

    const openFromList = (event) => {
      const button = event.target.closest(".channel-item");
      if (button) selectChannel(button.dataset.id);
    };
    on($("#channel-list"), "click", (event) => {
      const edit = event.target.closest("[data-room-edit]");
      if (edit) return openRoomDialog(roomById(edit.dataset.roomEdit));
      const add = event.target.closest("[data-new-sub]");
      if (add) return openChannelDialog(null, add.dataset.newSub);
      const toggle = event.target.closest(".room-toggle, .room-chev");
      if (toggle) {
        const id = toggle.dataset.room;
        // Un salon qui contient le sous-salon ouvert reste déplié.
        if (state.openRooms.has(id)) state.openRooms.delete(id);
        else state.openRooms.add(id);
        writeOpen(state.openRooms);
        renderChannels();
        return;
      }
      openFromList(event);
    });
    on($("#dm-list"), "click", openFromList);
    on($("#reload-app"), "click", reloadApp);
    on($("#share-app"), "click", shareApp);
    on($("#dm-toggle"), "click", () => {
      state.dmOpen = !state.dmOpen;
      try {
        localStorage.setItem(DM_OPEN_KEY, state.dmOpen ? "1" : "0");
      } catch {
        /* préférence non gardée : sans conséquence */
      }
      renderDmToggle();
    });

    on($("#dm-search"), "input", renderDmPick);
    on($("#open-search"), "click", () => openSearch("all"));
    on($("#channel-search"), "click", () => openSearch("here"));
    on($("#channel-media"), "click", openMedia);
    on($("#channel-postits"), "click", openPostitTrash);
    on($("#attach-postit"), "click", () => {
      toggleAttachMenu(false);
      openPostitWrite(null);
    });
    on($("#open-todos"), "click", openTodos);
    on($("#attach-todo"), "click", () => {
      toggleAttachMenu(false);
      openTodoWrite(null);
    });
    on($("#todo-form"), "submit", submitTodo);
    on($("#todo-add-item"), "click", () => addTodoRow("", false, true));
    on($("#todo-items"), "click", (event) => {
      const remove = event.target.closest("button");
      if (!remove) return;
      const row = remove.closest("li");
      if ($("#todo-items").children.length > 1) row.remove();
      else row.querySelector("input").value = "";
    });
    on($("#todo-items"), "keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      addTodoRow("", false, true, event.target.closest("li"));
    });
    on($("#todo-title"), "keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const first = $("#todo-items").querySelector("input");
      if (first) first.focus();
    });
    on($("#postit-read-note"), "change", onTodoCheck);
    on($("#todos-list"), "change", onTodosCheck);
    on($("#todos-list"), "click", (event) => {
      const room = event.target.closest("[data-room]");
      if (room) {
        todoView.room = room.dataset.room;
        return renderTodos();
      }
      const where = event.target.closest("[data-channel]");
      if (where) {
        closeDialog($("#dialog-todos"));
        selectChannel(where.dataset.channel);
      }
    });
    on($("#todos-back"), "click", () => {
      todoView.room = null;
      renderTodos();
    });
    on($("#postit-form"), "submit", submitPostit);
    on($("#postit-input"), "input", () => {
      $("#postit-count").textContent = `${$("#postit-input").value.length} / ${POSTIT_MAX}`;
    });
    on($("#postit-wall"), "click", (event) => {
      const note = event.target.closest(".postit");
      if (note) peelPostit(note.dataset.id);
    });
    on($("#postit-throw"), "click", throwPostit);
    // Retoucher le Post-it ouvert suffit à le laisser collé.
    on($("#postit-read-note"), "click", (event) => {
      if (event.target.closest(".todo-item")) return; // cocher une case ne ferme pas la feuille
      if (!postitBusy) closeDialog($("#dialog-postit-read"));
    });
    on($("#postit-read-note"), "keydown", (event) => {
      if (event.target.closest(".todo-item")) return;
      if ((event.key === "Enter" || event.key === " ") && !postitBusy) {
        event.preventDefault();
        closeDialog($("#dialog-postit-read"));
      }
    });
    on($("#postit-edit"), "click", () => {
      const id = postitOpenId;
      if (!id || postitBusy) return;
      closeDialog($("#dialog-postit-read"));
      const target = postitById(id);
      if (target && isTodo(target)) openTodoWrite(id);
      else openPostitWrite(id);
    });
    on($("#postit-delete-all"), "click", deletePostitForAll);
    on($("#dialog-postit-read"), "close", stickBack);
    on($("#postit-empty"), "click", purgeAllPostits);
    on($("#postit-trash-list"), "click", (event) => {
      const restore = event.target.closest("[data-restore]");
      if (restore) return restorePostit(restore.dataset.restore);
      const purge = event.target.closest("[data-purge]");
      if (purge) purgePostit(purge.dataset.purge);
    });
    on($("#search-form"), "submit", (event) => {
      event.preventDefault();
      clearTimeout(searchTimer);
      runSearch();
    });
    on($("#search-input"), "input", scheduleSearch);
    on($("#search-scope"), "change", runSearch);
    on($("#search-results"), "click", (event) => {
      const button = event.target.closest(".search-hit");
      if (button) openFoundMessage(button);
    });
    on($("#dm-pick"), "click", (event) => {
      const button = event.target.closest("[data-user]");
      if (button) startDm(button.dataset.user);
    });

    for (const radio of document.querySelectorAll('input[name="channel-access"]')) {
      on(radio, "change", () => {
        $("#channel-pick").hidden = accessMode("channel-access") !== "some";
      });
    }
    for (const radio of document.querySelectorAll('input[name="room-access"]')) {
      on(radio, "change", () => {
        $("#room-pick").hidden = accessMode("room-access") !== "some";
      });
    }

    on($("#members-list"), "change", (event) => {
      const select = event.target.closest(".role-select");
      if (select) changeRole(select.dataset.user, select.value);
    });
    on($("#members-list"), "click", (event) => {
      const button = event.target.closest("[data-remove]");
      if (button) removeMember(button.dataset.remove);
    });
    on($("#invite-spaces"), "change", renderInviteSalons);

    on($("#mute-spaces"), "change", (event) => {
      const select = event.target.closest(".mute-select");
      if (select) setMute(select.dataset.scope, select.dataset.id, select.value);
    });
    for (const id of ["#mute-rooms", "#mute-channels", "#mute-dms"]) {
      on($(id), "change", (event) => {
        const select = event.target.closest(".mute-select");
        if (select) setMute(select.dataset.scope, select.dataset.id, select.value);
      });
    }
    on($("#push-toggle"), "click", togglePush);
    on($("#push-install"), "click", () => {
      closeDialog($("#dialog-notifications"));
      const guide = $("#open-install");
      if (guide) guide.click();
    });

    on($("#profile-pick"), "click", () => $("#profile-file").click());
    on($("#profile-file"), "change", (event) => {
      pickPhoto(event.target.files && event.target.files[0]);
      event.target.value = "";
    });
    on($("#profile-remove"), "click", removePhoto);
    on($("#space-photo-pick"), "click", () => $("#space-photo-file").click());
    on($("#space-photo-file"), "change", (event) => {
      pickSpacePhoto(event.target.files[0]);
      event.target.value = "";
    });
    on($("#space-photo-remove"), "click", removeSpacePhoto);
    on($("#profile-form"), "submit", submitProfile);

    // Appui long sur un message : début de la sélection multiple ; ensuite chaque appui coche ou décoche.
    let press = null;
    let swallowClick = false; // le relâchement d'un appui long ne doit pas compter comme un appui
    const cancelPress = () => {
      if (press) clearTimeout(press.timer);
      press = null;
    };
    on($("#messages"), "pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const row = event.target.closest && event.target.closest(".msg");
      if (!row || row.dataset.pending || event.target.closest("a, button, .msg-actions")) return;
      cancelPress();
      const id = row.dataset.id;
      press = {
        x: event.clientX,
        y: event.clientY,
        timer: setTimeout(() => {
          press = null;
          swallowClick = true;
          setTimeout(() => (swallowClick = false), 700);
          if (navigator.vibrate) navigator.vibrate(15);
          toggleMulti(id);
        }, 450),
      };
    });
    on($("#messages"), "pointermove", (event) => {
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancelPress();
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) on($("#messages"), type, cancelPress);
    on($("#messages"), "contextmenu", (event) => {
      if (event.target.closest && event.target.closest(".msg")) event.preventDefault(); // pas de menu du navigateur
    });
    on($("#select-cancel"), "click", clearMulti);
    // Mise en forme : sélectionne du texte puis touche G, I ou S (ou Ctrl+B / Ctrl+I) ; sans sélection, place les marqueurs autour du curseur.
    const field = $("#composer-input");
    const wrapSelection = (marker) => {
      let { selectionStart: a, selectionEnd: b, value } = field;
      while (a < b && /\s/.test(value[a])) a++;
      while (b > a && /\s/.test(value[b - 1])) b--;
      const around = value[a - 1] === marker && value[b] === marker;
      const inner = value.slice(a, b);
      let next;
      let caret;
      if (around) {
        next = value.slice(0, a - 1) + inner + value.slice(b + 1);
        caret = [a - 1, b - 1];
      } else if (inner) {
        next = value.slice(0, a) + marker + inner + marker + value.slice(b);
        caret = [a + 1, b + 1];
      } else {
        next = value.slice(0, a) + marker + marker + value.slice(b);
        caret = [a + 1, a + 1];
      }
      field.value = next;
      field.setSelectionRange(caret[0], caret[1]);
      field.dispatchEvent(new (field.ownerDocument.defaultView.Event)("input", { bubbles: true }));
      field.focus();
    };
    on(field, "focus", () => ($("#format-bar").dataset.show = "1"));
    on(field, "blur", () => delete $("#format-bar").dataset.show);
    for (const button of [...document.querySelectorAll("#format-bar [data-format]")]) {
      on(button, "pointerdown", (event) => event.preventDefault()); // garde le clavier ouvert et la sélection
      on(button, "click", () => wrapSelection(button.dataset.format));
    }
    on(field, "keydown", (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const marker = { b: "*", i: "_" }[event.key.toLowerCase()];
      if (!marker) return;
      event.preventDefault();
      wrapSelection(marker);
    });
    on($("#select-delete"), "click", deleteSelected);
    on($("#select-strike"), "click", strikeSelected);
    on($("#select-move"), "click", () => openMove([...state.multi]));
    on($("#select-copy"), "click", () => copyMessages([...state.multi]));
    on($("#select-forward"), "click", () => openForward([...state.multi]));
    on($("#forward-list"), "click", (event) => {
      const button = event.target.closest("[data-target]");
      if (button) forwardMessages(button.dataset.target);
    });

    on($("#messages"), "click", (event) => {
      if (swallowClick) {
        swallowClick = false;
        return;
      }
      if (state.multi.size) {
        const picked = event.target.closest(".msg");
        if (event.target.closest("a")) event.preventDefault();
        if (picked && !picked.dataset.pending) toggleMulti(picked.dataset.id);
        return;
      }
      const pend = event.target.closest("[data-pending-action]");
      if (pend) return pendingAction(pend.dataset.pendingAction, pend.dataset.id);
      const remove = event.target.closest("[data-action='delete']");
      if (remove) return deleteMessage(remove.dataset.id);
      const reply = event.target.closest("[data-action='reply']");
      if (reply) return startReply(reply.dataset.id);
      const quote = event.target.closest("[data-action='quote']");
      if (quote) return startQuote(quote.dataset.id);
      const strike = event.target.closest("[data-action='strike']");
      if (strike) return toggleStrike(strike.dataset.id);
      const move = event.target.closest("[data-action='move']");
      if (move) return openMove(move.dataset.id);
      const edit = event.target.closest("[data-action='edit']");
      if (edit) return startEdit(edit.dataset.id);
      const copy = event.target.closest("[data-action='copy']");
      if (copy) return copyMessages([copy.dataset.id]);
      const pin = event.target.closest("[data-action='pin']");
      if (pin) return openPin(pin.dataset.id);
      const unpin = event.target.closest("[data-action='unpin']");
      if (unpin) return unpinMessage(unpin.dataset.id);
      const forward = event.target.closest("[data-action='forward']");
      if (forward) return openForward([forward.dataset.id]);
      const pill = event.target.closest(".hash-pill");
      if (pill) return toggleTagFilter(pill.dataset.tag);
      const jump = event.target.closest(".msg-quote");
      if (jump) return jumpToMessage(jump.dataset.reply);
      if (event.target.closest("a")) return; // un lien s'ouvre, sans sélectionner le message
      // Toucher un message le sélectionne (affiche Répondre, Citer, Supprimer) ; toucher ailleurs désélectionne.
      const row = event.target.closest(".msg");
      if (row && row.dataset.pending) return;
      const next = row && state.selectedId !== row.dataset.id ? row.dataset.id : null;
      if (next === state.selectedId) return;
      if (next) guardHistory(); // « Retour » désélectionne
      state.selectedId = next;
      renderMessages();
    });

    on($("#composer"), "submit", (event) => {
      event.preventDefault();
      sendMessage();
    });

    const input = $("#composer-input");
    on(input, "input", () => {
      autosize();
      updateSuggest();
    });
    on(input, "blur", () => setTimeout(hideSuggest, 120));
    on(input, "paste", (event) => {
      const files = [...((event.clipboardData && event.clipboardData.files) || [])].filter((f) => /^image\//.test(f.type));
      if (!files.length) return; // du texte : collage normal
      event.preventDefault();
      addImages(files);
    });
    if (!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches)) $("#attach-camera").hidden = true;
    on($("#composer-attach"), "click", () => toggleAttachMenu());
    on($("#attach-photo"), "click", () => {
      toggleAttachMenu(false);
      $("#file-photo").click();
    });
    on($("#attach-camera"), "click", () => {
      toggleAttachMenu(false);
      $("#file-camera").click();
    });
    for (const id of ["#file-photo", "#file-camera"]) {
      on($(id), "change", (event) => {
        addImages(event.target.files);
        event.target.value = "";
      });
    }
    on($("#lightbox-close"), "click", () => closeDialog($("#dialog-image")));
    on($("#dialog-image"), "click", () => closeDialog($("#dialog-image")));
    on(document, "click", (event) => {
      if (!$("#attach-menu").hidden && !event.target.closest("#attach-menu, #composer-attach")) toggleAttachMenu(false);
    });
    on($("#reply-cancel"), "click", () => {
      if (state.editing) return cancelEdit();
      state.replyTo = null;
      renderComposerExtra();
    });
    on($("#channel-dates"), "click", openTagsDialog);
    on($("#tags-toggle"), "click", () => setDatesOpen(!datesOpen()));
    on($("#tag-filter"), "click", (event) => {
      const badge = event.target.closest("[data-docs-tag]");
      if (badge) openDocs(badge.dataset.docsTag);
    });
    on($("#room-sheet"), "click", openSheet);
    on($("#sheet-list"), "click", (event) => {
      const del = event.target.closest("[data-del-sheet]");
      if (del) deleteSheet(del.dataset.delSheet);
    });
    on($("#sheet-pick"), "click", () => {
      if (!$("#sheet-date").value) return setNotice("#sheet-message", "Indique d'abord la date de la version.");
      $("#sheet-file").click();
    });
    on($("#sheet-file"), "change", (event) => {
      const files = [...event.target.files];
      event.target.value = "";
      addSheetFiles(files);
    });
    on($("#sheet-add-link"), "click", addSheetLink);
    on($("#sheet-url"), "keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addSheetLink();
      }
    });
    on($("#open-current"), "click", openCurrent);
    on($("#channel-current"), "click", openCurrent);
    on($("#current-list"), "click", async (event) => {
      const go = event.target.closest("[data-go-tag]");
      if (go) {
        closeDialog($("#dialog-current"));
        closeSidebar();
        await openTagFromCalendar(go.dataset.goTag, { filtered: false }); // « Ouvrir le spectacle » : le fil, sans filtre de date
      }
    });
    on($("#docs-list"), "click", (event) => {
      const add = event.target.closest("[data-add-doc]");
      const del = event.target.closest("[data-del-doc]");
      const addLink = event.target.closest("[data-add-link]");
      if (addLink) {
        linkTarget = addLink.dataset.addLink;
        const tag = tagById(linkTarget);
        $("#docs-link-title").textContent = tag ? `Ajouter un lien à « ${tag.label} »` : "Ajouter un lien";
        $("#docs-link-name").value = "";
        $("#docs-link-url").value = "";
        $("#docs-link-form").hidden = false;
        $("#docs-link-url").focus();
      } else if (add) {
        docsTarget = add.dataset.addDoc;
        $("#docs-file").click();
      } else if (del) deleteDocument(del.dataset.delDoc);
    });
    on($("#docs-link-form"), "submit", (event) => {
      event.preventDefault();
      addDocumentLink();
    });
    on($("#docs-link-cancel"), "click", () => {
      linkTarget = null;
      $("#docs-link-form").hidden = true;
    });
    on($("#docs-file"), "change", (event) => {
      const files = [...event.target.files];
      event.target.value = "";
      addDocuments(files);
    });
    on($("#tags-form"), "submit", submitTag);
    setupTagPickers(on);
    on($("#tag-shows-toggle"), "click", () => {
      const open = $("#tag-shows-panel").hidden;
      $("#tag-shows-panel").hidden = !open;
      $("#tag-shows-toggle").setAttribute("aria-expanded", String(open));
      if (open) showsPicker.goTo(editingShows[0] || $("#tag-start").value || null);
    });
    on($("#show-choice"), "click", (event) => {
      const button = event.target.closest("[data-choice]");
      if (button) answerShowChoice(button.dataset.choice);
    });
    on($("#tag-shows"), "click", (event) => {
      const chip = event.target.closest("[data-show]");
      if (!chip) return;
      const at = editingShows.indexOf(chip.dataset.show);
      if (at >= 0) editingShows.splice(at, 1);
      renderShowChips();
    });
    on($("#tag-cancel"), "click", () => {
      editingTag = null;
      tagFormOpen = false;
      setNotice("#tags-message", "");
      resetTagForm();
    });
    on($("#tag-new"), "click", () => {
      editingTag = null;
      tagFormOpen = true;
      resetTagForm();
      $("#tag-label").focus();
    });
    on($("#open-calendar"), "click", () => openCalendar(null));
    on($("#week-strip"), "click", () => openCalendar(currentRoomId()));
    on($("#week-strip"), "keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openCalendar(currentRoomId());
      }
    });
    // Glisser du doigt : à gauche sur la liste pour la fermer ; à gauche/droite sur le calendrier pour changer de mois.
    onSwipe($("#sidebar"), (dir) => {
      if (dir < 0 && isMobile()) closeSidebar();
    }, opts);
    onSwipe($("#calendar"), (dir) => {
      if (state.calendarOpen) shiftMonth(dir < 0 ? 1 : -1);
    }, opts);
    // Menu ⋮ de l'en-tête (téléphone) : regroupe les petits boutons.
    const toolsMenu = (open) => {
      $("#head-tools").classList.toggle("open", open);
      $("#head-more").setAttribute("aria-expanded", String(open));
    };
    on($("#head-more"), "click", (e) => {
      e.stopPropagation();
      toolsMenu(!$("#head-tools").classList.contains("open"));
    });
    on(document, "click", () => toolsMenu(false));
    // Premier geste sur l'écran : pose une entrée d'historique « validée » (voir guardHistory).
    on(document, "pointerdown", () => guardHistory());
    on($("#cal-prev"), "click", () => shiftMonth(-1));
    on($("#cal-next"), "click", () => shiftMonth(1));
    on($("#cal-today"), "click", () => {
      const now = new Date();
      state.calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      state.calDay = toISO(now);
      renderCalendar();
    });
    on($("#cal-scope"), "change", () => {
      state.calScope = $("#cal-scope").value;
      renderCalendar();
    });
    on($("#cal-grid"), "click", (event) => {
      const bar = event.target.closest(".cal-bar");
      if (bar) return openTagFromCalendar(bar.dataset.tag);
      const day = event.target.closest(".cal-day");
      if (day) {
        state.calDay = state.calDay === day.dataset.day ? null : day.dataset.day;
        renderCalendar();
      }
    });
    on($("#cal-detail"), "click", (event) => {
      const row = event.target.closest("[data-open-tag]");
      if (row) openTagFromCalendar(row.dataset.openTag);
    });
    on($("#tags-list"), "click", (event) => {
      const edit = event.target.closest("[data-edit]");
      if (edit) {
        editingTag = tagById(edit.dataset.edit) || null;
        resetTagForm();
        return $("#tag-label").focus();
      }
      const del = event.target.closest("[data-del]");
      if (del) deleteTag(del.dataset.del);
    });
    on(input, "keydown", (event) => {
      if (!$("#tag-suggest").hidden && suggestItems.length) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          suggestIndex = (suggestIndex + (event.key === "ArrowDown" ? 1 : suggestItems.length - 1)) % suggestItems.length;
          return updateSuggest();
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          return pickSuggest(suggestItems[suggestIndex].id);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          return hideSuggest();
        }
      }
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      // Sur écran tactile, Entrée passe à la ligne ; l'envoi se fait avec le bouton.
      const touch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
      if (touch) return;
      event.preventDefault();
      sendMessage();
    });

    on($("#workspace-form"), "submit", submitWorkspace);
    on($("#channel-form"), "submit", submitChannel);
    on($("#invite-form"), "submit", submitInvite);
    on($("#invite-person"), "change", () => {
      $("#invite-new").hidden = Boolean($("#invite-person").value);
    });
    for (const button of document.querySelectorAll("[data-close]")) {
      on(button, "click", () => closeDialog(button.closest("dialog")));
    }

    on($("#open-sidebar"), "click", () => {
      guardHistory();
      $("#screen-app").classList.add("sidebar-open");
    });

    on(window, "popstate", () => {
      if (stopped || !isMobile()) return;
      const opened = [...document.querySelectorAll("dialog[open]")];
      if (opened.length) {
        for (const dialog of opened) closeDialog(dialog); // « Retour » ferme la boîte de dialogue
        guardHistory();
        return;
      }
      if (state.multi.size) {
        clearMulti(); // « Retour » quitte la sélection de messages
        guardHistory();
        return;
      }
      if (state.selectedId) {
        state.selectedId = null; // « Retour » désélectionne le message (et masque ses actions)
        renderMessages();
        guardHistory();
        return;
      }
      const screen = $("#screen-app");
      if (state.calendarOpen) {
        // « Retour » depuis le calendrier : on revient au dernier sous-salon (jamais d'écran vide)
        screen.classList.remove("sidebar-open");
        guardHistory();
        selectChannel(pickChannel(state.channel ? state.channel.id : readLast().channel)).catch(() => {});
        return;
      }
      if (!screen.classList.contains("sidebar-open")) {
        screen.classList.add("sidebar-open"); // « Retour » depuis un salon : retour à la liste
        guardHistory();
      } else if (Date.now() - exitArmedAt < 2500) {
        history.back(); // deuxième « Retour » rapproché : on quitte vraiment
      } else {
        // La liste est déjà affichée : on demande confirmation au lieu de quitter (ou de tomber sur une page vide).
        exitArmedAt = Date.now();
        guardHistory();
        toast("Appuie encore sur Retour pour quitter.", "ok");
      }
    });
    on($("#close-sidebar"), "click", closeSidebar);
    on($("#backdrop"), "click", closeSidebar);

    // Retour au premier plan ou reconnexion : on rattrape les messages et les non lus manqués.
    const refresh = async () => {
      if (stopped || !state.ws) return;
      await refreshStructure();
      if (state.channel) {
        await loadMessages(state.channel.id, state.loadToken);
        markRead(state.channel.id);
      }
    };
    on(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") {
        refresh();
        renderCurrentButtons(); // le jour a pu changer
      }
    });
    on(window, "online", () => {
      refresh();
      flushOutbox();
    });
    on(window, "offline", () => setOffline(true));

    // Clic sur une notification : le service worker demande d'ouvrir le bon salon.
    if (typeof navigator !== "undefined" && navigator.serviceWorker && navigator.serviceWorker.addEventListener) {
      on(navigator.serviceWorker, "message", (event) => {
        const data = event.data || {};
        if (data.type !== "open-channel" || !data.channel_id) return;
        const target = state.allChannels.find((c) => c.id === data.channel_id);
        if (!target) return refreshStructure();
        if (!state.ws || state.ws.id !== target.workspace_id) selectWorkspace(target.workspace_id, target.id);
        else selectChannel(target.id);
      });
    }
  }

  // --- Cycle de vie --------------------------------------------------------------

  // Salon ouvert depuis une notification : /?w=<espace>&c=<salon>
  function readDeepLink() {
    try {
      const params = new URLSearchParams(location.search);
      const w = params.get("w");
      const c = params.get("c");
      if (!w && !c) return null;
      history.replaceState(null, "", location.pathname + location.hash);
      return { w, c };
    } catch {
      return null;
    }
  }

  async function start() {
    stopped = false;
    bind();
    unsubscribe();
    state.workspaces = [];
    state.ws = null;
    state.allRooms = [];
    state.allChannels = [];
    state.tags = [];
    state.tagFilter = new Set();
    state.composerTags = new Set();
    clearPendingImages();
    state.replyTo = null;
    state.quoted = new Map();
    state.channel = null;
    state.messages = [];
    state.selectedId = null;
    state.unread = new Map();
    state.mutes = new Map();
    state.themeColumn = true;
    state.avatarColumn = true;
    state.pendingDeepLink = readDeepLink();

    state.profiles.set(user.id, { name: fallbackName, avatar: "" });
    // Messages écrits sans réseau lors d'une session précédente : ils attendent toujours leur envoi.
    state.outbox = await store.outboxAll(user.id);
    store.prune(user.id + "|");
    setOffline(!isOnline());
    clearInterval(outboxTimer);
    outboxTimer = setInterval(flushOutbox, 15000);
    let profile = await supabase.from("profiles").select("display_name, avatar_url, is_super_admin").eq("id", user.id).maybeSingle();
    if (profile.error) {
      // Colonne is_super_admin absente : la migration 003 n'a pas été exécutée.
      return showFatal(profile.error);
    }
    const row = profile.data;
    state.isSuper = Boolean(row && row.is_super_admin);
    state.profiles.set(user.id, { name: (row && row.display_name) || fallbackName, avatar: (row && row.avatar_url) || "" });
    renderMeFooter();

    subscribe();
    watchExpiry();
    syncPush(supabase).then(refreshPushStatus);
    await loadWorkspaces();
    flushOutbox();
  }

  let outboxTimer = null;

  // Partage l'adresse de l'application (feuille de partage du téléphone, sinon copie dans le presse-papiers).
  const APP_URL = "https://thychat.thierry-morin.com";
  async function shareApp() {
    const data = { title: "ThyChat", text: "ThyChat : la messagerie des équipes de spectacle vivant.", url: APP_URL };
    if (navigator.share) {
      try {
        await navigator.share(data);
        return;
      } catch (error) {
        if (error && error.name === "AbortError") return; // partage annulé
      }
    }
    let copied = false;
    try {
      await navigator.clipboard.writeText(APP_URL);
      copied = true;
    } catch {
      /* presse-papiers refusé */
    }
    setNotice("#share-message", copied ? "Adresse copiée : " + APP_URL : "Partage impossible ici. Adresse : " + APP_URL, copied ? "ok" : "error");
  }

  // Recharge l'application après avoir cherché une nouvelle version (le service worker l'installe puis prend la main).
  async function reloadApp() {
    if (!isOnline()) return toast("Pas de réseau : impossible de mettre l'application à jour.");
    const typing = $("#composer-input").value.trim();
    if (typing && !window.confirm("Recharger l'application ? Le message que tu es en train d'écrire sera perdu.")) return;
    const button = $("#reload-app");
    button.disabled = true;
    try {
      const registration = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
      if (registration) await Promise.race([registration.update(), new Promise((resolve) => setTimeout(resolve, 4000))]);
    } catch {
      /* pas de service worker : on recharge simplement */
    }
    window.location.reload();
  }

  function stop() {
    stopped = true;
    clearInterval(outboxTimer);
    state.loadToken++;
    unsubscribe();
    clearTimeout(structureTimer);
    clearInterval(expiryTimer);
    resetTheme();
    if (controller) {
      controller.abort();
      controller = null;
    }
  }

  return {
    userId: user.id,
    start,
    stop,
    pendingCount: () => state.outbox.length,
    wipeOffline: () => store.wipe(user.id),
  };
}
