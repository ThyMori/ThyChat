// Interface de messagerie : espaces (une couleur chacun), salons, messages privés, messages en temps réel,
// non lus, silences, membres et invitations, profil.
// Le client Supabase est injecté (aucun import réseau ici) pour pouvoir tester hors navigateur.
// Tout le texte venant des utilisateurs est inséré via textContent : jamais d'innerHTML.

import { PALETTE, DEFAULT_THEME, themeFor, themeByKey, pickUnusedTheme, authorHue } from "./themes.js";
import { MUTE_CHOICES, muteFromChoice, muteKey, isMuted, channelMuted, choiceOf, muteLabel, badgeTotal, countLabel } from "./notify.js";
import { MAX_PDF_BYTES, isPdf, sizeLabel, uploadRoomSheet, uploadTagDocument, removeTagDocuments, signDocuments } from "./documents.js";
import { MAX_IMAGES, resizedJpeg, uploadMessageImage, removeMessageImages, removeChannelImages, signPaths } from "./images.js";
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

// Insère du texte brut en transformant les adresses http(s) en liens sûrs.
function renderBody(container, text) {
  text.split(URL_RE).forEach((part, index) => {
    if (index % 2 === 0) {
      if (part) container.append(document.createTextNode(part));
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

function guardHistory() {
  try {
    if (isMobile() && !(history.state && history.state.tcGuard)) history.pushState({ tcGuard: true }, "");
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

export function createChat({ supabase, user }) {
  const fallbackName = user.user_metadata?.display_name || user.email || "Moi";
  const state = {
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
    replyTo: null, // message auquel on répond
    quoted: new Map(), // id -> { user_id, body } des messages cités qui ne sont pas dans la liste
    selectedId: null, // message touché (affiche « Supprimer »)
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
      start = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
    }, { ...opts, passive: true });
    node.addEventListener("touchend", (e) => {
      const t = e.changedTouches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      start = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) fn(dx < 0 ? -1 : 1);
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
    const docsResult = await supabase.from("tag_documents").select("id, tag_id, name, path, size_bytes, created_at").order("created_at");
    state.tagDocs = docsResult.error ? [] : docsResult.data || [];
    // Fiches techniques (migration 013 : sans elle, simplement aucune fiche).
    const sheetsResult = await supabase.from("room_sheets").select("id, room_id, name, path, version_date, size_bytes, created_at");
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
      item.append(el("span", "avatar tiny soft", initials(channel.name, 1)));
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

  const roomOpen = (room) => state.openRooms.has(room.id) || Boolean(state.channel && state.channel.room_id === room.id);

  // Un salon (spectacle) : une ligne qui se déplie sur ses sous-salons.
  function roomGroup(room) {
    const group = el("div", "room-group");
    const open = roomOpen(room);
    const info = roomUnread(room);
    if (info.muted) group.classList.add("is-muted");

    const head = el("div", "room-head");
    const toggle = el("button", "room-toggle");
    toggle.type = "button";
    toggle.dataset.room = room.id;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.append(el("span", "chev", open ? "▾" : "▸"), el("span", "avatar small soft", initials(room.name, 1)));
    const text = el("span", "channel-text");
    text.append(el("span", "channel-name", room.name));
    if (room.description) text.append(el("span", "channel-sub", room.description));
    toggle.append(text);
    const side = el("span", "channel-side");
    if (!room.everyone) side.append(flag("🔒", "lock-ic", "Accès restreint"));
    if (info.muted) side.append(flag("bell-off", "mute-ic", muteLabel(state.mutes.get(muteKey("room", room.id))) || "Spectacle en silence"));
    const n = info.muted ? info.all : info.count;
    if (!open && n > 0) side.append(flag(countLabel(n), info.muted ? "unread muted" : "unread"));
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
      const subs = subsOfRoom(room.id);
      for (const channel of subs) group.append(channelItem(channel));
      if (!subs.length) group.append(el("p", "muted empty-sub", "Aucun sous-salon pour toi ici."));
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
    dmList.hidden = !privates.length;
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
      avatar.textContent = initials(channel.name, 1);
    }
    avatar.hidden = !channel;
    $("#channel-title").textContent = channel ? channelTitle(channel) : state.ws ? state.ws.name : "ThyChat";

    const parts = [];
    if (channel && state.ws && channel.kind !== "dm") parts.push(state.ws.name);
    if (channel && channel.kind === "dm") parts.push("Message privé");
    else if (channel) {
      const room = roomById(channel.room_id);
      if (room) parts.push(room.name);
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
    bell.title = muteNote || "Notifications";
    $("#channel-edit").hidden = !channel || channel.kind !== "channel" || !isAdmin();
    $("#channel-delete-dm").hidden = !channel || channel.kind !== "dm";
    $("#channel-search").hidden = !channel;
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

    if (!state.messages.length) {
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
      if (message.id === state.selectedId) classes.push("selected");
      if (message.struck_at) classes.push("struck");
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
      const bodyTags = (message.tag_ids || []).map(tagById).filter(Boolean).map((t) => ({ id: t.id, label: t.label, hue: hueOfTag(t) }));
      if (message.attachments && message.attachments.length) bubble.append(imagesBlock(message));
      renderMessageBody(body, message.body, bodyTags);
      const time = el("time", "msg-time", timeFmt.format(date));
      time.dateTime = date.toISOString();
      body.append(time);
      bubble.append(body);
      const messageTags = (message.tag_ids || []).map(tagById).filter(Boolean);
      if (messageTags.length) {
        const row = el("div", "msg-tags");
        for (const tag of messageTags) row.append(el("span", "msg-tag", tagText(tag)));
        bubble.append(row);
      }
      item.append(bubble);

      if (message.id === state.selectedId) {
        const actions = el("div", "msg-actions");
        const actionList = [["reply", "Répondre"], ["quote", "Citer"]];
        if (mine) actionList.push(["strike", message.struck_at ? "Rétablir" : "Rayer"]);
        for (const [action, label] of actionList) {
          const button = el("button", "", label);
          button.type = "button";
          button.dataset.action = action;
          button.dataset.id = message.id;
          actions.append(button);
        }
        item.append(actions);
      }

      if (deletable) {
        const remove = el("button", "msg-del", "Supprimer");
        remove.type = "button";
        remove.dataset.action = "delete";
        remove.dataset.id = message.id;
        item.append(remove);
      }

      box.append(item);
      previous = message;
    }

    box.scrollTop = forceBottom || nearBottom ? box.scrollHeight : previousTop;
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
    await selectWorkspace(target.id, deep?.c);
  }

  async function selectWorkspace(id, channelId) {
    state.ws = state.workspaces.find((ws) => ws.id === id) || null;
    if (!state.ws) return;
    writeLast({ ws: id });
    state.selectedId = null;
    renderWorkspaceHeader();
    const remembered = readLast().channel;
    await selectChannel(pickChannel(channelId || remembered));
  }

  async function selectChannel(id) {
    const token = ++state.loadToken;
    const previousRoom = state.channel ? state.channel.room_id : null;
    state.calendarOpen = false;
    state.channel = state.allChannels.find((c) => c.id === id) || null;
    state.selectedId = null;
    if (!state.channel || state.channel.room_id !== previousRoom || state.focus) state.tagFilter = new Set();
    if (state.pendingFilter) {
      if (state.channel && tagById(state.pendingFilter)) state.tagFilter = new Set([state.pendingFilter]);
      state.pendingFilter = null;
    }
    state.composerTags = new Set();
    clearPendingImages();
    state.replyTo = null;
    renderChannels();
    renderHeader();

    if (!state.channel) {
      state.messages = [];
      setView("empty", {
        title: "Aucun spectacle",
        text: isAdmin()
          ? "Crée le premier spectacle de cet espace : un spectacle, avec ses sous-salons (Tous, Technique, Musiciens…)."
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
    if (state.channel.room_id) state.openRooms.add(state.channel.room_id);
    renderChannels();
    guardHistory();
    setView("chat");
    state.messages = [];
    renderTagBar();
    renderComposerExtra();
    renderMessages(true);
    closeSidebar();
    markRead(state.channel.id);

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
      if (index === -1) return;
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

  function removeMessage(id) {
    if (!id || !state.messages.some((m) => m.id === id)) return;
    if (state.selectedId === id) state.selectedId = null;
    state.messages = state.messages.filter((m) => m.id !== id);
    renderMessages();
  }

  // --- Actions -----------------------------------------------------------------

  let sending = false;

  async function sendMessage() {
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

    sending = true;
    $("#composer-send").disabled = true;
    const uploaded = [];
    try {
      for (const image of images) uploaded.push(await uploadMessageImage(supabase, channelId, image));
      if (uploaded.length) row.attachments = uploaded;
      input.value = "";
      autosize();
      hideSuggest();
      const { data, error } = await supabase.from("messages").insert(row).select().single();
      if (error) {
        input.value = body;
        autosize();
        await removeMessageImages(supabase, uploaded.map((u) => u.path));
        toast("Message non envoyé : " + error.message);
        return;
      }
      if (replied) state.quoted.set(replied.id, { user_id: replied.user_id, body: replied.body, attachments: replied.attachments });
      state.replyTo = null;
      state.composerTags = new Set();
      clearPendingImages();
      renderComposerExtra();
      await resolveImages([data]);
      const hidden = state.tagFilter.size && !(data.tag_ids || []).some((t) => state.tagFilter.has(t));
      if (hidden) toast("Message envoyé (hors du filtre de dates actuel).");
      else if (state.channel && state.channel.id === channelId) addMessage(data, true);
    } catch (error) {
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

  function toggleAttachMenu(force) {
    const menu = $("#attach-menu");
    const open = force === undefined ? menu.hidden : force;
    menu.hidden = !open;
    $("#composer-attach").setAttribute("aria-expanded", String(open));
  }

  // --- Dates de tournée, réponses et citations -------------------------------------

  const currentRoomId = () => (state.channel && state.channel.kind === "channel" ? state.channel.room_id : null);
  const tagById = (id) => state.tags.find((t) => t.id === id);
  const tagText = (tag) => (tag.start_date ? `${tag.label} · ${rangeText(tag)}` : tag.label);
  const tagsOfRoom = (roomId) =>
    state.tags
      .filter((t) => t.room_id === roomId)
      .sort((a, b) => (a.start_date || "9999").localeCompare(b.start_date || "9999") || a.label.localeCompare(b.label, "fr"));

  function tagChip(tag, active, onClick) {
    const chip = el("button", "tag-chip", tag.label);
    chip.type = "button";
    chip.dataset.tag = tag.id;
    chip.setAttribute("aria-pressed", String(active));
    if (tag.start_date) chip.append(el("small", "", rangeText(tag)));
    chip.addEventListener("click", onClick);
    return chip;
  }

  function renderTagBar() {
    const roomId = currentRoomId();
    const tags = roomId ? tagsOfRoom(roomId) : [];
    const manage = Boolean(roomId) && isAdmin();
    const sheets = roomId ? sheetsOfRoom(roomId) : [];
    $("#tag-bar").hidden = state.calendarOpen || !roomId || (!tags.length && !manage && !sheets.length);
    $("#room-sheet").hidden = !roomId || (!sheets.length && !manage);
    $("#room-sheet-label").textContent = sheets.length ? `Fiche technique · ${shortDate(sheets[0].version_date)}` : "Fiche technique";
    $("#tags-manage").hidden = !manage;
    const roomDocs = roomId ? docsOfRoom(roomId) : [];
    $("#tags-docs").hidden = !roomId || (!roomDocs.length && !manage);
    $("#tags-docs-label").textContent = roomDocs.length ? `Documents (${roomDocs.length})` : "Documents";
    const box = $("#tag-filter");
    box.replaceChildren();
    for (const id of [...state.tagFilter]) if (!tagById(id)) state.tagFilter.delete(id);
    if (!tags.length) box.append(el("span", "muted", "Aucune date de tournée pour ce spectacle."));
    for (const tag of tags) box.append(tagChip(tag, state.tagFilter.has(tag.id), () => toggleTagFilter(tag.id)));
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
    const reply = state.replyTo;
    $("#reply-bar").hidden = !reply;
    if (reply) {
      $("#reply-author").textContent = authorName(reply.user_id);
      $("#reply-excerpt").textContent = messageExcerpt(reply);
    }
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
      if (today < tag.start_date) section.append(el("p", "travel-note", "Veille : départ demain"));
      else if (today > (tag.end_date || tag.start_date)) section.append(el("p", "travel-note", "Lendemain : retour"));
      if ((tag.shows || []).includes(today)) section.append(el("p", "show-today", "★ Représentation aujourd'hui"));
      const sheet = sheetsOfRoom(tag.room_id)[0];
      if (sheet) {
        const open = docLink(sheet, "doc-open latest");
        const text = el("span", "doc-name two");
        text.append(el("strong", "", "Fiche technique"), el("small", "muted", `Version du ${shortDate(sheet.version_date)}`));
        open.append(icon("file"), text, el("small", "muted", sizeLabel(sheet.size_bytes)));
        section.append(open);
      }
      const docs = docsOfTag(tag.id);
      if (!docs.length) section.append(el("p", "muted docs-empty", "Aucun document pour cette date."));
      for (const doc of docs) {
        const open = docLink(doc, "doc-open");
        open.append(icon("file"), el("span", "doc-name", doc.name), el("small", "muted", sizeLabel(doc.size_bytes)));
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

  function openSheet() {
    const roomId = currentRoomId();
    if (!roomId) return;
    const room = roomById(roomId);
    $("#sheet-title").textContent = room ? `Fiche technique · ${room.name}` : "Fiche technique";
    $("#sheet-note").textContent = isAdmin()
      ? "Ajoute chaque nouvelle version du PDF (15 Mo au plus) en précisant sa date : la plus récente est mise en avant, les précédentes restent consultables."
      : "La version la plus récente est mise en avant ; les précédentes restent consultables.";
    $("#sheet-form").hidden = !isAdmin();
    $("#sheet-date").value = toISO(new Date());
    setNotice("#sheet-message", "");
    renderSheet();
    openDialog("#dialog-sheet");
  }

  function sheetRow(sheet, latest) {
    const row = el("div", "doc-row");
    const open = docLink(sheet, "doc-open" + (latest ? " latest" : ""));
    const text = el("span", "doc-name two");
    text.append(el("strong", "", `Version du ${shortDate(sheet.version_date)}`), el("small", "muted", sheet.name));
    open.append(icon("file"), text, el("small", "muted", sizeLabel(sheet.size_bytes)));
    row.append(open);
    if (isAdmin()) {
      const del = el("button", "icon-btn tiny", "");
      del.type = "button";
      del.dataset.delSheet = sheet.id;
      del.title = "Retirer cette version";
      del.setAttribute("aria-label", "Retirer la version du " + shortDate(sheet.version_date));
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
    const latest = el("section", "docs-tag");
    latest.append(el("strong", "", "Version la plus récente"), sheetRow(list[0], true));
    box.append(latest);
    if (list.length > 1) {
      const older = el("section", "docs-tag");
      older.append(el("strong", "", "Versions précédentes"));
      for (const sheet of list.slice(1)) older.append(sheetRow(sheet, false));
      box.append(older);
    }
  }

  async function addSheet(file) {
    const roomId = currentRoomId();
    if (!roomId || !isAdmin() || !file) return;
    const date = $("#sheet-date").value;
    if (!date) return setNotice("#sheet-message", "Indique la date de la version.");
    if (!isPdf(file)) return setNotice("#sheet-message", `« ${file.name} » n'est pas un PDF.`);
    if (file.size > MAX_PDF_BYTES) return setNotice("#sheet-message", `« ${file.name} » dépasse 15 Mo.`);
    setNotice("#sheet-message", "Envoi…", "info");
    let stored = null;
    try {
      stored = await uploadRoomSheet(supabase, roomId, file);
      const { data, error } = await supabase.from("room_sheets").insert({ room_id: roomId, version_date: date, ...stored }).select().single();
      if (error) throw error;
      state.sheets.push(data);
      setNotice("#sheet-message", "");
    } catch (error) {
      if (stored) await removeTagDocuments(supabase, [stored.path]);
      const text = error && error.message ? error.message : "envoi impossible";
      setNotice("#sheet-message", `Envoi impossible : ${text}${/bucket|not found|room_sheets/i.test(text) ? " (exécute les migrations 012 et 013)" : ""}`);
    }
    renderSheet();
    renderTagBar();
  }

  async function deleteSheet(id) {
    const sheet = state.sheets.find((s) => s.id === id);
    if (!sheet || !window.confirm(`Retirer la version du ${shortDate(sheet.version_date)} ?`)) return;
    const { error } = await supabase.from("room_sheets").delete().eq("id", id);
    if (error) return setNotice("#sheet-message", "Suppression impossible : " + error.message);
    state.sheets = state.sheets.filter((s) => s.id !== id);
    await removeTagDocuments(supabase, [sheet.path]);
    renderSheet();
    renderTagBar();
  }

  function openDocs() {
    if (!currentRoomId()) return;
    const room = roomById(currentRoomId());
    $("#docs-title").textContent = room ? `Documents · ${room.name}` : "Documents du spectacle";
    $("#docs-note").textContent = isAdmin()
      ? "Ajoute des PDF (15 Mo au plus) à chaque date : feuilles de route, billets, livrets d'accueil… Toutes les personnes ayant accès au spectacle peuvent les ouvrir."
      : "Feuilles de route, billets, livrets d'accueil… rangés par date de tournée.";
    setNotice("#docs-message", "");
    renderDocs();
    openDialog("#dialog-docs");
  }

  function renderDocs() {
    const box = $("#docs-list");
    box.replaceChildren();
    const roomId = currentRoomId();
    if (!roomId) return;
    const admin = isAdmin();
    const tags = tagsOfRoom(roomId).filter((t) => admin || docsOfTag(t.id).length);
    if (!tags.length) {
      box.append(el("p", "muted", admin ? "Crée d'abord une date de tournée (bouton « Gérer »)." : "Aucun document pour l'instant."));
      return;
    }
    for (const tag of tags) {
      const section = el("section", "docs-tag");
      const head = el("div", "docs-tag-head");
      head.append(el("strong", "", tag.label));
      if (tag.start_date) head.append(el("small", "muted", rangeText(tag)));
      if (admin) {
        const add = el("button", "ghost small", "Ajouter un PDF");
        add.type = "button";
        add.dataset.addDoc = tag.id;
        head.append(add);
      }
      section.append(head);
      const docs = docsOfTag(tag.id);
      if (!docs.length) section.append(el("p", "muted docs-empty", "Aucun document."));
      for (const doc of docs) {
        const row = el("div", "doc-row");
        const open = docLink(doc, "doc-open");
        open.append(icon("file"), el("span", "doc-name", doc.name), el("small", "muted", sizeLabel(doc.size_bytes)));
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

  async function addDocuments(files) {
    const tag = docsTarget && tagById(docsTarget);
    docsTarget = null;
    if (!tag || !isAdmin()) return;
    const list = [...files];
    const problems = [];
    for (const file of list) {
      if (!isPdf(file)) {
        problems.push(`« ${file.name} » n'est pas un PDF.`);
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
        problems.push(`« ${file.name} » : ${error && error.message ? error.message : "envoi impossible"}${/bucket|not found|tag_documents/i.test(String(error && error.message)) ? " (exécute la migration 012)" : ""}`);
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

  function docLink(doc, className) {
    const link = el("a", className);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
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
      for (const iso of tag.shows || []) {
        const index = isos.indexOf(iso);
        if (index < 0) continue;
        const onBar = Boolean(tag.start_date) && iso >= tag.start_date && iso <= tag.end_date;
        const star = el("span", "cal-star" + (onBar ? " on-bar" : " alone"), "★");
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
      const star = (tag.shows || []).includes(state.calDay) ? " ★ représentation" : "";
      row.append(el("span", "cal-swatch"), el("span", "", `${roomById(tag.room_id)?.name || ""} · ${tag.label}${star}`));
      box.append(row);
      for (const doc of docsOfTag(tag.id)) {
        const open = docLink(doc, "doc-open");
        open.append(icon("file"), el("span", "doc-name", doc.name), el("small", "muted", sizeLabel(doc.size_bytes)));
        box.append(open);
      }
    }
  }

  // Touche une frise : ouvre le spectacle sur cette date (en changeant d'espace si besoin).
  async function openTagFromCalendar(tagId) {
    const tag = tagById(tagId);
    const room = tag && roomById(tag.room_id);
    if (!room) return;
    const sub = subsOfRoom(room.id)[0];
    if (!sub) return toast("Aucun sous-salon accessible dans ce spectacle.");
    state.pendingFilter = tagId;
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

  function openTagsDialog() {
    const roomId = currentRoomId();
    if (!roomId || !isAdmin()) return;
    const room = roomById(roomId);
    $("#tags-title").textContent = `Dates de tournée · ${room.name}`;
    editingTag = null;
    resetTagForm();
    renderTagList();
    setNotice("#tags-message", "");
    openDialog("#dialog-tags");
  }

  let editingShows = new Set();

  function resetTagForm() {
    $("#tag-label").value = editingTag ? editingTag.label : "";
    $("#tag-start").value = editingTag?.start_date || "";
    $("#tag-end").value = editingTag?.end_date || "";
    $("#tag-show").value = "";
    editingShows = new Set(editingTag?.shows || []);
    $("#tag-add").textContent = editingTag ? "Enregistrer" : "Ajouter";
    $("#tag-cancel").hidden = !editingTag;
    renderShowChips();
  }

  function renderShowChips() {
    const box = $("#tag-shows");
    box.replaceChildren();
    for (const iso of [...editingShows].sort()) {
      const chip = el("button", "tag-chip on", "★ " + shortDate(iso));
      chip.type = "button";
      chip.dataset.show = iso;
      chip.append(el("small", "", "×"));
      chip.setAttribute("aria-label", "Retirer la représentation du " + shortDate(iso));
      box.append(chip);
    }
  }

  function renderTagList() {
    const list = $("#tags-list");
    list.replaceChildren();
    const tags = tagsOfRoom(currentRoomId());
    if (!tags.length) list.append(el("li", "muted", "Aucune date pour l'instant."));
    for (const tag of tags) {
      const row = el("li", "tag-row");
      const shows = (tag.shows || []).map((iso) => fromISO(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }));
      row.append(el("span", "pick-name", tagText(tag) + (shows.length ? ` · ★ ${shows.join(", ")}` : " · aucune représentation ★")));
      const edit = el("button", "ghost small", "Modifier");
      edit.type = "button";
      edit.dataset.edit = tag.id;
      const del = el("button", "ghost small", "Supprimer");
      del.type = "button";
      del.dataset.del = tag.id;
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
    // Un jour de représentation choisi mais pas encore validé par « Ajouter ★ » est pris en compte.
    if ($("#tag-show").value) editingShows.add($("#tag-show").value);
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
    if (!window.confirm(`Supprimer la date « ${tag.label} » ? Elle sera retirée des messages qui la portent.`)) return;
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
      resetTagForm();
    }
    renderTagList();
    renderTagBar();
    renderComposerExtra();
    renderMessages();
    if (state.calendarOpen) renderCalendar();
  }

  async function deleteMessage(id) {
    if (!window.confirm("Supprimer ce message ? Cette action est définitive.")) return;
    const target = state.messages.find((m) => m.id === id);
    const { error } = await supabase.from("messages").delete().eq("id", id);
    if (error) {
      toast("Suppression impossible : " + error.message);
      return;
    }
    if (target && target.attachments && target.attachments.length) {
      removeMessageImages(supabase, target.attachments.map((a) => a.path).filter(Boolean));
    }
    removeMessage(id);
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
    const room = await supabase.from("rooms").insert({ workspace_id: data.id, name: "Général", everyone: true }).select().single();
    if (room.data) {
      await supabase.from("channels").insert({ workspace_id: data.id, room_id: room.data.id, name: "Tous", everyone: true });
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
      const { data, error } = await supabase
        .from("rooms")
        .insert({ workspace_id: state.ws.id, name, description: description || null, everyone })
        .select()
        .single();
      if (error) return fail(error);
      room = data;
      if (!everyone && picked.length) {
        await supabase.from("room_members").insert(picked.map((id) => ({ room_id: room.id, user_id: id })));
      }
      // Chaque salon démarre avec un sous-salon « Tous ».
      const firstId = newId();
      const first = await supabase
        .from("channels")
        .insert({ id: firstId, workspace_id: state.ws.id, room_id: room.id, name: "Tous", everyone: true });
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
    $("#channel-delete").hidden = !channel;
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
    on($("#open-members"), "click", openMembers);
    on($("#open-invite"), "click", openInvite);
    on($("#open-notifications"), "click", openNotifications);
    on($("#channel-bell"), "click", openNotifications);
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
    onSwipe($("#messages"), (dir) => {
      if (dir > 0 && isMobile() && !state.calendarOpen) {
        guardHistory();
        $("#screen-app").classList.add("sidebar-open");
      }
    }, opts);
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
      const toggle = event.target.closest(".room-toggle");
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

    on($("#dm-search"), "input", renderDmPick);
    on($("#open-search"), "click", () => openSearch("all"));
    on($("#channel-search"), "click", () => openSearch("here"));
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

    on($("#messages"), "click", (event) => {
      const remove = event.target.closest("[data-action='delete']");
      if (remove) return deleteMessage(remove.dataset.id);
      const reply = event.target.closest("[data-action='reply']");
      if (reply) return startReply(reply.dataset.id);
      const quote = event.target.closest("[data-action='quote']");
      if (quote) return startQuote(quote.dataset.id);
      const strike = event.target.closest("[data-action='strike']");
      if (strike) return toggleStrike(strike.dataset.id);
      const pill = event.target.closest(".hash-pill");
      if (pill) return toggleTagFilter(pill.dataset.tag);
      const jump = event.target.closest(".msg-quote");
      if (jump) return jumpToMessage(jump.dataset.reply);
      if (event.target.closest("a")) return; // un lien s'ouvre, sans sélectionner le message
      // Toucher un message le sélectionne (affiche Répondre, Citer, Supprimer) ; toucher ailleurs désélectionne.
      const row = event.target.closest(".msg");
      const next = row && state.selectedId !== row.dataset.id ? row.dataset.id : null;
      if (next === state.selectedId) return;
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
      state.replyTo = null;
      renderComposerExtra();
    });
    on($("#tags-manage"), "click", openTagsDialog);
    on($("#tags-docs"), "click", openDocs);
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
      const file = event.target.files[0];
      event.target.value = "";
      addSheet(file);
    });
    on($("#open-current"), "click", openCurrent);
    on($("#channel-current"), "click", openCurrent);
    on($("#current-list"), "click", async (event) => {
      const go = event.target.closest("[data-go-tag]");
      if (go) {
        closeDialog($("#dialog-current"));
        closeSidebar();
        await openTagFromCalendar(go.dataset.goTag);
      }
    });
    on($("#docs-list"), "click", (event) => {
      const add = event.target.closest("[data-add-doc]");
      const del = event.target.closest("[data-del-doc]");
      if (add) {
        docsTarget = add.dataset.addDoc;
        $("#docs-file").click();
      } else if (del) deleteDocument(del.dataset.delDoc);
    });
    on($("#docs-file"), "change", (event) => {
      const files = [...event.target.files];
      event.target.value = "";
      addDocuments(files);
    });
    on($("#tags-form"), "submit", submitTag);
    on($("#tag-show-add"), "click", () => {
      const value = $("#tag-show").value;
      if (!value) return;
      editingShows.add(value);
      $("#tag-show").value = "";
      renderShowChips();
    });
    on($("#tag-shows"), "click", (event) => {
      const chip = event.target.closest("[data-show]");
      if (!chip) return;
      editingShows.delete(chip.dataset.show);
      renderShowChips();
    });
    on($("#tag-cancel"), "click", () => {
      editingTag = null;
      resetTagForm();
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
      if (history.state && history.state.tcGuard) return;
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
    on(window, "online", refresh);

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
  }

  function stop() {
    stopped = true;
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

  return { userId: user.id, start, stop };
}
