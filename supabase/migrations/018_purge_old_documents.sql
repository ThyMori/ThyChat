-- ThyChat — migration 018 : nettoyage automatique des documents des dates de tournée passées depuis plus de 10 jours.
--
-- À coller dans Supabase > SQL Editor > Run. Rejouable. Nécessite les migrations 004 (réglages push_url / push_secret) et 012.
-- Chaque nuit à 3 h 30 (UTC), pg_cron appelle la fonction « purge-documents » (à déployer : copier-coller de
-- supabase/functions/purge-documents/index.ts dans Edge Functions, « Enforce JWT Verification » désactivé ; elle réutilise
-- le secret PUSH_WEBHOOK_SECRET de send-push). C'est elle qui efface les fichiers du stockage puis les lignes.
--
-- Essai à blanc (ne supprime rien) : Edge Functions > purge-documents > Test, en-tête x-webhook-secret, corps {"dry": true}.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create or replace function public.purge_old_documents()
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  push_url text;
  push_secret text;
begin
  select value into push_url from public.app_settings where key = 'push_url';
  select value into push_secret from public.app_settings where key = 'push_secret';
  if push_url is null or push_secret is null then
    return;
  end if;

  perform net.http_post(
    url := replace(push_url, '/send-push', '/purge-documents'),
    body := jsonb_build_object('days', 10),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', push_secret)
  );
end;
$$;

revoke all on function public.purge_old_documents() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'purge-old-documents';
  perform cron.schedule('purge-old-documents', '30 3 * * *', 'select public.purge_old_documents()');
end;
$$;
