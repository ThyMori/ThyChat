// Interface de messagerie : espaces (une couleur chacun), salons, messages privés, messages en temps réel,
// non lus, silences, membres et invitations, profil.
// Le client Supabase est injecté (aucun import réseau ici) pour pouvoir tester hors navigateur.
// Tout le texte venant des utilisateurs est inséré via textContent : jamais d'innerHTML.

import { PALETTE, DEFAULT_THEME, themeFor, themeByKey, pickUnusedTheme, authorHue } from "./themes.js";
import { MUTE_CHOICES, muteFromChoice, muteKey, isMuted, channelMuted, choiceOf, muteLabel, badgeTotal, countLabel } from "./notify.js";
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
function renderMessageBody(container, text) {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].startsWith("> ")) {
    container.append(el("span", "quote-line", lines[i].slice(2)));
    i += 1;
  }
  const rest = lines.slice(i).join("\n").replace(/^\n+/, "");
  if (rest) renderBody(container, rest);
}

const plain = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const excerpt = (text, max = 90) => {
  const flat = String(text || "").replace(/^(> .*\n?)+/, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};
const shortDate = (iso) => (iso ? new Date(iso + "T00:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : "");

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
    channel: null,
    messages: [],
    tags: [], // dates de tournée visibles : { id, room_id, label, on_date }
    tagFilter: new Set(), // dates sélectionnées pour filtrer le sous-salon ouvert
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
    $("#messages").hidden = !isChat;
    $("#composer").hidden = !isChat;
    $("#empty-state").hidden = isChat;
    if (!isChat) {
      $("#empty-title").textContent = empty.title || "";
      $("#empty-text").textContent = empty.text || "";
      const action = $("#empty-action");
      action.hidden = !empty.action;
      action.textContent = empty.action || "";
      emptyAction = empty.onAction || null;
    }
  }

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
  const dms = () =>
    state.ws
      ? channelsOfWs(state.ws.id)
          .filter((c) => c.kind === "dm")
          .sort((a, b) => channelTitle(a).localeCompare(channelTitle(b), "fr"))
      : [];

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
    if (isMuted(state.mutes, "workspace", channel.workspace_id)) return wsMute(channel.workspace_id);
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
      .select("id, workspace_id, room_id, name, description, kind, everyone")
      .order("name");
    if (stopped) return false;
    if (channelsResult.error) {
      showFatal(channelsResult.error);
      return false;
    }
    state.allChannels = channelsResult.data || [];

    const tagsResult = await supabase.from("tour_tags").select("id, room_id, label, on_date");
    if (stopped) return false;
    if (tagsResult.error) {
      showFatal(tagsResult.error);
      return false;
    }
    state.tags = tagsResult.data || [];

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

  function flag(text, className, title) {
    const node = el("span", className, text);
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
      if (info.muted) side.append(flag("🔕", "mute-ic", muteLabel(wsMute(ws.id)) || "Espace en silence"));
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
      item.append(partner ? avatarFor(partner) : el("span", "avatar soft", "?"));
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
      side.append(flag("🔕", "mute-ic", label));
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
    if (info.muted) side.append(flag("🔕", "mute-ic", muteLabel(state.mutes.get(muteKey("room", room.id))) || "Salon en silence"));
    const n = info.muted ? info.all : info.count;
    if (!open && n > 0) side.append(flag(countLabel(n), info.muted ? "unread muted" : "unread"));
    toggle.append(side);
    head.append(toggle);

    if (isAdmin()) {
      const edit = el("button", "icon-btn tiny", "⚙");
      edit.type = "button";
      edit.dataset.roomEdit = room.id;
      edit.title = "Réglages du salon";
      edit.setAttribute("aria-label", "Réglages du salon " + room.name);
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
    const avatar = $("#channel-avatar");
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
    if (channel && state.ws) parts.push(state.ws.name);
    if (channel && channel.kind === "dm") parts.push("Message privé");
    else if (channel) {
      const room = roomById(channel.room_id);
      if (room) parts.push(room.name);
      if (channel.description) parts.push(channel.description);
    }
    const muteNote = channel ? muteLabel(mutedRowFor(channel)) : "";
    if (muteNote) parts.push("🔕 " + muteNote);
    $("#channel-desc").textContent = parts.join(" · ");

    const bell = $("#channel-bell");
    bell.hidden = !channel;
    bell.textContent = channel && muted(channel) ? "🔕" : "🔔";
    bell.classList.toggle("is-muted", Boolean(channel && muted(channel)));
    bell.title = muteNote || "Notifications";
    $("#channel-edit").hidden = !channel || channel.kind !== "channel" || !isAdmin();
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
          el("span", "", quoted ? excerpt(quoted.body) : "Message introuvable")
        );
        bubble.append(quote);
      }

      const body = el("div", "msg-body");
      renderMessageBody(body, message.body);
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
        "Exécute les fichiers supabase/migrations/005_rooms.sql puis 006_tags_replies.sql (après 003 et 004, ou supabase/schema.sql) dans l'éditeur SQL de Supabase, puis recharge la page. (" +
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
    state.channel = state.allChannels.find((c) => c.id === id) || null;
    state.selectedId = null;
    if (!state.channel || state.channel.room_id !== previousRoom) state.tagFilter = new Set();
    state.composerTags = new Set();
    state.replyTo = null;
    renderChannels();
    renderHeader();

    if (!state.channel) {
      state.messages = [];
      setView("empty", {
        title: "Aucun salon",
        text: isAdmin()
          ? "Crée le premier salon de cet espace : un spectacle, avec ses sous-salons (Tous, Technique, Musiciens…)."
          : "Tu n'as accès à aucun salon dans cet espace pour l'instant. Un administrateur peut t'y ajouter.",
        action: isAdmin() ? "Créer un salon" : "",
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
      .select("id, channel_id, user_id, parent_id, reply_to, tag_ids, struck_at, body, pinned, created_at, edited_at")
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
    await ensureProfiles(state.messages.map((m) => m.user_id));
    await loadQuoted(state.messages);
    if (stopped || token !== state.loadToken) return;
    renderMessages(true);
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
    const { data } = await supabase.from("messages").select("id, user_id, body").in("id", wanted);
    for (const row of data || []) state.quoted.set(row.id, { user_id: row.user_id, body: row.body });
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

      if (!state.allChannels.some((c) => c.id === message.channel_id)) {
        refreshStructureSoon(); // nouveau salon ou nouveau message privé
        return;
      }

      const viewing = state.channel && state.channel.id === message.channel_id;
      if (viewing) {
        await ensureProfiles([message.user_id]);
        await loadQuoted([message]);
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

  async function sendMessage() {
    const input = $("#composer-input");
    const body = input.value.trim();
    if (!body || !state.channel) return;

    const row = { channel_id: state.channel.id, body };
    if (state.replyTo) row.reply_to = state.replyTo.id;
    if (state.composerTags.size) row.tag_ids = [...state.composerTags];
    const replied = state.replyTo;

    input.value = "";
    autosize();
    hideSuggest();
    const { data, error } = await supabase.from("messages").insert(row).select().single();

    if (error) {
      input.value = body;
      autosize();
      toast("Message non envoyé : " + error.message);
      return;
    }
    if (replied) state.quoted.set(replied.id, { user_id: replied.user_id, body: replied.body });
    state.replyTo = null;
    state.composerTags = new Set();
    renderComposerExtra();
    const hidden = state.tagFilter.size && !(data.tag_ids || []).some((t) => state.tagFilter.has(t));
    if (hidden) toast("Message envoyé (hors du filtre de dates actuel).");
    else addMessage(data, true);
  }

  // --- Dates de tournée, réponses et citations -------------------------------------

  const currentRoomId = () => (state.channel && state.channel.kind === "channel" ? state.channel.room_id : null);
  const tagById = (id) => state.tags.find((t) => t.id === id);
  const tagText = (tag) => (tag.on_date ? `${tag.label} · ${shortDate(tag.on_date)}` : tag.label);
  const tagsOfRoom = (roomId) =>
    state.tags
      .filter((t) => t.room_id === roomId)
      .sort((a, b) => (a.on_date || "9999").localeCompare(b.on_date || "9999") || a.label.localeCompare(b.label, "fr"));

  function tagChip(tag, active, onClick) {
    const chip = el("button", "tag-chip", tag.label);
    chip.type = "button";
    chip.dataset.tag = tag.id;
    chip.setAttribute("aria-pressed", String(active));
    if (tag.on_date) chip.append(el("small", "", shortDate(tag.on_date)));
    chip.addEventListener("click", onClick);
    return chip;
  }

  function renderTagBar() {
    const roomId = currentRoomId();
    const tags = roomId ? tagsOfRoom(roomId) : [];
    const manage = Boolean(roomId) && isAdmin();
    $("#tag-bar").hidden = !roomId || (!tags.length && !manage);
    $("#tags-manage").hidden = !manage;
    const box = $("#tag-filter");
    box.replaceChildren();
    for (const id of [...state.tagFilter]) if (!tagById(id)) state.tagFilter.delete(id);
    if (!tags.length) box.append(el("span", "muted", "Aucune date de tournée pour ce salon."));
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
      $("#reply-excerpt").textContent = excerpt(reply.body);
    }
    const box = $("#composer-tags");
    box.replaceChildren();
    for (const id of state.composerTags) {
      const tag = tagById(id);
      if (!tag) continue;
      const chip = tagChip(tag, true, () => {
        state.composerTags.delete(id);
        renderComposerExtra();
      });
      chip.classList.add("on");
      chip.append(el("small", "", "×"));
      box.append(chip);
    }
    box.hidden = !box.childNodes.length;
    $("#composer-extra").hidden = !reply && box.hidden;
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
    const line = `> ${authorName(message.user_id)} : ${excerpt(message.body, 140)}\n\n`;
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
    input.value = (input.value.slice(0, found.start) + input.value.slice(end)).replace(/ {2,}/g, " ");
    input.setSelectionRange(found.start, found.start);
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

  function resetTagForm() {
    $("#tag-label").value = editingTag ? editingTag.label : "";
    $("#tag-date").value = editingTag?.on_date || "";
    $("#tag-add").textContent = editingTag ? "Enregistrer" : "Ajouter";
  }

  function renderTagList() {
    const list = $("#tags-list");
    list.replaceChildren();
    const tags = tagsOfRoom(currentRoomId());
    if (!tags.length) list.append(el("li", "muted", "Aucune date pour l'instant."));
    for (const tag of tags) {
      const row = el("li", "tag-row");
      row.append(el("span", "pick-name", tagText(tag)));
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
    const on_date = $("#tag-date").value || null;
    if (!label) return setNotice("#tags-message", "Donne un nom à la date.");
    const request = editingTag
      ? supabase.from("tour_tags").update({ label, on_date }).eq("id", editingTag.id).select().single()
      : supabase.from("tour_tags").insert({ room_id: roomId, label, on_date }).select().single();
    const { data, error } = await request;
    if (error) {
      setNotice("#tags-message", error.code === "23505" ? "Une date porte déjà ce nom dans ce salon." : "Enregistrement impossible : " + error.message);
      return;
    }
    state.tags = state.tags.filter((t) => t.id !== data.id).concat(data);
    editingTag = null;
    resetTagForm();
    setNotice("#tags-message", "");
    renderTagList();
    renderTagBar();
    renderMessages();
  }

  async function deleteTag(id) {
    const tag = tagById(id);
    if (!tag) return;
    if (!window.confirm(`Supprimer la date « ${tag.label} » ? Elle sera retirée des messages qui la portent.`)) return;
    const { error } = await supabase.from("tour_tags").delete().eq("id", id);
    if (error) return setNotice("#tags-message", "Suppression impossible : " + error.message);
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
  }

  async function deleteMessage(id) {
    if (!window.confirm("Supprimer ce message ? Cette action est définitive.")) return;
    const { error } = await supabase.from("messages").delete().eq("id", id);
    if (error) {
      toast("Suppression impossible : " + error.message);
      return;
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
    $("#room-dialog-title").textContent = room ? "Salon" : "Nouveau salon";
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
    if (!name) return setNotice("#room-message", "Donne un nom au salon.");
    const everyone = accessMode("room-access") === "everyone";
    const picked = [...document.querySelectorAll("#room-pick input:checked")].map((box) => box.value);

    const button = $("#room-submit");
    button.disabled = true;
    setNotice("#room-message", "");
    const fail = (error) => {
      button.disabled = false;
      setNotice("#room-message", error.code === "23505" ? "Un salon porte déjà ce nom." : "Enregistrement impossible : " + error.message);
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
      const first = await supabase
        .from("channels")
        .insert({ workspace_id: state.ws.id, room_id: room.id, name: "Tous", everyone: true })
        .select()
        .single();
      firstChannel = first.data;
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
    if (!window.confirm(`Supprimer le salon « ${editingRoom.name} », ses sous-salons et tous leurs messages ? Cette action est définitive.`)) return;
    const { error } = await supabase.from("rooms").delete().eq("id", editingRoom.id);
    if (error) return setNotice("#room-message", "Suppression impossible : " + error.message);
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
    $("#channel-room-note").textContent = `Dans le salon « ${room.name} ».`;
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
      const { data, error } = await supabase
        .from("channels")
        .insert({ workspace_id: state.ws.id, room_id: channelRoomId, name, description: description || null, everyone })
        .select()
        .single();
      if (error) return channelError(error, button);
      channel = data;
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
    const text = error.code === "23505" ? "Un sous-salon porte déjà ce nom dans ce salon." : "Enregistrement impossible : " + error.message;
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

  // --- Messages privés ----------------------------------------------------------------

  async function openDmPicker() {
    if (!state.ws) return;
    setNotice("#dm-message", "");
    openDialog("#dialog-dm");
    const list = $("#dm-pick");
    list.replaceChildren();
    const users = (await workspaceUsers(state.ws.id)).filter((row) => row.user_id !== user.id);
    if (!users.length) {
      list.append(el("li", "muted", "Personne d'autre dans cet espace pour l'instant."));
      return;
    }
    for (const row of users) {
      const item = el("li");
      const button = el("button", "pick-button");
      button.type = "button";
      button.dataset.user = row.user_id;
      button.append(avatarFor(row.user_id, "small soft"), el("span", "pick-name", authorName(row.user_id)));
      item.append(button);
      list.append(item);
    }
  }

  async function startDm(otherId) {
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

    const { data, error } = await supabase.functions.invoke("invite-member", {
      body: personId
        ? { user_id: personId, assignments }
        : { email, display_name: displayName, assignments, redirect_to: location.origin + location.pathname },
    });

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
    const off = status !== "on";
    $("#notif-ic").textContent = off ? "🔕" : "🔔";
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
    const title = el("strong", "", (choice !== "off" ? "🔕 " : "") + name);
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
    $("#mute-rooms-title").textContent = state.ws ? `Salons de « ${state.ws.name} »` : "Salons";
    for (const room of roomList) {
      const extra = isMuted(state.mutes, "workspace", room.workspace_id) ? "Espace en silence" : "";
      rooms.append(muteRow("room", room.id, room.name, extra));
    }
    if (!roomList.length) rooms.append(el("li", "muted", "Aucun salon."));

    // Sous-salons du salon ouvert.
    const current = state.channel && state.channel.kind === "channel" ? roomById(state.channel.room_id) : null;
    const channels = $("#mute-channels");
    channels.replaceChildren();
    const subs = current ? subsOfRoom(current.id) : [];
    $("#mute-salons-title").textContent = current ? `Sous-salons de « ${current.name} »` : "Sous-salons";
    for (const channel of subs) {
      let extra = "";
      if (isMuted(state.mutes, "workspace", channel.workspace_id)) extra = "Espace en silence";
      else if (isMuted(state.mutes, "room", channel.room_id)) extra = "Salon en silence";
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
    on($("#channel-edit"), "click", () => state.channel && openChannelDialog(state.channel));
    on($("#room-delete"), "click", deleteRoom);
    on($("#room-form"), "submit", submitRoom);
    on($("#channel-delete"), "click", deleteChannel);
    on($("#new-dm"), "click", openDmPicker);
    on($("#open-members"), "click", openMembers);
    on($("#open-invite"), "click", openInvite);
    on($("#open-notifications"), "click", openNotifications);
    on($("#channel-bell"), "click", openNotifications);
    on($("#open-profile"), "click", openProfile);
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
    on($("#reply-cancel"), "click", () => {
      state.replyTo = null;
      renderComposerExtra();
    });
    on($("#tags-manage"), "click", openTagsDialog);
    on($("#tags-form"), "submit", submitTag);
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
      if (!screen.classList.contains("sidebar-open")) {
        screen.classList.add("sidebar-open"); // « Retour » depuis un salon : retour à la liste
        guardHistory();
      } else {
        history.back(); // la liste est déjà affichée : on quitte vraiment
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
      if (document.visibilityState === "visible") refresh();
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
