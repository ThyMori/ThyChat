// Fonction Supabase « request-access » : une personne sans compte demande à s'inscrire.
//
// Elle enregistre la demande (table access_requests, migration 027) puis envoie un e-mail à l'administrateur
// (contact@thierry-morin.com par défaut) via le service Resend (https://resend.com).
// Secrets à créer (Edge Functions > Secrets) :
//   RESEND_API_KEY        clé d'API Resend (obligatoire pour l'envoi du mail)
//   ACCESS_REQUEST_TO     destinataire (facultatif ; par défaut contact@thierry-morin.com)
//   ACCESS_REQUEST_FROM   expéditeur (facultatif ; par défaut « ThyChat <onboarding@resend.dev> »,
//                         qui ne peut écrire qu'à l'adresse du compte Resend ; avec un domaine vérifié : « ThyChat <no-reply@thierry-morin.com> »)
// Déploiement : désactive « Enforce JWT Verification » (la personne n'a pas de compte).

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const oneLine = (v: unknown, max: number) => String(v ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  try {
    const body = await req.json();
    if (body.website) return json({ ok: true }); // champ piège : les robots le remplissent, pas les humains
    const name = oneLine(body.name, 80);
    const email = oneLine(body.email, 160).toLowerCase();
    const production = oneLine(body.production, 160);
    if (!name || !production) return json({ error: "Renseigne ton nom et le spectacle ou la production." }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Adresse e-mail invalide." }, 400);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });

    // Anti-abus : 3 demandes par adresse et par jour, 30 au total par heure.
    const day = new Date(Date.now() - 86400000).toISOString();
    const hour = new Date(Date.now() - 3600000).toISOString();
    const { count: mine } = await admin.from("access_requests").select("id", { count: "exact", head: true }).eq("email", email).gte("created_at", day);
    const { count: all } = await admin.from("access_requests").select("id", { count: "exact", head: true }).gte("created_at", hour);
    if ((mine ?? 0) >= 3 || (all ?? 0) >= 30) return json({ error: "Trop de demandes pour le moment. Réessaie plus tard." }, 429);

    const { data: row, error: insertError } = await admin
      .from("access_requests").insert({ name, email, production }).select("id").single();
    if (insertError) return json({ error: "Demande non enregistrée : " + insertError.message }, 500);

    const key = Deno.env.get("RESEND_API_KEY");
    let sent = false;
    if (key) {
      const text = `Nouvelle demande d'inscription à ThyChat\n\nNom : ${name}\nE-mail : ${email}\nSpectacle / production / Cie : ${production}\n\n` +
        `Pour l'inviter : dans ThyChat, bouton « Inviter », avec l'adresse ci-dessus. Supabase lui enverra alors le lien d'activation.\n` +
        `(Tu peux répondre directement à ce message : la réponse ira à ${email}.)`;
      const html = `<p><strong>Nouvelle demande d'inscription à ThyChat</strong></p><p>Nom : ${escapeHtml(name)}<br>E-mail : ${escapeHtml(email)}<br>Spectacle / production / Cie : ${escapeHtml(production)}</p>` +
        `<p>Pour l'inviter : dans ThyChat, bouton « Inviter », avec l'adresse ci-dessus. Supabase lui enverra alors le lien d'activation.</p>`;
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: Deno.env.get("ACCESS_REQUEST_FROM") || "ThyChat <onboarding@resend.dev>",
          to: [Deno.env.get("ACCESS_REQUEST_TO") || "contact@thierry-morin.com"],
          reply_to: email,
          subject: `ThyChat : demande d'inscription de ${name}`,
          text,
          html,
        }),
      });
      sent = res.ok;
      if (!res.ok) console.error("Resend", res.status, await res.text());
    } else console.error("RESEND_API_KEY manquant : demande enregistrée, aucun e-mail envoyé.");
    if (sent) await admin.from("access_requests").update({ mail_sent: true }).eq("id", row.id);

    // La demande est enregistrée dans tous les cas ; seul un échec d'envoi est signalé (sans détail technique).
    return json({ ok: true, mail_sent: sent });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Erreur inconnue" }, 500);
  }
});
