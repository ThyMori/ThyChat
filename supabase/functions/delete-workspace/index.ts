// Fonction Supabase « delete-workspace » : supprime un espace entier (spectacles, sous-salons, messages, dates, fiches)
// ET tous ses fichiers du stockage (photos des messages, PDF, fiches techniques, photo de l'espace).
//
// Seul un administrateur de l'espace peut l'appeler (l'administrateur général doit d'abord « Rejoindre » l'espace),
// et il doit renvoyer le nom exact de l'espace. La suppression est définitive.
// Les photos de « Mes notes » des membres sont aussi effacées (la fonction passe par la clé de service, jamais lue par l'application).
//
// Déploiement : voir README. Désactive « Enforce JWT Verification » : la fonction vérifie elle-même la session de l'appelant.

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
async function listAll(admin: any, bucket: string, prefix: string, depth = 0): Promise<string[]> {
  const out: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: 100, offset });
    if (error) throw error;
    for (const entry of data ?? []) {
      const path = `${prefix}/${entry.name}`;
      // Un « dossier » n'a pas d'identifiant ; on descend (au plus 3 niveaux : salon/date/fichier).
      if (entry.id === null && depth < 3) out.push(...(await listAll(admin, bucket, path, depth + 1)));
      else if (entry.id !== null) out.push(path);
    }
    if (!data || data.length < 100) break;
  }
  return out;
}

// deno-lint-ignore no-explicit-any
async function removeAll(admin: any, bucket: string, paths: string[]) {
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
    if (error) throw error;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: auth, error: authError } = await admin.auth.getUser(token);
    if (authError || !auth.user) return json({ error: "Non connecté" }, 401);

    const body = await req.json();
    const wsId = typeof body.workspace_id === "string" ? body.workspace_id : "";
    const confirmName = String(body.confirm_name ?? "").trim();
    if (!wsId) return json({ error: "Espace manquant." }, 400);

    const { data: ws } = await admin.from("workspaces").select("id, name").eq("id", wsId).maybeSingle();
    if (!ws) return json({ error: "Espace introuvable." }, 404);
    const { data: membership } = await admin
      .from("workspace_members").select("role").eq("workspace_id", wsId).eq("user_id", auth.user.id).maybeSingle();
    if (membership?.role !== "admin") return json({ error: "Seul un administrateur de l'espace peut le supprimer." }, 403);
    if (confirmName !== ws.name) return json({ error: "Le nom saisi ne correspond pas à celui de l'espace." }, 400);

    // Les fichiers d'abord ; l'espace n'est supprimé que si tous ont été effacés (rien d'orphelin).
    const { data: rooms } = await admin.from("rooms").select("id").eq("workspace_id", wsId);
    const { data: channels } = await admin.from("channels").select("id").eq("workspace_id", wsId);
    let files = 0;
    for (const channel of channels ?? []) {
      const paths = await listAll(admin, "message-images", channel.id);
      await removeAll(admin, "message-images", paths);
      files += paths.length;
    }
    for (const room of rooms ?? []) {
      const paths = await listAll(admin, "tag-documents", room.id);
      await removeAll(admin, "tag-documents", paths);
      files += paths.length;
    }
    await admin.storage.from("avatars").remove([`ws/${wsId}/logo.jpg`]);

    const { error: deleteError } = await admin.from("workspaces").delete().eq("id", wsId);
    if (deleteError) return json({ error: "Suppression impossible : " + deleteError.message }, 500);
    return json({ ok: true, files });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Erreur inconnue" }, 500);
  }
});
