// Fonction Supabase « send-push » : envoie une notification push à chaque personne concernée
// par un nouveau message ou un nouveau PDF (date ou fiche technique), sauf l'auteur,
// et sauf les espaces / salons mis en silence.
//
// Appelée par les déclencheurs SQL (migrations 004 et 014) sur INSERT de public.messages,
// public.tag_documents et public.room_sheets (voir README).
// Secrets à définir : VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_WEBHOOK_SECRET.
// Désactive « Enforce JWT Verification » : l'appel est authentifié par l'en-tête x-webhook-secret.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + "…" : text);

// Historique des notifications (la cloche de l'application, migration 033) : une ligne par personne prévenue,
// inscrite AVANT l'envoi push (la personne la retrouve même sans abonnement push ou appareil éteint).
// Un échec ici ne doit jamais empêcher l'envoi : si la table n'existe pas encore, on ignore.
// deno-lint-ignore no-explicit-any
async function logNotifications(admin: any, userIds: string[], entry: { kind: string; title: string; body: string; workspace_id: string; channel_id: string | null }) {
  try {
    const rows = userIds.map((user_id) => ({ user_id, ...entry }));
    const { error } = await admin.from("notification_log").insert(rows);
    if (error) {
      console.error("Historique : écriture impossible", error.message);
      return;
    }
    // Purge : on garde 30 jours.
    const limit = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    await admin.from("notification_log").delete().lt("created_at", limit);
  } catch (error) {
    console.error("Historique : erreur", (error as Error).message);
  }
}

// Nouveau PDF (document d'une date ou fiche technique) : prévient toutes les personnes qui ont accès au spectacle.
// deno-lint-ignore no-explicit-any
async function notifyDocument(admin: any, table: string, doc: Record<string, any>) {
  let roomId: string | null = null;
  let detail = "";
  if (table === "tag_documents") {
    const { data: tag } = await admin.from("tour_tags").select("room_id, label").eq("id", doc.tag_id).maybeSingle();
    if (!tag) return json({ ok: true, skipped: true });
    roomId = tag.room_id;
    detail = `${doc.name} · ${tag.label}`;
  } else {
    roomId = doc.room_id;
    const day = String(doc.version_date || "").split("-").reverse().join("/");
    detail = `Fiche technique${day ? " (version du " + day + ")" : ""}`;
  }
  const { data: room } = await admin.from("rooms").select("id, name, everyone, workspace_id").eq("id", roomId).maybeSingle();
  if (!room) return json({ ok: true, skipped: true });
  const { data: workspace } = await admin.from("workspaces").select("id, name").eq("id", room.workspace_id).maybeSingle();
  const { data: sender } = await admin.from("profiles").select("display_name").eq("id", doc.created_by).maybeSingle();
  const senderName = sender?.display_name || "Quelqu'un";

  // Qui a accès au spectacle : administrateurs de l'espace, personnes assignées (ou tout le monde si ouvert à tous).
  const { data: roomMembers } = await admin.from("room_members").select("user_id").eq("room_id", room.id);
  const inRoom = new Set((roomMembers ?? []).map((row: { user_id: string }) => row.user_id));
  const { data: members } = await admin.from("workspace_members").select("user_id, role").eq("workspace_id", room.workspace_id);
  const recipients = new Set<string>();
  // Fiche technique : seules les personnes qui ont le droit de la lire (fonction Technique, Prod ou RG, ou case « lit la fiche technique »).
  let sheetReaders: Set<string> | null = null;
  if (table === "room_sheets") {
    const { data: staff } = await admin.from("room_staff").select("user_id, functions, sheet_read").eq("room_id", room.id);
    sheetReaders = new Set(
      // deno-lint-ignore no-explicit-any
      (staff ?? []).filter((s: any) => s.sheet_read || (s.functions ?? []).length > 0).map((s: { user_id: string }) => s.user_id),
    );
  }
  for (const m of members ?? []) {
    if (m.role === "admin") recipients.add(m.user_id);
    else if ((room.everyone || inRoom.has(m.user_id)) && (!sheetReaders || sheetReaders.has(m.user_id))) recipients.add(m.user_id);
  }
  // L'administrateur général ne reçoit plus les notifications des espaces où il n'est pas membre (migration 030).
  if (doc.created_by) recipients.delete(doc.created_by);

  const now = Date.now();
  const ids = [...recipients];
  if (!ids.length) return json({ ok: true, sent: 0 });
  const { data: mutes } = await admin.from("notification_mutes").select("*").in("user_id", ids);
  const muted = (uid: string, scope: string, target: string) =>
    (mutes ?? []).some(
      // deno-lint-ignore no-explicit-any
      (m: any) =>
        m.user_id === uid && m.scope === scope && m.target_id === target && (m.forever || (m.muted_until && new Date(m.muted_until).getTime() > now)),
    );
  const targets = ids.filter((uid) => !muted(uid, "workspace", room.workspace_id) && !muted(uid, "room", room.id));
  if (!targets.length) return json({ ok: true, sent: 0 });
  // Ouverture : le premier sous-salon du spectacle (celui ouvert à tous en priorité).
  const { data: channels } = await admin
    .from("channels")
    .select("id, everyone, created_at")
    .eq("room_id", room.id)
    .eq("kind", "channel")
    .order("everyone", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1);
  const channelId = channels?.[0]?.id ?? null;
  const title = `📄 Nouveau PDF · ${room.name} · ${workspace?.name ?? "ThyChat"}`;
  const body = clip(`${senderName} a ajouté ${detail}`, 160);
  await logNotifications(admin, targets, { kind: "doc", title, body, workspace_id: room.workspace_id, channel_id: channelId });

  const { data: subs } = await admin.from("push_subscriptions").select("*").in("user_id", targets);
  if (!subs?.length) return json({ ok: true, sent: 0 });

  let sent = 0;
  await Promise.all(
    // deno-lint-ignore no-explicit-any
    subs.map(async (sub: any) => {
      const notification = JSON.stringify({
        kind: "doc",
        title,
        body,
        tag: `doc-${room.id}`,
        channel_id: channelId,
        workspace_id: room.workspace_id,
        url: `./?w=${room.workspace_id}${channelId ? "&c=" + channelId : ""}`,
      });
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, notification, {
          TTL: 60 * 60 * 24,
          urgency: "normal",
        });
        sent++;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await admin.from("push_subscriptions").delete().eq("id", sub.id);
        else console.error("Envoi push échoué", status, (error as Error).message);
      }
    }),
  );
  return json({ ok: true, sent });
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== Deno.env.get("PUSH_WEBHOOK_SECRET")) {
    return json({ error: "Non autorisé" }, 401);
  }

  try {
    const payload = await req.json();
    const table = payload?.table;
    const message = payload?.record;
    const isDocument = table === "tag_documents" || table === "room_sheets";
    if (payload?.type !== "INSERT" || !message || (table !== "messages" && !isDocument) || (table === "messages" && message.parent_id)) {
      return json({ ok: true, skipped: true });
    }

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });
    webpush.setVapidDetails(
      Deno.env.get("VAPID_SUBJECT") || "mailto:contact@example.com",
      Deno.env.get("VAPID_PUBLIC_KEY")!,
      Deno.env.get("VAPID_PRIVATE_KEY")!,
    );

    if (isDocument) return await notifyDocument(admin, table, message);

    const { data: channel } = await admin
      .from("channels")
      .select("id, name, kind, everyone, workspace_id, room_id")
      .eq("id", message.channel_id)
      .maybeSingle();
    if (!channel) return json({ ok: true, skipped: true });
    if (channel.kind === "notes") return json({ ok: true, skipped: true }); // « Mes notes » est privé : jamais de notification

    const { data: workspace } = await admin.from("workspaces").select("id, name").eq("id", channel.workspace_id).maybeSingle();
    const { data: sender } = await admin.from("profiles").select("display_name").eq("id", message.user_id).maybeSingle();
    const senderName = sender?.display_name || "Quelqu'un";
    let roomName = "";

    // Qui peut lire ce sous-salon ? (accès au salon ET ouvert à tous ou assigné ; les administrateurs voient tout)
    const { data: chMembers } = await admin.from("channel_members").select("user_id").eq("channel_id", channel.id);
    const inChannel = new Set((chMembers ?? []).map((row) => row.user_id));
    let recipients = new Set<string>();
    if (channel.kind === "dm") {
      recipients = inChannel;
    } else {
      const { data: room } = await admin.from("rooms").select("id, name, everyone").eq("id", channel.room_id).maybeSingle();
      const { data: roomMembers } = await admin.from("room_members").select("user_id").eq("room_id", channel.room_id);
      const inRoom = new Set((roomMembers ?? []).map((row) => row.user_id));
      roomName = room?.name ?? "";
      const { data: members } = await admin
        .from("workspace_members")
        .select("user_id, role")
        .eq("workspace_id", channel.workspace_id);
      for (const m of members ?? []) {
        const roomOk = room?.everyone || inRoom.has(m.user_id);
        if (m.role === "admin" || (roomOk && (channel.everyone || inChannel.has(m.user_id)))) recipients.add(m.user_id);
      }
    }
    recipients.delete(message.user_id);
    if (!recipients.size) return json({ ok: true, sent: 0 });
    const ids = [...recipients];

    // Silences en cours.
    const { data: mutes } = await admin.from("notification_mutes").select("*").in("user_id", ids);
    const now = Date.now();
    const isMuted = (uid: string, scope: string, target: string) =>
      (mutes ?? []).some(
        (m) =>
          m.user_id === uid &&
          m.scope === scope &&
          m.target_id === target &&
          (m.forever || (m.muted_until && new Date(m.muted_until).getTime() > now)),
      );
    const mutedFor = (uid: string, ws: string, ch: string) =>
      (channel.kind !== "dm" && isMuted(uid, "workspace", ws)) || isMuted(uid, "channel", ch) || (channel.room_id ? isMuted(uid, "room", channel.room_id) : false);

    const targets = ids.filter((uid) => !mutedFor(uid, channel.workspace_id, channel.id));
    if (!targets.length) return json({ ok: true, sent: 0 });

    const hasImage = Array.isArray(message.attachments) && message.attachments.length > 0;
    const text = clip(String(message.body || ""), 140) || (hasImage ? "📷 Photo" : "");
    const isDm = channel.kind === "dm";
    const title = isDm ? senderName : `${roomName ? roomName + " › " : ""}${channel.name} · ${workspace?.name ?? "ThyChat"}`;
    const body = isDm ? text : `${senderName} : ${text}`;
    await logNotifications(admin, targets, { kind: isDm ? "dm" : "message", title, body, workspace_id: channel.workspace_id, channel_id: channel.id });

    const { data: subs } = await admin.from("push_subscriptions").select("*").in("user_id", targets);
    if (!subs?.length) return json({ ok: true, sent: 0 });
    let sent = 0;

    // Un total de non lus par personne (hors silences) pour la pastille de l'icône.
    const badgeCache = new Map<string, number>();
    async function badgeFor(uid: string): Promise<number> {
      if (badgeCache.has(uid)) return badgeCache.get(uid)!;
      const { data: counts } = await admin.rpc("unread_counts_for", { uid });
      const { data: userMutes } = await admin.from("notification_mutes").select("*").eq("user_id", uid);
      const muted = (scope: string, target: string) =>
        (userMutes ?? []).some(
          (m) =>
            m.scope === scope &&
            m.target_id === target &&
            (m.forever || (m.muted_until && new Date(m.muted_until).getTime() > now)),
        );
      let total = 0;
      const { data: roomRows } = await admin.from("channels").select("id, room_id").in("id", ((counts ?? []) as { channel_id: string }[]).map((r) => r.channel_id));
      const roomOf = new Map((roomRows ?? []).map((r) => [r.id, r.room_id]));
      for (const row of (counts ?? []) as { channel_id: string; workspace_id: string; unread: number }[]) {
        const room = roomOf.get(row.channel_id);
        if (!muted("workspace", row.workspace_id) && !muted("channel", row.channel_id) && !(room && muted("room", room))) {
          total += Number(row.unread);
        }
      }
      badgeCache.set(uid, total);
      return total;
    }

    await Promise.all(
      subs.map(async (sub) => {
        const notification = JSON.stringify({
          title,
          body,
          tag: channel.id,
          channel_id: channel.id,
          workspace_id: channel.workspace_id,
          url: `./?w=${channel.workspace_id}&c=${channel.id}`,
          badge: await badgeFor(sub.user_id),
        });
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            notification,
            { TTL: 60 * 60 * 24, urgency: "normal" },
          );
          sent++;
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await admin.from("push_subscriptions").delete().eq("id", sub.id); // abonnement périmé
          } else {
            console.error("Envoi push échoué", status, (error as Error).message);
          }
        }
      }),
    );

    return json({ ok: true, sent });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Erreur inattendue" }, 500);
  }
});
