// Interface de messagerie : espaces (une couleur chacun), discussions, messages en temps réel, membres.
// Le client Supabase est injecté (aucun import réseau ici) pour pouvoir tester hors navigateur.
// Tout le texte venant des utilisateurs est inséré via textContent : jamais d'innerHTML.

import { PALETTE, DEFAULT_THEME, themeFor, themeByKey, pickUnusedTheme, authorHue } from "./themes.js";

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

// Initiales pour les pastilles rondes (1 lettre pour une discussion, jusqu'à 2 pour un espace).
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

function openDialog(selector) {
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
    channels: [],
    channel: null,
    messages: [],
    selectedId: null, // message touché (affiche « Supprimer »)
    profiles: new Map(),
    realtime: null,
    loadToken: 0,
    themeColumn: true, // false tant que la migration SQL des couleurs n'est pas passée
  };
  let controller = null; // détache tous les écouteurs à l'arrêt
  let stopped = false;
  let emptyAction = null;
  let toastTimer = null;
  let pendingTheme = DEFAULT_THEME.key;

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

  function authorName(userId) {
    return state.profiles.get(userId) || "Membre";
  }

  function isAdmin() {
    return state.ws?.role === "admin";
  }

  async function ensureProfiles(ids) {
    const missing = [...new Set(ids)].filter((id) => id && !state.profiles.has(id));
    if (!missing.length) return;
    const { data, error } = await supabase.from("profiles").select("id, display_name").in("id", missing);
    if (error) {
      console.warn("Profils illisibles :", error.message);
      return;
    }
    for (const profile of data || []) state.profiles.set(profile.id, profile.display_name || "Membre");
  }

  // --- Thème de l'espace ---------------------------------------------------

  // Teinte toute l'interface avec la couleur de l'espace courant.
  function applyTheme() {
    const theme = state.ws ? themeFor(state.ws) : DEFAULT_THEME;
    $("#screen-app").style.setProperty("--h", String(theme.hue));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", `hsl(${theme.hue} 14% 11.5%)`);
    document.title = state.ws ? `${state.ws.name} · ThyChat` : "ThyChat";
  }

  function resetTheme() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", "#0e0e11");
    document.title = "ThyChat";
  }

  // --- Rendu ---------------------------------------------------------------

  function renderWorkspaceHeader() {
    const ws = state.ws;
    $("#ws-avatar").textContent = ws ? initials(ws.name, 2) : "?";
    $("#ws-name").textContent = ws ? ws.name : "Espaces";
    $("#ws-sub").textContent = ws ? (ws.role === "admin" ? "Administrateur" : "Membre") : "";
    $("#open-members").hidden = !ws;
    $("#new-channel").hidden = !ws || !isAdmin();
    renderSwitchList();
    applyTheme();
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
      row.append(el("span", "avatar", initials(ws.name, 2)));
      const text = el("span", "ws-text");
      text.append(el("strong", "", ws.name), el("small", "", ws.role === "admin" ? "Administrateur" : "Membre"));
      row.append(text);
      item.append(row);
      list.append(item);
    }
  }

  function renderChannels() {
    const list = $("#channel-list");
    list.replaceChildren();
    for (const channel of state.channels) {
      const item = el("button", "channel-item");
      item.type = "button";
      item.dataset.id = channel.id;
      if (state.channel && state.channel.id === channel.id) item.setAttribute("aria-current", "true");
      item.append(el("span", "avatar soft", initials(channel.name, 1)));
      const text = el("span", "channel-text");
      text.append(el("span", "channel-name", channel.name));
      if (channel.description) text.append(el("span", "channel-sub", channel.description));
      item.append(text);
      list.append(item);
    }
  }

  function renderHeader() {
    const channel = state.channel;
    $("#channel-avatar").textContent = channel ? initials(channel.name, 1) : "";
    $("#channel-avatar").hidden = !channel;
    $("#channel-title").textContent = channel ? channel.name : state.ws ? state.ws.name : "ThyChat";
    const parts = [];
    if (channel && state.ws) parts.push(state.ws.name);
    if (channel && channel.description) parts.push(channel.description);
    $("#channel-desc").textContent = parts.join(" · ");
  }

  function renderMessages(forceBottom = false) {
    const box = $("#messages");
    const previousTop = box.scrollTop;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.replaceChildren();

    if (!state.messages.length) {
      box.append(el("p", "muted empty-note", "Aucun message pour l'instant. Écris le premier !"));
    }

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
      const deletable = mine || isAdmin();

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
      text: "Exécute le fichier supabase/schema.sql dans l'éditeur SQL de Supabase, puis recharge la page. (" + error.message + ")",
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

    state.workspaces = (data || [])
      .filter((row) => row.workspaces)
      .map((row) => ({
        id: row.workspaces.id,
        name: row.workspaces.name,
        theme: row.workspaces.theme ?? null,
        role: row.role,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));

    if (!state.workspaces.length) {
      state.ws = null;
      state.channels = [];
      state.channel = null;
      renderWorkspaceHeader();
      renderChannels();
      renderHeader();
      setView("empty", {
        title: "Bienvenue",
        text: "Crée ton premier espace pour commencer, ou attends d'être ajouté à celui d'une équipe.",
        action: "Créer mon premier espace",
        onAction: () => openWorkspaceDialog(),
      });
      return;
    }

    const wanted = preferredId || readLast().ws;
    const target = state.workspaces.find((ws) => ws.id === wanted) || state.workspaces[0];
    await selectWorkspace(target.id);
  }

  async function selectWorkspace(id) {
    state.ws = state.workspaces.find((ws) => ws.id === id) || null;
    if (!state.ws) return;
    writeLast({ ws: id });
    state.selectedId = null;
    renderWorkspaceHeader();

    const { data, error } = await supabase
      .from("channels")
      .select("id, name, description")
      .eq("workspace_id", id)
      .order("name");
    if (stopped || !state.ws || state.ws.id !== id) return;
    if (error) return showFatal(error);

    state.channels = data || [];
    const wanted = readLast().channel;
    const target = state.channels.find((c) => c.id === wanted) || state.channels[0] || null;
    await selectChannel(target ? target.id : null);
  }

  async function selectChannel(id) {
    const token = ++state.loadToken;
    unsubscribe();
    state.channel = state.channels.find((c) => c.id === id) || null;
    state.selectedId = null;
    renderChannels();
    renderHeader();

    if (!state.channel) {
      state.messages = [];
      setView("empty", {
        title: "Aucune discussion",
        text: isAdmin()
          ? "Crée la première discussion de cet espace (par exemple « général » ou le nom d'une production)."
          : "Un administrateur de l'espace doit d'abord créer une discussion.",
        action: isAdmin() ? "Créer une discussion" : "",
        onAction: () => openChannelDialog(),
      });
      closeSidebar();
      return;
    }

    writeLast({ channel: state.channel.id });
    setView("chat");
    state.messages = [];
    renderMessages(true);
    closeSidebar();

    await loadMessages(state.channel.id, token);
    if (stopped || token !== state.loadToken) return;
    subscribe(state.channel.id);
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

  function subscribe(channelId) {
    state.realtime = supabase
      .channel(`messages:${channelId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages", filter: `channel_id=eq.${channelId}` },
        onRealtime
      )
      .subscribe();
  }

  function unsubscribe() {
    if (state.realtime) {
      supabase.removeChannel(state.realtime);
      state.realtime = null;
    }
  }

  async function onRealtime(payload) {
    if (stopped || !state.channel) return;
    const channelId = state.channel.id;

    if (payload.eventType === "INSERT") {
      const message = payload.new;
      if (message.channel_id !== channelId || message.parent_id) return;
      await ensureProfiles([message.user_id]);
      if (stopped || !state.channel || state.channel.id !== channelId) return;
      addMessage(message, message.user_id === user.id);
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

  // --- Boîtes de dialogue ---------------------------------------------------

  function openSwitch() {
    if (!state.workspaces.length) return openWorkspaceDialog();
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
    // Le créateur est devenu administrateur (trigger SQL) : on crée une première discussion.
    await supabase.from("channels").insert({ workspace_id: data.id, name: "général" });
    button.disabled = false;
    closeDialog($("#dialog-workspace"));
    if (!state.themeColumn) toast(THEME_SQL_HINT, "info");
    await loadWorkspaces(data.id);
  }

  function openChannelDialog() {
    if (!state.ws || !isAdmin()) return;
    $("#channel-name").value = "";
    $("#channel-description").value = "";
    setNotice("#channel-message", "");
    openDialog("#dialog-channel");
    $("#channel-name").focus();
  }

  async function submitChannel(event) {
    event.preventDefault();
    const name = $("#channel-name").value.trim().replace(/^#+\s*/, "");
    const description = $("#channel-description").value.trim();
    if (!name) return setNotice("#channel-message", "Donne un nom à la discussion.");

    const button = $("#channel-submit");
    button.disabled = true;
    setNotice("#channel-message", "");
    const { data, error } = await supabase
      .from("channels")
      .insert({ workspace_id: state.ws.id, name, description: description || null })
      .select()
      .single();
    button.disabled = false;

    if (error) {
      const text = error.code === "23505" ? "Une discussion porte déjà ce nom." : "Création impossible : " + error.message;
      return setNotice("#channel-message", text);
    }
    closeDialog($("#dialog-channel"));
    state.channels.push(data);
    state.channels.sort((a, b) => a.name.localeCompare(b.name, "fr"));
    await selectChannel(data.id);
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

  async function openMembers() {
    if (!state.ws) return;
    $("#members-title").textContent = state.ws.name;
    $("#add-member-form").hidden = !isAdmin();
    $("#member-email").value = "";
    setNotice("#members-message", "");
    renderThemeSettings();
    openDialog("#dialog-members");
    $("#members-title").focus(); // évite que la première pastille de couleur prenne le focus
    await refreshMembers();
  }

  async function refreshMembers() {
    const list = $("#members-list");
    const { data, error } = await supabase
      .from("workspace_members")
      .select("user_id, role")
      .eq("workspace_id", state.ws.id);
    if (error) return setNotice("#members-message", "Liste illisible : " + error.message);

    await ensureProfiles((data || []).map((row) => row.user_id));
    list.replaceChildren();
    const rows = (data || []).slice().sort((a, b) => authorName(a.user_id).localeCompare(authorName(b.user_id), "fr"));
    for (const row of rows) {
      const item = el("li", "member");
      item.append(el("span", "member-name", authorName(row.user_id)));
      item.append(el("span", "badge", row.role === "admin" ? "Admin" : "Membre"));
      list.append(item);
    }
  }

  async function submitMember(event) {
    event.preventDefault();
    const email = $("#member-email").value.trim();
    const role = $("#member-role").value;
    if (!email) return setNotice("#members-message", "Saisis l'e-mail de la personne.");

    const button = $("#member-submit");
    button.disabled = true;
    setNotice("#members-message", "");
    const { error } = await supabase.rpc("add_member_by_email", {
      ws: state.ws.id,
      member_email: email,
      member_role: role,
    });
    button.disabled = false;

    if (error) return setNotice("#members-message", error.message);
    $("#member-email").value = "";
    setNotice("#members-message", "Membre ajouté.", "ok");
    await refreshMembers();
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
    on($("#new-channel"), "click", openChannelDialog);
    on($("#open-members"), "click", openMembers);
    on($("#empty-action"), "click", () => emptyAction && emptyAction());

    on($("#channel-list"), "click", (event) => {
      const button = event.target.closest(".channel-item");
      if (button) selectChannel(button.dataset.id);
    });

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
    on($("#add-member-form"), "submit", submitMember);
    for (const button of document.querySelectorAll("[data-close]")) {
      on(button, "click", () => closeDialog(button.closest("dialog")));
    }

    on($("#open-sidebar"), "click", () => $("#screen-app").classList.add("sidebar-open"));
    on($("#close-sidebar"), "click", closeSidebar);
    on($("#backdrop"), "click", closeSidebar);

    // Retour au premier plan ou reconnexion : on rattrape les messages manqués.
    const refresh = () => {
      if (stopped || !state.channel) return;
      loadMessages(state.channel.id, state.loadToken);
    };
    on(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") refresh();
    });
    on(window, "online", refresh);
  }

  // --- Cycle de vie --------------------------------------------------------------

  async function start() {
    stopped = false;
    bind();
    unsubscribe();
    state.workspaces = [];
    state.ws = null;
    state.channels = [];
    state.channel = null;
    state.messages = [];
    state.selectedId = null;
    state.themeColumn = true;

    let name = fallbackName;
    const { data } = await supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle();
    if (data && data.display_name) name = data.display_name;
    state.profiles.set(user.id, name);
    $("#me-name").textContent = name;

    await loadWorkspaces();
  }

  function stop() {
    stopped = true;
    state.loadToken++;
    unsubscribe();
    resetTheme();
    if (controller) {
      controller.abort();
      controller = null;
    }
  }

  return { userId: user.id, start, stop };
}
