// Fonction Supabase « invite-member » : invite une personne par e-mail et l'assigne à des espaces et salons.
//
// - Un administrateur d'espace peut inviter dans SON espace.
// - L'administrateur général peut inviter dans n'importe quel espace.
// Si l'e-mail a déjà un compte, la personne est simplement ajoutée (aucun nouvel e-mail).
//
// Déploiement : voir README (« Fonctions Supabase »). Désactive « Enforce JWT Verification » :
// la fonction vérifie elle-même la session de la personne qui appelle.

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Assignment = { workspace_id: string; role: "admin" | "member"; room_ids?: string[]; channel_ids?: string[] };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });

    // Qui appelle ?
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: auth, error: authError } = await admin.auth.getUser(token);
    if (authError || !auth.user) return json({ error: "Non connecté" }, 401);
    const caller = auth.user.id;

    const body = await req.json();
    const email = String(body.email || "").trim().toLowerCase();
    const displayName = String(body.display_name || "").trim().slice(0, 80);
    const assignments: Assignment[] = Array.isArray(body.assignments) ? body.assignments : [];

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Adresse e-mail invalide." }, 400);
    if (!assignments.length) return json({ error: "Choisis au moins un espace." }, 400);

    // Droits : administrateur général, ou administrateur de chaque espace visé.
    const { data: profile } = await admin.from("profiles").select("is_super_admin").eq("id", caller).maybeSingle();
    const isSuper = Boolean(profile?.is_super_admin);
    const { data: adminRows } = await admin
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", caller)
      .eq("role", "admin");
    const allowed = new Set((adminRows ?? []).map((row) => row.workspace_id));

    for (const a of assignments) {
      if (!a || typeof a.workspace_id !== "string" || !["admin", "member"].includes(a.role)) {
        return json({ error: "Demande invalide." }, 400);
      }
      if (!isSuper && !allowed.has(a.workspace_id)) {
        return json({ error: "Tu n'es pas administrateur de cet espace." }, 403);
      }
    }

    // Compte existant, ou nouvelle invitation par e-mail.
    let userId: string | null = null;
    let invited = false;
    const { data: existing } = await admin.rpc("user_id_by_email", { p_email: email });
    if (existing) {
      userId = existing as string;
    } else {
      const redirectTo = typeof body.redirect_to === "string" ? body.redirect_to : undefined;
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
        data: displayName ? { display_name: displayName } : {},
        redirectTo,
      });
      if (error || !data.user) return json({ error: error?.message || "Invitation impossible." }, 400);
      userId = data.user.id;
      invited = true;
    }

    // Assignation aux espaces, puis aux salons restreints.
    for (const a of assignments) {
      const { error } = await admin
        .from("workspace_members")
        .upsert({ workspace_id: a.workspace_id, user_id: userId, role: a.role }, { onConflict: "workspace_id,user_id" });
      if (error) return json({ error: error.message }, 400);

      // Salons (spectacles) réservés.
      const wantedRooms = Array.isArray(a.room_ids) ? a.room_ids.filter((id) => typeof id === "string") : [];
      if (wantedRooms.length) {
        const { data: validRooms } = await admin.from("rooms").select("id").eq("workspace_id", a.workspace_id).in("id", wantedRooms);
        const rows = (validRooms ?? []).map((r) => ({ room_id: r.id, user_id: userId }));
        if (rows.length) {
          const { error: roomError } = await admin
            .from("room_members")
            .upsert(rows, { onConflict: "room_id,user_id", ignoreDuplicates: true });
          if (roomError) return json({ error: roomError.message }, 400);
        }
      }

      // Sous-salons réservés.
      const wanted = Array.isArray(a.channel_ids) ? a.channel_ids.filter((id) => typeof id === "string") : [];
      if (wanted.length) {
        const { data: valid } = await admin
          .from("channels")
          .select("id")
          .eq("workspace_id", a.workspace_id)
          .eq("kind", "channel")
          .in("id", wanted);
        const rows = (valid ?? []).map((c) => ({ channel_id: c.id, user_id: userId }));
        if (rows.length) {
          const { error: chError } = await admin
            .from("channel_members")
            .upsert(rows, { onConflict: "channel_id,user_id", ignoreDuplicates: true });
          if (chError) return json({ error: chError.message }, 400);
        }
      }
    }

    return json({ ok: true, invited, user_id: userId });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Erreur inattendue" }, 500);
  }
});
