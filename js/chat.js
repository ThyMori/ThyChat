// Interface de messagerie : espaces (une couleur chacun), salons, messages privés, messages en temps réel,
// non lus, silences, membres et invitations, profil.
// Le client Supabase est injecté (aucun import réseau ici) pour pouvoir tester hors navigateur.
// Tout le texte venant des utilisateurs est inséré via textContent : jamais d'innerHTML.

import { PALETTE, DEFAULT_THEME, themeFor, themeByKey, pickUnusedTheme, authorHue } from "./themes.js";
import { MUTE_CHOICES, muteFromChoice, muteKey, isMuted, channelMuted, choiceOf, muteLabel, badgeTotal, countLabel } from "./notify.js";
import { pushStatus, enablePush, disablePush, syncPush, setBadge } from "./push.js";
import { safeAvatarUrl, uploadAvatar, removeAvatar, saveName, changeEmail } from "./profile.js";

const LAST_KEY = "thychat:last";
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
    allChannels: [], // tous les salons et messages privés visibles : { id, workspace_id, name, description, kind, everyone }
    dmMembers: new Map(), // id du message privé -> [ids des deux personnes]
    channel: null,
    messages: [],
    selectedId: null, // message touché (affiche « Supprimer »)
    profiles: new Map(), // id -> { name, avatar }
    unread: new Map(), // id du salon -> nombre de messages non lus
    mutes: new Map(), // « scope:id » -> ligne de notification_mutes
    isSuper: false,
    realtime: null,
    loadToken: 0,
    themeColumn: true, // false tant que la migration SQL des couleurs n'est pas passée
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
  let editingChannel = null; // salon en cours de modification (null = création)

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
  const channelsOfWs = (wsId) => state.allChannels.filter((c) => c.workspace_id === wsId);
  // Salons ouverts à tous d'abord (« Tous »), puis les salons à accès restreint, chacun par ordre alphabétique.
const bySalon = (a, b) => Number(b.everyone) - Number(a.everyone) || byName(a, b);
  const salons = () => (state.ws ? channelsOfWs(state.ws.id).filter((c) => c.kind === "channel").sort(bySalon) : []);
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

  function totalBadge() {
    return badgeTotal(state.unread, state.allChannels, state.mutes);
  }

  async function loadStructure() {
    const channelsResult = await supabase
      .from("channels")
      .select("id, workspace_id, name, description, kind, everyone")
      .order("name");
    if (stopped) return false;
    if (channelsResult.error) {
      showFatal(channelsResult.error);
      return false;
    }
    state.allChannels = channelsResult.data || [];

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
    $("#ws-avatar").textContent = ws ? initials(ws.name, 2) : "?";
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
      row.append(el("span", "avatar", initials(ws.name, 2)));
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
    if (state.channel && state.channel.id === channel.id) item.setAttribute("aria-current", "true");
    const isMuted = muted(channel);
    if (isMuted) item.classList.add("is-muted");

    if (channel.kind === "dm") {
      const partner = dmPartner(channel);
      item.append(partner ? avatarFor(partner) : el("span", "avatar soft", "?"));
    } else {
      item.append(el("span", "avatar soft", initials(channel.name, 1)));
    }

    const text = el("span", "channel-text");
    text.append(el("span", "channel-name", channelTitle(channel)));
    if (channel.kind === "channel" && channel.description) text.append(el("span", "channel-sub", channel.description));
    item.append(text);

    const side = el("span", "channel-side");
    if (channel.kind === "channel" && !channel.everyone) side.append(flag("🔒", "lock-ic", "Accès restreint"));
    if (isMuted) {
      const label = muteLabel(channelMute(channel.id)) || muteLabel(wsMute(channel.workspace_id)) || "Silence";
      side.append(flag("🔕", "mute-ic", label));
    }
    const n = state.unread.get(channel.id) || 0;
    if (n > 0) side.append(flag(countLabel(n), isMuted ? "unread muted" : "unread"));
    item.append(side);
    return item;
  }

  function renderChannels() {
    const list = $("#channel-list");
    list.replaceChildren();
    for (const channel of salons()) list.append(channelItem(channel));

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
    else if (channel && channel.description) parts.push(channel.description);
    let muteNote = "";
    if (channel) {
      const row = isMuted(state.mutes, "channel", channel.id) ? channelMute(channel.id) : wsMute(channel.workspace_id);
      muteNote = muteLabel(row);
    }
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
  }

  function renderMessages(forceBottom = false) {
    const box = $("#messages");
    const previousTop = box.scrollTop;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.replaceChildren();

    if (!state.messages.length) {
      box.append(el("p", "muted empty-note", "Aucun message pour l'instant. Écris le premier !"));
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
      const item = el("article", classes.join(" "));
      item.dataset.id = message.id;
      if (deletable) item.dataset.deletable = "true";

      const bubble = el("div", "bubble");
      if (!mine && !grouped) {
        const author = el("div", "msg-author", authorName(message.user_id));
        author.style.color = `hsl(${authorHue(message.user_id)} 70% 74%)`;
        bubble.append(author);
      }

      const body = el("div", "msg-body");
      renderBody(body, message.body);
      const time = el("time", "msg-time", timeFmt.format(date));
      time.dateTime = date.toISOString();
      body.append(time);
      bubble.append(body);
      item.append(bubble);

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
        "Exécute le fichier supabase/migrations/003_roles_salons_push.sql (ou supabase/schema.sql) dans l'éditeur SQL de Supabase, puis recharge la page. (" +
        error.message +
        ")",
    });
  }

  async function fetchMemberships() {
    let result = await supabase
      .from("workspace_members")
      .select("role, workspaces(id, name, theme)")
      .eq("user_id", user.id);
    if (result.error && /theme/i.test(result.error.message)) {
      // Migration des couleurs pas encore exécutée : on continue sans (couleur déduite de l'id).
      state.themeColumn = false;
      result = await supabase.from("workspace_members").select("role, workspaces(id, name)").eq("user_id", user.id);
    }
    return result;
  }

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
        role: row.role,
      });
    }
    if (state.isSuper) {
      // L'administrateur général voit et administre tous les espaces.
      const all = await supabase.from("workspaces").select(state.themeColumn ? "id, name, theme" : "id, name");
      for (const ws of all.data || []) {
        if (!byId.has(ws.id)) byId.set(ws.id, { id: ws.id, name: ws.name, theme: ws.theme ?? null, role: "admin" });
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
    state.channel = state.allChannels.find((c) => c.id === id) || null;
    state.selectedId = null;
    renderChannels();
    renderHeader();

    if (!state.channel) {
      state.messages = [];
      setView("empty", {
        title: "Aucun salon",
        text: isAdmin()
          ? "Crée le premier salon de cet espace (par exemple « Tous » ou « Technique »)."
          : "Tu n'as accès à aucun salon dans cet espace pour l'instant. Un administrateur peut t'y ajouter.",
        action: isAdmin() ? "Créer un salon" : "",
        onAction: () => openChannelDialog(null),
      });
      closeSidebar();
      return;
    }

    writeLast({ channel: state.channel.id });
    guardHistory();
    setView("chat");
    state.messages = [];
    renderMessages(true);
    closeSidebar();
    markRead(state.channel.id);

    await loadMessages(state.channel.id, token);
  }

  async function loadMessages(channelId, token) {
    const { data, error } = await supabase
      .from("messages")
      .select("id, channel_id, user_id, parent_id, body, pinned, created_at, edited_at")
      .eq("channel_id", channelId)
      .is("parent_id", null)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE);
    if (stopped || token !== state.loadToken) return;
    if (error) {
      toast("Messages illisibles : " + error.message);
      return;
    }
    state.messages = (data || []).slice().reverse();
    await ensureProfiles(state.messages.map((m) => m.user_id));
    if (stopped || token !== state.loadToken) return;
    renderMessages(true);
  }

  // --- Temps réel ------------------------------------------------------------
  // Un seul abonnement pour tous les messages visibles (le RLS filtre) : il alimente la conversation
  // ouverte et les pastilles de non lus des autres salons.

  function subscribe() {
    if (state.realtime) return;
    state.realtime = supabase
      .channel("thychat:live")
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, onRealtime)
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
        if (stopped || !state.channel || state.channel.id !== message.channel_id) return;
        addMessage(message, mine);
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

    input.value = "";
    autosize();
    const { data, error } = await supabase
      .from("messages")
      .insert({ channel_id: state.channel.id, body })
      .select()
      .single();

    if (error) {
      input.value = body;
      autosize();
      toast("Message non envoyé : " + error.message);
      return;
    }
    addMessage(data, true);
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
    // Le créateur est devenu administrateur (trigger SQL) : on crée un premier salon ouvert à tous.
    await supabase.from("channels").insert({ workspace_id: data.id, name: "Tous", everyone: true });
    button.disabled = false;
    closeDialog($("#dialog-workspace"));
    if (!state.themeColumn) toast(THEME_SQL_HINT, "info");
    await loadWorkspaces(data.id);
  }

  function renderThemeSettings() {
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

  const accessMode = () => document.querySelector('input[name="channel-access"]:checked')?.value || "everyone";

  async function openChannelDialog(channel) {
    if (!state.ws || !isAdmin()) return;
    editingChannel = channel || null;
    $("#channel-dialog-title").textContent = channel ? "Salon" : "Nouveau salon";
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
    const users = (await workspaceUsers(state.ws.id)).filter((row) => row.role !== "admin");
    renderPick($("#channel-pick"), users, checked);
  }

  async function submitChannel(event) {
    event.preventDefault();
    const name = $("#channel-name").value.trim().replace(/^#+\s*/, "");
    const description = $("#channel-description").value.trim();
    if (!name) return setNotice("#channel-message", "Donne un nom au salon.");

    const everyone = accessMode() === "everyone";
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
      // Aligne la liste des personnes assignées.
      const { data: current } = await supabase.from("channel_members").select("user_id").eq("channel_id", channel.id);
      const have = new Set((current || []).map((row) => row.user_id));
      const want = new Set(everyone ? [] : picked);
      const added = [...want].filter((id) => !have.has(id));
      const removed = [...have].filter((id) => !want.has(id));
      if (everyone) {
        // Ouvert à tous : les assignations n'ont plus d'effet, on les garde pour un éventuel retour.
      } else {
        if (added.length) await supabase.from("channel_members").insert(added.map((id) => ({ channel_id: channel.id, user_id: id })));
        if (removed.length) await supabase.from("channel_members").delete().eq("channel_id", channel.id).in("user_id", removed);
      }
    } else {
      const { data, error } = await supabase
        .from("channels")
        .insert({ workspace_id: state.ws.id, name, description: description || null, everyone })
        .select()
        .single();
      if (error) return channelError(error, button);
      channel = data;
      if (!everyone && picked.length) {
        await supabase.from("channel_members").insert(picked.map((id) => ({ channel_id: channel.id, user_id: id })));
      }
    }

    button.disabled = false;
    closeDialog($("#dialog-channel"));
    await refreshStructure();
    if (!editingChannel) await selectChannel(channel.id);
    editingChannel = null;
  }

  function channelError(error, button) {
    button.disabled = false;
    const text = error.code === "23505" ? "Un salon porte déjà ce nom." : "Enregistrement impossible : " + error.message;
    setNotice("#channel-message", text);
  }

  async function deleteChannel() {
    if (!editingChannel) return;
    if (!window.confirm(`Supprimer le salon « ${editingChannel.name} » et tous ses messages ? Cette action est définitive.`)) return;
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

  function openInvite() {
    if (!state.ws || !isAdmin()) return;
    $("#invite-email").value = "";
    $("#invite-name").value = "";
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
      const restricted = channelsOfWs(checkbox.value).filter((c) => c.kind === "channel" && !c.everyone).sort(byName);
      if (!restricted.length) continue;
      any = true;
      const ws = state.workspaces.find((w) => w.id === checkbox.value);
      const group = el("div", "invite-group");
      group.append(el("strong", "", ws.name));
      for (const channel of restricted) {
        const label = el("label", "pick-row");
        const input = el("input");
        input.type = "checkbox";
        input.value = channel.id;
        input.dataset.ws = ws.id;
        input.checked = kept.has(channel.id);
        label.append(input, el("span", "pick-name", channel.name));
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
    const email = $("#invite-email").value.trim();
    const displayName = $("#invite-name").value.trim();
    if (!email) return setNotice("#invite-message", "Saisis l'adresse e-mail de la personne.");

    const assignments = [];
    for (const row of document.querySelectorAll("#invite-spaces .invite-space")) {
      const checkbox = row.querySelector("input");
      if (!checkbox.checked) continue;
      const role = row.querySelector("select").value;
      const channelIds =
        role === "admin"
          ? []
          : [...document.querySelectorAll(`#invite-salons input[data-ws="${checkbox.value}"]:checked`)].map((i) => i.value);
      assignments.push({ workspace_id: checkbox.value, role, channel_ids: channelIds });
    }
    if (!assignments.length) return setNotice("#invite-message", "Choisis au moins un espace.");

    const button = $("#invite-submit");
    button.disabled = true;
    setNotice("#invite-message", "");

    const { data, error } = await supabase.functions.invoke("invite-member", {
      body: { email, display_name: displayName, assignments, redirect_to: location.origin + location.pathname },
    });

    if (error) {
      const notDeployed = error.name === "FunctionsFetchError" || error.context?.status === 404;
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

    const channels = $("#mute-channels");
    channels.replaceChildren();
    $("#mute-salons-title").textContent = state.ws ? `Salons de « ${state.ws.name} »` : "Salons";
    const list = state.ws ? [...salons(), ...dms()] : [];
    for (const channel of list) {
      const extra = isMuted(state.mutes, "workspace", channel.workspace_id) ? "Espace en silence" : "";
      channels.append(muteRow("channel", channel.id, channelTitle(channel), extra));
    }
    if (!list.length) channels.append(el("li", "muted", "Aucun salon."));
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
    on($("#new-channel"), "click", () => openChannelDialog(null));
    on($("#channel-edit"), "click", () => state.channel && openChannelDialog(state.channel));
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
    on($("#channel-list"), "click", openFromList);
    on($("#dm-list"), "click", openFromList);

    on($("#dm-pick"), "click", (event) => {
      const button = event.target.closest("[data-user]");
      if (button) startDm(button.dataset.user);
    });

    for (const radio of document.querySelectorAll('input[name="channel-access"]')) {
      on(radio, "change", () => {
        $("#channel-pick").hidden = accessMode() !== "some";
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
    on($("#mute-channels"), "change", (event) => {
      const select = event.target.closest(".mute-select");
      if (select) setMute(select.dataset.scope, select.dataset.id, select.value);
    });
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
    on($("#profile-form"), "submit", submitProfile);

    on($("#messages"), "click", (event) => {
      const remove = event.target.closest("[data-action='delete']");
      if (remove) return deleteMessage(remove.dataset.id);
      if (event.target.closest("a")) return; // un lien s'ouvre, sans sélectionner le message
      // Toucher un message le sélectionne (affiche « Supprimer ») ; toucher ailleurs désélectionne.
      const row = event.target.closest(".msg[data-deletable]");
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
    on(input, "input", autosize);
    on(input, "keydown", (event) => {
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
    state.allChannels = [];
    state.channel = null;
    state.messages = [];
    state.selectedId = null;
    state.unread = new Map();
    state.mutes = new Map();
    state.themeColumn = true;
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
