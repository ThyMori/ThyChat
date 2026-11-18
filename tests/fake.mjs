// Faux Supabase en mémoire : reproduit les règles d'accès de la migration 003 (RLS) pour tester l'interface.
import assert from "node:assert/strict";

export function makeFake(currentUser, seed = {}) {
  const db = {
    profiles: [
      { id: "u1", display_name: "Thierry", avatar_url: null, is_super_admin: true },
      { id: "u2", display_name: "Camille", avatar_url: null, is_super_admin: false },
      { id: "u3", display_name: "Marc", avatar_url: null, is_super_admin: false },
    ],
    users: [
      { id: "u1", email: "me@x.fr" },
      { id: "u2", email: "camille@x.fr" },
      { id: "u3", email: "marc@x.fr" },
    ],
    workspaces: [],
    workspace_members: [],
    rooms: [],
    tour_tags: [],
    room_members: [],
    channels: [],
    channel_members: [],
    messages: [],
    tag_documents: [],
    room_sheets: [],
    room_staff: [],
    channel_reads: [],
    notification_mutes: [],
    postits: [],
    postit_states: [],
    message_pins: [],
    push: [],
    invites: [],
    notification_log: [],
    ...seed,
  };
  let counter = 0;
  let clock = Date.parse("2026-11-14T10:00:00Z");
  const uid = () => "id" + ++counter;
  const stamp = () => new Date((clock += 1000)).toISOString();
  const handlers = [];
  const me = () => currentUser.id;
  const profileOf = (id) => db.profiles.find((p) => p.id === id);
  const isSuper = (id = me()) => Boolean(profileOf(id)?.is_super_admin);
  const member = (id, ws) => db.workspace_members.some((m) => m.workspace_id === ws && m.user_id === id);
  const admin = (id, ws) => db.workspace_members.some((m) => m.workspace_id === ws && m.user_id === id && m.role === "admin");
  const inChannel = (id, ch) => db.channel_members.some((m) => m.channel_id === ch && m.user_id === id);
  const roomWs = (room) => db.rooms.find((x) => x.id === room)?.workspace_id;
  const staffHas = (id, room, names, sheetRead = false) => {
    if (admin(id, roomWs(room))) return true;
    if (!canAccessRoom(id, room)) return false;
    const st = db.room_staff.find((x) => x.room_id === room && x.user_id === id);
    return Boolean(st && ((st.functions || []).some((f) => names.includes(f)) || (sheetRead && st.sheet_read)));
  };
  const canAssign = (id, room) => staffHas(id, room, ["prod", "rg"]);
  const inRoom = (id, room) => db.room_members.some((m) => m.room_id === room && m.user_id === id);
  function canAccessRoom(id, roomId) {
    const r = db.rooms.find((x) => x.id === roomId);
    if (!r) return false;
    return admin(id, r.workspace_id) || (member(id, r.workspace_id) && (r.everyone || inRoom(id, r.id)));
  }
  function canAccess(id, chId) {
    const c = db.channels.find((x) => x.id === chId);
    if (!c) return false;
    if (c.kind === "dm") return inChannel(id, c.id);
    if (c.kind === "notes") return c.owner_id === id && canAccessRoom(id, c.room_id);
    if (admin(id, c.workspace_id)) return true;
    if (!canAccessRoom(id, c.room_id)) return false;
    return c.everyone || c.created_by === id || inChannel(id, c.id);
  }
  const manages = (c) => c && c.kind === "channel" && (admin(me(), c.workspace_id) || (c.created_by === me() && canAccessRoom(me(), c.room_id)));
  const rls = { message: "new row violates row-level security policy" };

  function visibleRows(table) {
    const rows = db[table];
    if (table === "rooms") return rows.filter((r) => canAccessRoom(me(), r.id));
    if (table === "tour_tags") return rows.filter((t) => canAccessRoom(me(), t.room_id));
    if (table === "room_staff") return rows.filter((r) => r.user_id === me() || canAssign(me(), r.room_id));
    if (table === "room_sheets") return rows.filter((d) => staffHas(me(), d.room_id, ["technique", "prod", "rg"], true));
    if (table === "tag_documents") return rows.filter((d) => canAccessRoom(me(), db.tour_tags.find((t) => t.id === d.tag_id)?.room_id));
    if (table === "room_members") return rows.filter((m) => m.user_id === me() || canAccessRoom(me(), m.room_id));
    if (table === "channels") return rows.filter((c) => canAccess(me(), c.id));
    if (table === "messages") return rows.filter((m) => canAccess(me(), m.channel_id));
    if (table === "channel_members") return rows.filter((m) => m.user_id === me() || canAccess(me(), m.channel_id));
    if (table === "notification_mutes" || table === "channel_reads" || table === "postit_states" || table === "notification_log") return rows.filter((r) => r.user_id === me());
    if (table === "postits") return rows.filter((r) => canAccess(me(), r.channel_id));
    if (table === "message_pins") return rows.filter((r) => canAccess(me(), r.channel_id) && new Date(r.expires_at) > new Date());
    if (table === "workspaces") return rows.filter((w) => member(me(), w.id));
    return rows;
  }

  function emit(table, payload) {
    for (const h of handlers) if (h.table === table) setTimeout(() => h.cb(payload), 0);
  }
  // Un message écrit par quelqu'un d'autre arrive en temps réel (seulement si on a le droit de le lire).
  function incoming(row) {
    db.messages.push(row);
    if (canAccess(me(), row.channel_id)) emit("messages", { eventType: "INSERT", new: row });
  }

  const net = { off: false, dropReply: false };
  function from(table) {
    const q = { op: "select", filters: [], order: null, limit: null, payload: null, single: false, maybe: false, cols: "*", opts: {} };
    const builder = {
      select(cols) { q.cols = cols ?? "*"; return builder; },
      insert(p) { q.op = "insert"; q.payload = p; return builder; },
      upsert(p, o) { q.op = "upsert"; q.payload = p; q.opts = o || {}; return builder; },
      delete() { q.op = "delete"; return builder; },
      update(p) { q.op = "update"; q.payload = p; return builder; },
      eq(c, v) { q.filters.push((r) => r[c] === v); return builder; },
      is(c, v) { q.filters.push((r) => (r[c] ?? null) === v); return builder; },
      gt(c, v) { q.filters.push((r) => String(r[c]) > String(v)); return builder; },
      overlaps(c, vs) { q.filters.push((r) => (r[c] || []).some((v) => vs.includes(v))); return builder; },
      ilike(c, pat) {
        let re = "";
        for (let k = 0; k < pat.length; k++) {
          const ch = pat[k];
          if (ch === "\\" && k + 1 < pat.length) { re += pat[++k].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
          else if (ch === "%") re += ".*";
          else if (ch === "_") re += ".";
          else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
        const rx = new RegExp("^" + re + "$", "is");
        q.filters.push((r) => rx.test(String(r[c] ?? "")));
        return builder;
      },
      gte(c, v) { q.filters.push((r) => String(r[c]) >= String(v)); return builder; },
      in(c, vs) { q.filters.push((r) => vs.includes(r[c])); return builder; },
      order(c, o) { q.order = [c, o?.ascending !== false]; return builder; },
      limit(n) { q.limit = n; return builder; },
      single() { q.single = true; return builder; },
      maybeSingle() { q.maybe = true; return builder; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };

    function run() {
      if (net.off) return { data: null, error: { message: "TypeError: Failed to fetch", code: "" }, status: 0 };
      if (seed.failTable === table && seed.failMessage) return { data: null, error: { message: seed.failMessage } };
      const rows = db[table];
      if (q.op === "insert" || q.op === "upsert") {
        const list = Array.isArray(q.payload) ? q.payload : [q.payload];
        const made = [];
        for (const p of list) {
          const row = { ...p };
          if (table === "workspaces") {
            if (!isSuper()) return { data: null, error: rls };
            Object.assign(row, { id: uid(), created_by: me(), created_at: stamp() });
            rows.push(row);
            db.workspace_members.push({ workspace_id: row.id, user_id: me(), role: "admin" });
          } else if (table === "rooms") {
            if (!admin(me(), p.workspace_id)) return { data: null, error: rls };
            if (rows.some((r) => r.workspace_id === p.workspace_id && r.name === p.name)) return { data: null, error: { code: "23505", message: "duplicate key value" } };
            Object.assign(row, { id: uid(), everyone: true, description: null, created_at: stamp(), ...p });
            rows.push(row);
          } else if (table === "room_sheets") {
            const room = db.rooms.find((x) => x.id === p.room_id);
            if (!room || !staffHas(me(), p.room_id, ["technique", "rg"])) return { data: null, error: rls };
            if (p.path != null && !String(p.path).startsWith(`${p.room_id}/fiche/`)) return { data: null, error: rls };
            Object.assign(row, { id: uid(), created_at: stamp() });
            rows.push(row);
          } else if (table === "tag_documents") {
            const tag = db.tour_tags.find((t) => t.id === p.tag_id);
            if (!tag || !staffHas(me(), tag.room_id, ["prod"])) return { data: null, error: rls };
            if (p.path != null && !String(p.path).startsWith(`${tag.room_id}/${tag.id}/`)) return { data: null, error: rls };
            Object.assign(row, { id: uid(), created_at: stamp() });
            rows.push(row);
          } else if (table === "tour_tags") {
            const room = db.rooms.find((r) => r.id === p.room_id);
            if (!room || !admin(me(), room.workspace_id)) return { data: null, error: rls };
            if (rows.some((t) => t.room_id === p.room_id && t.label === p.label)) return { data: null, error: { code: "23505", message: "duplicate key value" } };
            Object.assign(row, { id: uid(), start_date: null, end_date: null, shows: [], created_at: stamp(), ...p });
            rows.push(row);
          } else if (table === "room_members") {
            const room = db.rooms.find((r) => r.id === p.room_id);
            if (!room || !canAssign(me(), p.room_id)) return { data: null, error: rls };
            if (!rows.some((m) => m.room_id === p.room_id && m.user_id === p.user_id)) rows.push({ created_at: stamp(), ...p });
          } else if (table === "room_staff") {
            if (!canAssign(me(), p.room_id)) return { data: null, error: rls };
            const old = rows.findIndex((m) => m.room_id === p.room_id && m.user_id === p.user_id);
            if (old >= 0) rows.splice(old, 1);
            rows.push({ functions: [], sheet_read: false, ...p });
          } else if (table === "channels") {
            if (!admin(me(), p.workspace_id) && !(p.room_id && canAccessRoom(me(), p.room_id))) return { data: null, error: rls };
            if (p.room_id && !db.rooms.some((r) => r.id === p.room_id && r.workspace_id === p.workspace_id)) return { data: null, error: rls };
            if (rows.some((c) => c.room_id === p.room_id && c.workspace_id === p.workspace_id && c.name === p.name)) return { data: null, error: { code: "23505", message: "duplicate key value" } };
            Object.assign(row, { id: uid(), kind: "channel", everyone: true, description: null, created_at: stamp(), created_by: me(), ...p });
            rows.push(row);
          } else if (table === "channel_members") {
            const ch = db.channels.find((c) => c.id === p.channel_id);
            if (!manages(ch) || (!admin(me(), ch.workspace_id) && !canAccessRoom(p.user_id, ch.room_id))) return { data: null, error: rls };
            if (!rows.some((m) => m.channel_id === p.channel_id && m.user_id === p.user_id)) rows.push({ created_at: stamp(), ...p });
          } else if (table === "messages") {
            if (!canAccess(me(), p.channel_id)) return { data: null, error: rls };
            if (p.id && rows.some((m) => m.id === p.id)) return { data: null, error: { code: "23505", message: "duplicate key value" } };
            Object.assign(row, { id: p.id || uid(), user_id: me(), parent_id: null, reply_to: null, tag_ids: [], pinned: false, edited_at: null, created_at: stamp(), ...(p.reply_to ? { reply_to: p.reply_to } : {}), ...(p.tag_ids ? { tag_ids: p.tag_ids } : {}), attachments: p.attachments || [] });
            if (!row.body && !row.attachments.length) return { data: null, error: { message: "violates check constraint messages_body_or_attachment_check" } };
            if (row.attachments.some((a) => !String(a.path).startsWith(p.channel_id + "/"))) return { data: null, error: { message: "Image rangée hors du sous-salon" } };
            const ch = db.channels.find((c) => c.id === p.channel_id);
            if (row.reply_to && !db.messages.some((m) => m.id === row.reply_to && m.channel_id === p.channel_id)) return { data: null, error: { message: "La réponse doit viser un message du même sous-salon" } };
            if (row.tag_ids.some((t) => !db.tour_tags.some((g) => g.id === t && g.room_id === ch.room_id))) return { data: null, error: { message: "Étiquette inconnue pour ce salon" } };
            rows.push(row);
            emit("messages", { eventType: "INSERT", new: row });
          } else if (table === "postits") {
            if (!canAccess(me(), p.channel_id)) return { data: null, error: rls };
            if (!String(p.body || "").trim() || p.body.length > 300) return { data: null, error: { message: "violates check constraint" } };
            Object.assign(row, { id: uid(), user_id: me(), created_at: stamp() });
            rows.push(row);
            emit("postits", { eventType: "INSERT", new: row });
          } else if (table === "postit_states") {
            row.user_id = me();
            const at = rows.findIndex((r) => r.postit_id === row.postit_id && r.user_id === row.user_id);
            if (at >= 0) rows[at] = row; else rows.push(row);
          } else if (table === "notification_mutes") {
            const key = (r) => r.user_id === row.user_id && r.scope === row.scope && r.target_id === row.target_id;
            const at = rows.findIndex(key);
            if (at >= 0) rows[at] = row; else rows.push(row);
          } else {
            row.id = row.id || uid();
            rows.push(row);
          }
          made.push(row);
        }
        return { data: q.single ? made[0] : made, error: null };
      }

      let out = visibleRows(table).filter((r) => q.filters.every((f) => f(r)));
      if (q.op === "update") {
        if (table === "workspaces" && !out.every((r) => admin(me(), r.id))) out = [];
        if (table === "workspace_members" && !out.every((r) => admin(me(), r.workspace_id))) out = [];
        if (table === "rooms" && !out.every((r) => admin(me(), r.workspace_id))) out = [];
        if (table === "channels" && !out.every((r) => manages(r))) out = [];
        if (table === "tour_tags" && !out.every((r) => admin(me(), db.rooms.find((x) => x.id === r.room_id).workspace_id))) out = [];
        if (table === "profiles" && ("is_super_admin" in q.payload)) return { data: null, error: { message: "permission denied" } };
        if (table === "profiles") out = out.filter((r) => r.id === me());
        if (table === "postits") { out = out.filter((r) => r.user_id === me()); for (const r of out) emit("postits", { eventType: "UPDATE", new: { ...r, ...q.payload } }); }
        for (const r of out) Object.assign(r, q.payload);
        if (q.single) return { data: out[0] ?? null, error: out[0] ? null : { message: "no rows" } };
        return { data: out, error: null };
      }
      if (q.op === "delete") {
        for (const r of out) {
          if (table === "channels" && r.kind === "dm") {
            if (!db.channel_members.some((m) => m.channel_id === r.id && m.user_id === me())) continue;
            db.channel_members = db.channel_members.filter((m) => m.channel_id !== r.id);
          } else if (table === "channels" && !manages(r)) continue;
          else if (table === "rooms" && !admin(me(), r.workspace_id)) continue;
          if (table === "tour_tags" && !admin(me(), db.rooms.find((x) => x.id === r.room_id).workspace_id)) continue;
          if (table === "room_sheets" && !staffHas(me(), r.room_id, ["technique", "rg"])) continue;
          if (table === "tag_documents" && !staffHas(me(), db.tour_tags.find((t) => t.id === r.tag_id).room_id, ["prod"])) continue;
          if ((table === "room_members" || table === "room_staff") && !canAssign(me(), r.room_id)) continue;
          if (table === "channel_members" && !manages(db.channels.find((c) => c.id === r.channel_id))) continue;
          if (table === "workspace_members" && !admin(me(), r.workspace_id)) continue;
          if (table === "postits" && !(r.user_id === me() || admin(me(), db.channels.find((c) => c.id === r.channel_id).workspace_id))) continue;
          rows.splice(rows.indexOf(r), 1);
          if (table === "postits") { db.postit_states = db.postit_states.filter((x) => x.postit_id !== r.id); emit("postits", { eventType: "DELETE", old: { id: r.id } }); }
          if (table === "messages") emit("messages", { eventType: "DELETE", old: { id: r.id } });
          if (table === "channels") db.messages = db.messages.filter((m) => m.channel_id !== r.id);
          if (table === "tour_tags") db.tag_documents = db.tag_documents.filter((d) => d.tag_id !== r.id);
          if (table === "tour_tags") for (const m of db.messages) m.tag_ids = (m.tag_ids || []).filter((t) => t !== r.id);
          if (table === "rooms") {
            const gone = db.channels.filter((c) => c.room_id === r.id).map((c) => c.id);
            for (let k = db.channels.length - 1; k >= 0; k--) if (db.channels[k].room_id === r.id) db.channels.splice(k, 1);
            db.messages = db.messages.filter((m) => !gone.includes(m.channel_id));
            db.room_members = db.room_members.filter((m) => m.room_id !== r.id);
            for (let k = db.tour_tags.length - 1; k >= 0; k--) if (db.tour_tags[k].room_id === r.id) db.tour_tags.splice(k, 1);
          }
          if (table === "workspace_members") db.room_members = db.room_members.filter((m) => !(m.user_id === r.user_id && db.rooms.find((x) => x.id === m.room_id)?.workspace_id === r.workspace_id));
          if (table === "workspace_members") db.channel_members = db.channel_members.filter((m) => !(m.user_id === r.user_id && db.channels.find((c) => c.id === m.channel_id)?.workspace_id === r.workspace_id));
        }
        return { data: null, error: null };
      }
      if (q.order) {
        const [c, asc] = q.order;
        out = out.slice().sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
      }
      if (q.limit) out = out.slice(0, q.limit);
      if (table === "workspace_members" && q.cols.includes("workspaces(")) {
        out = out.map((m) => ({ ...m, workspaces: db.workspaces.find((w) => w.id === m.workspace_id) }));
      }
      if (q.single || q.maybe) return { data: out[0] ?? null, error: out[0] || q.maybe ? null : { message: "no rows" } };
      return { data: out, error: null };
    }
    return builder;
  }

  const calls = { rpc: [], invoke: [] };

  return {
    net,
    db, calls, from, incoming, emit, canAccess: (id, ch) => canAccess(id, ch),
    channel() {
      const ch = { on(type, cfg, cb) { ch.regs.push({ table: cfg.table, cb }); return ch; }, regs: [], subscribe() { for (const r of ch.regs) handlers.push(r); return ch; } };
      return ch;
    },
    removeChannel(ch) { for (const r of ch.regs) { const i = handlers.indexOf(r); if (i >= 0) handlers.splice(i, 1); } },
    handlerCount: () => handlers.length,
    auth: {
      async updateUser(attrs) { calls.rpc.push(["auth.updateUser", attrs]); return { data: {}, error: null }; },
    },
    storage: {
      files: new Set(),
      docFiles: new Set(),
      from(bucket) {
        const files = this.files;
        return {
          list: async (folder) => ({ data: [...files].filter((p) => p.startsWith(folder + "/")).map((p) => ({ name: p.slice(folder.length + 1) })), error: null }),
          upload: async (path) => { if (net.off) return { error: { message: "Failed to fetch" } }; if (bucket === "message-images") files.add(path); else this.docFiles.add(path); return { error: null }; },
          move: async (from, to) => { if (!files.has(from)) return { error: { message: "Object not found" } }; files.delete(from); files.add(to); return { error: null }; },
          copy: async (from, to) => { if (!files.has(from)) return { error: { message: "Object not found" } }; files.add(to); return { error: null }; },
          remove: async (paths) => { for (const p of [].concat(paths)) { files.delete(p); this.docFiles.delete(p); } return { error: null }; },
          createSignedUrl: async (p) => ({ data: { signedUrl: `https://x.supabase.co/storage/v1/object/sign/${bucket}/${p}?token=t` }, error: null }),
          createSignedUrls: async (paths) => net.off ? ({ data: null, error: { message: "Failed to fetch" } }) : ({ data: paths.map((p) => ({ path: p, signedUrl: `https://x.supabase.co/storage/v1/object/sign/${bucket}/${p}?token=t` })), error: null }),
          getPublicUrl: (path) => ({ data: { publicUrl: `https://x.supabase.co/storage/v1/object/public/avatars/${path}` } }),
        };
      },
    },
    functions: {
      async invoke(name, { body }) {
        calls.invoke.push([name, body]);
        if (seed.functionMissing) return { data: null, error: { name: "FunctionsFetchError", message: "Failed to send a request to the Edge Function" } };
        if (name === "delete-workspace") {
          const ws = db.workspaces.find((w) => w.id === body.workspace_id);
          if (!ws) return { data: null, error: { message: "404", context: { json: async () => ({ error: "Espace introuvable." }) } } };
          if (!admin(me(), ws.id)) return { data: null, error: { message: "403", context: { json: async () => ({ error: "Seul un administrateur de l'espace peut le supprimer." }) } } };
          if (body.confirm_name !== ws.name) return { data: null, error: { message: "400", context: { json: async () => ({ error: "Le nom saisi ne correspond pas à celui de l'espace." }) } } };
          db.workspaces = db.workspaces.filter((w) => w.id !== ws.id);
          db.workspace_members = db.workspace_members.filter((m) => m.workspace_id !== ws.id);
          db.rooms = db.rooms.filter((r) => r.workspace_id !== ws.id);
          db.channels = db.channels.filter((c) => c.workspace_id !== ws.id);
          return { data: { ok: true, files: 0 }, error: null };
        }
        assert.equal(name, "invite-member");
        if (!isSuper()) {
          for (const a of body.assignments) if (!admin(me(), a.workspace_id)) return { data: null, error: { message: "403", context: { status: 403, json: async () => ({ error: "Tu n'es pas administrateur de cet espace." }) } } };
        }
        let user = body.user_id ? db.users.find((u) => u.id === body.user_id) : db.users.find((u) => u.email === body.email);
        if (body.user_id && !user) return { data: null, error: { message: "404" } };
        let invited = false;
        if (!user) {
          user = { id: uid(), email: body.email };
          db.users.push(user);
          db.profiles.push({ id: user.id, display_name: body.display_name || body.email.split("@")[0], avatar_url: null, is_super_admin: false });
          invited = true;
        }
        for (const a of body.assignments) {
          db.workspace_members.push({ workspace_id: a.workspace_id, user_id: user.id, role: a.role });
          for (const rm of a.room_ids || []) db.room_members.push({ room_id: rm, user_id: user.id });
          for (const ch of a.channel_ids || []) db.channel_members.push({ channel_id: ch, user_id: user.id });
        }
        return { data: { ok: true, invited, user_id: user.id }, error: null };
      },
    },
    async rpc(name, args) {
      calls.rpc.push([name, args]);
      if (net.off) return { data: null, error: { message: "TypeError: Failed to fetch", code: "" }, status: 0 };
      if (name === "add_member_by_email") {
        if (!admin(me(), args.ws)) return { error: { message: "Réservé aux administrateurs de cet espace" } };
        const target = db.users.find((u) => u.email.toLowerCase() === args.member_email.toLowerCase());
        if (!target) return { error: { message: "Aucun compte pour cet e-mail." } };
        db.workspace_members.push({ workspace_id: args.ws, user_id: target.id, role: args.member_role });
        return { error: null };
      }
      if (name === "move_message") {
        const m = db.messages.find((x) => x.id === args.msg);
        const dst = db.channels.find((c) => c.id === args.target);
        if (!m || !dst) return { error: { message: "Message introuvable" } };
        const src = db.channels.find((c) => c.id === m.channel_id);
        if (src.kind !== "channel" || dst.kind !== "channel") return { error: { message: "Les messages privés ne se déplacent pas" } };
        if (!admin(me(), src.workspace_id) || src.workspace_id !== dst.workspace_id) return { error: { message: "Réservé aux administrateurs" } };
        const sameRoom = src.room_id === dst.room_id;
        for (const row of db.messages.filter((x) => x.id === m.id || x.parent_id === m.id)) {
          row.channel_id = dst.id;
          row.attachments = (row.attachments || []).map((a) => ({ ...a, path: dst.id + "/" + a.path.slice(a.path.indexOf("/") + 1) }));
          if (!sameRoom) row.tag_ids = [];
          row.reply_to = null;
        }
        return { error: null };
      }
      if (name === "open_dm") {
        if (!member(me(), args.ws) || !member(args.other, args.ws)) return { data: null, error: { message: "Vous devez appartenir tous les deux à cet espace" } };
        const [a, b] = [me(), args.other].sort();
        const dmName = `dm:${a}:${b}`;
        let ch = db.channels.find((c) => c.kind === "dm" && c.name === dmName);
        if (!ch) {
          ch = { id: uid(), workspace_id: args.ws, name: dmName, kind: "dm", everyone: false, description: null, created_at: stamp() };
          db.channels.push(ch);
          db.channel_members.push({ channel_id: ch.id, user_id: a, created_at: stamp() }, { channel_id: ch.id, user_id: b, created_at: stamp() });
        }
        return { data: ch.id, error: null };
      }
      if (name === "search_messages") {
        if (seed.noSearchRpc) return { data: null, error: { code: "PGRST202", message: "Could not find the function public.search_messages in the schema cache" } };
        const fold = (t) => String(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
        const rows = db.messages
          .filter((m) => canAccess(me(), m.channel_id) && !m.parent_id && (!args.in_channel || m.channel_id === args.in_channel) && fold(m.body).includes(fold(args.needle)))
          .sort((x, y) => (x.created_at < y.created_at ? 1 : -1)).slice(0, args.max_rows);
        return { data: rows.map(({ id, channel_id, user_id, body, created_at }) => ({ id, channel_id, user_id, body, created_at })), error: null };
      }
      if (name === "mark_channel_read") {
        if (!canAccess(me(), args.ch)) return { error: null };
        const row = { user_id: me(), channel_id: args.ch, last_read_at: stamp() };
        const at = db.channel_reads.findIndex((r) => r.user_id === me() && r.channel_id === args.ch);
        if (at >= 0) db.channel_reads[at] = row; else db.channel_reads.push(row);
        return { error: null };
      }
      if (name === "my_unread_counts") {
        const out = [];
        for (const c of db.channels) {
          if (!canAccess(me(), c.id)) continue;
          const read = db.channel_reads.find((r) => r.user_id === me() && r.channel_id === c.id);
          const since = read ? read.last_read_at : "1970-01-01T00:00:00Z";
          const n = db.messages.filter((m) => m.channel_id === c.id && m.user_id !== me() && !m.parent_id && m.created_at > since).length;
          if (n) out.push({ channel_id: c.id, workspace_id: c.workspace_id, unread: n });
        }
        return { data: out, error: null };
      }
      if (name === "set_todo_item") {
        const p = db.postits.find((x) => x.id === args.p_id && x.kind === "todo");
        if (!p || !canAccess(me(), p.channel_id)) return { error: { message: "To-Do introuvable" } };
        if (args.p_index < 0 || args.p_index >= p.items.length) return { error: { message: "Case inconnue" } };
        p.items = p.items.map((it, i) => { if (i !== args.p_index) return it; const { by, ...r } = it; return args.p_done ? { ...r, done: true, by: me() } : { ...r, done: false }; });
        emit("postits", { eventType: "UPDATE", new: { ...p } });
        return { error: null };
      }
      if (name === "pin_message" || name === "unpin_message") {
        const m = db.messages.find((x) => x.id === args.msg);
        if (!m || !canAccess(me(), m.channel_id)) return { error: { message: "Message inaccessible" } };
        if (name === "unpin_message") db.message_pins = db.message_pins.filter((p) => p.message_id !== m.id);
        else {
          if (![24, 168, 720].includes(args.hours)) return { error: { message: "Durée invalide" } };
          db.message_pins = db.message_pins.filter((p) => p.message_id !== m.id);
          db.message_pins.push({ message_id: m.id, channel_id: m.channel_id, pinned_by: me(), pinned_at: new Date().toISOString(), expires_at: new Date(Date.now() + args.hours * 3600000).toISOString() });
          const mine = db.message_pins.filter((p) => p.channel_id === m.channel_id).sort((a, b) => b.pinned_at.localeCompare(a.pinned_at) || 0);
          for (const old of mine.slice(3)) db.message_pins = db.message_pins.filter((p) => p !== old);
        }
        emit("message_pins", { eventType: "UPDATE", new: {} });
        return { error: null };
      }
      if (name === "platform_workspaces") {
        if (!isSuper()) return { data: null, error: { message: "Réservé à l'administrateur général" } };
        return { data: db.workspaces.map((w) => ({ id: w.id, name: w.name, theme: w.theme ?? null, avatar_url: null, members: db.workspace_members.filter((m) => m.workspace_id === w.id).length, admins: db.workspace_members.filter((m) => m.workspace_id === w.id && m.role === "admin").length, joined: db.workspace_members.some((m) => m.workspace_id === w.id && m.user_id === me()) })), error: null };
      }
      if (name === "join_workspace_as_support") {
        if (!isSuper()) return { data: null, error: { message: "Réservé à l'administrateur général" } };
        const old = db.workspace_members.find((m) => m.workspace_id === args.ws && m.user_id === me());
        if (old) Object.assign(old, { role: "admin", support: true }); else db.workspace_members.push({ workspace_id: args.ws, user_id: me(), role: "admin", support: true });
        return { data: null, error: null };
      }
      if (name === "open_notes") {
        if (!canAccessRoom(me(), args.rm)) return { error: { message: "Spectacle inaccessible" } };
        let c = db.channels.find((x) => x.kind === "notes" && x.room_id === args.rm && x.owner_id === me());
        if (!c) {
          const r = db.rooms.find((x) => x.id === args.rm);
          c = { id: "n-" + args.rm + "-" + me(), workspace_id: r.workspace_id, room_id: args.rm, name: "notes:x", kind: "notes", everyone: false, owner_id: me(), description: null, created_at: new Date().toISOString() };
          db.channels.push(c);
        }
        return { data: c.id, error: null };
      }
      if (name === "my_notes_usage") {
        const ids = db.channels.filter((c) => c.kind === "notes" && c.owner_id === me()).map((c) => c.id);
        const items = db.messages.filter((m) => ids.includes(m.channel_id)).length + db.postits.filter((p) => ids.includes(p.channel_id)).length;
        return { data: [{ photo_bytes: 3145728, items, photo_limit: 26214400, item_limit: 2000 }], error: null };
      }
      if (name === "save_push_subscription" || name === "remove_push_subscription") return { error: null };
      throw new Error("rpc inattendue : " + name);
    },
  };
}

// Depuis la 3.44.2 l'application s'ouvre sur le calendrier : ce raccourci rouvre le dernier fil (ou le premier), comme avant.
globalThis.openLast = async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(60);
  let last = {};
  try { last = JSON.parse(localStorage.getItem("thychat:last") || "{}"); } catch {}
  const items = [...document.querySelectorAll("#channel-list .channel-item")];
  const pick = items.find((n) => n.dataset.id === last.channel) || items[0];
  if (pick) pick.click();
  await wait(60);
};
