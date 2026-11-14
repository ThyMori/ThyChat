// Fonction Supabase « purge-documents » : efface les documents (fichiers PDF, images et liens) des dates de tournée
// passées depuis plus de 10 jours, pour ne pas surcharger le stockage ni la base.
//
// Une date est « passée » le lendemain de son dernier jour (jour de retour compris) ; 10 jours plus tard,
// ses documents sont supprimés (fichiers du stockage puis lignes de la table). La date elle-même reste.
// Les fiches techniques des spectacles et les photos des messages ne sont pas touchées.
//
// Appelée chaque nuit par pg_cron (migration 018), avec l'en-tête x-webhook-secret (même secret que send-push).
// Secrets : PUSH_WEBHOOK_SECRET (déjà défini pour send-push). Désactive « Enforce JWT Verification ».
// Test à blanc : corps {"dry": true} — renvoie ce qui serait supprimé sans rien effacer.

import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET = "tag-documents";
const DEFAULT_DAYS = 10;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Date du jour à Paris, au format AAAA-MM-JJ.
const todayParis = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());

const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== Deno.env.get("PUSH_WEBHOOK_SECRET")) {
    return json({ error: "Non autorisé" }, 401);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const days = Number.isFinite(Number(body?.days)) && Number(body.days) >= 1 ? Math.floor(Number(body.days)) : DEFAULT_DAYS;
    const dry = body?.dry === true;

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });

    // Dernier jour < aujourd'hui − 1 (trajet retour) − 10 jours.
    const cutoff = addDays(todayParis(), -(1 + days));
    const { data: tags, error: tagError } = await admin.from("tour_tags").select("id, start_date, end_date").not("start_date", "is", null);
    if (tagError) throw tagError;
    // deno-lint-ignore no-explicit-any
    const oldIds = (tags ?? []).filter((t: any) => (t.end_date || t.start_date) < cutoff).map((t: any) => t.id);
    if (!oldIds.length) return json({ ok: true, dates: 0, files: 0, links: 0 });

    const { data: docs, error: docError } = await admin.from("tag_documents").select("id, path, kind").in("tag_id", oldIds);
    if (docError) throw docError;
    const rows = docs ?? [];
    // deno-lint-ignore no-explicit-any
    const paths = rows.map((d: any) => d.path).filter(Boolean) as string[];
    if (dry) return json({ ok: true, dry: true, dates: oldIds.length, files: paths.length, links: rows.length - paths.length });

    // Fichiers d'abord (par lots) ; une ligne n'est effacée que si son fichier l'est, pour ne laisser aucun orphelin.
    const removed = new Set<string>();
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100);
      const { error } = await admin.storage.from(BUCKET).remove(chunk);
      if (!error) chunk.forEach((p) => removed.add(p));
      else console.warn("Suppression de fichiers impossible :", error.message);
    }
    // deno-lint-ignore no-explicit-any
    const deletable = rows.filter((d: any) => !d.path || removed.has(d.path)).map((d: any) => d.id);
    for (let i = 0; i < deletable.length; i += 100) {
      const { error } = await admin.from("tag_documents").delete().in("id", deletable.slice(i, i + 100));
      if (error) throw error;
    }
    return json({ ok: true, dates: oldIds.length, files: removed.size, links: deletable.length - removed.size, kept: rows.length - deletable.length });
  } catch (error) {
    console.error("purge-documents :", error);
    return json({ error: String((error as Error)?.message ?? error) }, 500);
  }
});
