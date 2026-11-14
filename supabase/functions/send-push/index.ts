// Fonction Supabase « send-push » : envoie une notification push à chaque personne concernée
// par un nouveau message (sauf l'auteur, et sauf les espaces / salons mis en silence).
//
// Appelée par un Database Webhook sur INSERT de public.messages (voir README).
// Secrets à définir : VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_WEBHOOK_SECRET.
// Désactive « Enforce JWT Verification » : l'appel est authentifié par l'en-tête x-webhook-secret.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + "…" : text);

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== Deno.env.get("PUSH_WEBHOOK_SECRET")) {
    return json({ error: "Non autorisé" }, 401);
  }

  try {
    const payload = await req.json();
    const message = payload?.record;
    if (payload?.type !== "INSERT" || payload?.table !== "messages" || !message || message.parent_id) {
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

    const { data: channel } = await admin
      .from("channels")
      .select("id, name, kind, everyone, workspace_id, room_id")
      .eq("id", message.channel_id)
      .maybeSingle();
    if (!channel) return json({ ok: true, skipped: true });

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
      const { data: supers } = await admin.from("profiles").select("id").eq("is_super_admin", true);
      for (const s of supers ?? []) recipients.add(s.id);
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

    const { data: subs } = await admin.from("push_subscriptions").select("*").in("user_id", targets);
    if (!subs?.length) return json({ ok: true, sent: 0 });

    const hasImage = Array.isArray(message.attachments) && message.attachments.length > 0;
    const text = clip(String(message.body || ""), 140) || (hasImage ? "📷 Photo" : "");
    const isDm = channel.kind === "dm";
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
          title: isDm ? senderName : `${roomName ? roomName + " › " : ""}${channel.name} · ${workspace?.name ?? "ThyChat"}`,
          body: isDm ? text : `${senderName} : ${text}`,
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
