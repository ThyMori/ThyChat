// Interface de messagerie : espaces, canaux, messages en temps réel, membres.
// Le client Supabase est injecté (aucun import réseau ici) pour pouvoir tester hors navigateur.
// Tout le texte venant des utilisateurs est inséré via textContent : jamais d'innerHTML.

const LAST_KEY = "thychat:last";
const PAGE_SIZE = 100;
const GROUP_WINDOW_MS = 5 * 60 * 1000;
const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

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

export function createChat({ supabase, user }) {
  const fallbackName = user.user_metadata?.display_name || user.email || "Moi";
  const state = {
    workspaces: [], // { id, name, role }
    ws: null,
    channels: [],
    channel: null,
    messages: [],
    profiles: new Map(),
    realtime: null,
    loadToken: 0,
  };
  let controller = null; // détache tous les écouteurs à l'arrêt
  let stopped = false;
  let emptyAction = null;
  let toastTimer = null;

  // --- Petits utilitaires d'interface ------------------------------------

  function toast(text, kind = "error") {
    const node = $("#toast");
    node.textContent = text;
    node.dataset.kind = kind;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.hidden = true;
    }, 5000);
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

  // --- Rendu ---------------------------------------------------------------

  function renderWorkspaceSelect() {
    const select = $("#workspace-select");
    select.replaceChildren();
    for (const ws of state.workspaces) {
      const option = el("option", "", ws.name);
      option.value = ws.id;
      select.append(option);
    }
    if (state.ws) select.value = state.ws.id;
    $("#open-members").hidden = !state.ws;
    $("#new-channel").hidden = !state.ws || !isAdmin();
  }

  function renderChannels() {
    const list = $("#channel-list");
    list.replaceChildren();
    for (const channel of state.channels) {
      const button = el("button", "channel-item", `# ${channel.name}`);
      button.type = "button";
      button.dataset.id = channel.id;
      if (state.channel && state.channel.id === channel.id) button.setAttribute("aria-current", "true");
      list.append(button);
    }
  }

  function renderMessages(forceBottom = false) {
    const box = $("#messages");
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.replaceChildren();

    if (!state.messages.length) {
      box.append(el("p", "muted empty-note", "Aucun message pour l'instant. Écris le premier !"));
    }

    let previous = null;
    for (const message of state.messages) {
      const date = new Date(message.created_at);
      const newDay = !previous || dayKey(new Date(previous.created_at)) !== dayKey(date);
      if (newDay) box.append(el("div", "day-divider", dayFmt.format(date)));

      const grouped =
        !newDay &&
        previous.user_id === message.user_id &&
        date - new Date(previous.created_at) < GROUP_WINDOW_MS;

      const item = el("article", grouped ? "msg grouped" : "msg");
      item.dataset.id = message.id;

      if (!grouped) {
        const meta = el("div", "msg-meta");
        meta.append(el("strong", "msg-author", authorName(message.user_id)));
        const time = el("time", "", timeFmt.format(date));
        time.dateTime = date.toISOString();
        meta.append(time);
        item.append(meta);
      }

      const body = el("div", "msg-body");
      renderBody(body, message.body);
      item.append(body);

      if (message.user_id === user.id || isAdmin()) {
        const remove = el("button", "msg-del", "Supprimer");
        remove.type = "button";
        remove.dataset.action = "delete";
        remove.dataset.id = message.id;
        item.append(remove);
      }

      box.append(item);
      previous = message;
    }

    if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
  }

  // --- Chargement des données ---------------------------------------------

  function showFatal(error) {
    console.warn("Erreur de chargement :", error.message);
    setView("empty", {
      title: "La base n'est pas prête",
      text: "Exécute le fichier supabase/schema.sql dans l'éditeur SQL de Supabase, puis recharge la page. (" + error.message + ")",
    });
  }

  async function loadWorkspaces(preferredId) {
    const { data, error } = await supabase
      .from("workspace_members")
      .select("role, workspaces(id, name)")
      .eq("user_id", user.id);
    if (stopped) return;
    if (error) return showFatal(error);

    state.workspaces = (data || [])
      .filter((row) => row.workspaces)
      .map((row) => ({ id: row.workspaces.id, name: row.workspaces.name, role: row.role }))
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));

    if (!state.workspaces.length) {
      state.ws = null;
      state.channels = [];
      state.channel = null;
      renderWorkspaceSelect();
      renderChannels();
      $("#channel-title").textContent = "ThyChat";
      $("#channel-desc").textContent = "";
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
    renderWorkspaceSelect();

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
    renderChannels();

    if (!state.channel) {
      state.messages = [];
      $("#channel-title").textContent = state.ws ? state.ws.name : "ThyChat";
      $("#channel-desc").textContent = "";
      setView("empty", {
        title: "Aucun canal",
        text: isAdmin()
          ? "Crée le premier canal de cet espace (par exemple « général » ou le nom d'une production)."
          : "Un administrateur de l'espace doit d'abord créer un canal.",
        action: isAdmin() ? "Créer un canal" : "",
        onAction: () => openChannelDialog(),
      });
      closeSidebar();
      return;
    }

    writeLast({ channel: state.channel.id });
    $("#channel-title").textContent = `# ${state.channel.name}`;
    $("#channel-desc").textContent = state.channel.description || "";
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

  function openWorkspaceDialog() {
    $("#workspace-name").value = "";
    setNotice("#workspace-message", "");
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
    const { data, error } = await supabase.from("workspaces").insert({ name }).select().single();
    if (error) {
      button.disabled = false;
      return setNotice("#workspace-message", "Création impossible : " + error.message);
    }
    // Le créateur est devenu administrateur (trigger SQL) : on crée un premier canal.
    await supabase.from("channels").insert({ workspace_id: data.id, name: "général" });
    button.disabled = false;
    closeDialog($("#dialog-workspace"));
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
    if (!name) return setNotice("#channel-message", "Donne un nom au canal.");

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
      const text = error.code === "23505" ? "Un canal porte déjà ce nom." : "Création impossible : " + error.message;
      return setNotice("#channel-message", text);
    }
    closeDialog($("#dialog-channel"));
    state.channels.push(data);
    state.channels.sort((a, b) => a.name.localeCompare(b.name, "fr"));
    await selectChannel(data.id);
  }

  async function openMembers() {
    if (!state.ws) return;
    $("#members-title").textContent = `Membres de ${state.ws.name}`;
    $("#add-member-form").hidden = !isAdmin();
    $("#member-email").value = "";
    setNotice("#members-message", "");
    openDialog("#dialog-members");
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

  // --- Branchement des événements (une seule fois) ---------------------------

  function bind() {
    if (controller) return;
    controller = new AbortController();
    const opts = { signal: controller.signal };
    const on = (target, type, handler) => target.addEventListener(type, handler, opts);

    on($("#workspace-select"), "change", (event) => selectWorkspace(event.target.value));
    on($("#new-workspace"), "click", openWorkspaceDialog);
    on($("#new-channel"), "click", openChannelDialog);
    on($("#open-members"), "click", openMembers);
    on($("#empty-action"), "click", () => emptyAction && emptyAction());

    on($("#channel-list"), "click", (event) => {
      const button = event.target.closest(".channel-item");
      if (button) selectChannel(button.dataset.id);
    });

    on($("#messages"), "click", (event) => {
      const button = event.target.closest("[data-action='delete']");
      if (button) deleteMessage(button.dataset.id);
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
    if (controller) {
      controller.abort();
      controller = null;
    }
  }

  return { userId: user.id, start, stop };
}
