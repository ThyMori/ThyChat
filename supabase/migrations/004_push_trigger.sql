-- ThyChat — migration 004 : déclencheur des notifications push, en SQL (alternative au « Database Webhook »).
--
-- À coller dans Supabase > SQL Editor > Run. Rejouable.
-- Chaque nouveau message appelle la fonction « send-push » (pg_net), qui prévient les personnes concernées.
--
-- Ensuite, UNE FOIS, enregistre le secret (le même que PUSH_WEBHOOK_SECRET dans Edge Functions > Secrets) :
--   insert into public.app_settings (key, value) values
--     ('push_url', 'https://<ton-projet>.supabase.co/functions/v1/send-push'),
--     ('push_secret', 'LE_MOT_DE_PASSE_CHOISI')
--   on conflict (key) do update set value = excluded.value;

create extension if not exists pg_net with schema extensions;

-- Réglages serveur : RLS activé et aucune règle => illisible depuis l'application.
create table if not exists public.app_settings (
  key   text primary key,
  value text not null
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

create or replace function public.notify_push()
returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  push_url text;
  push_secret text;
begin
  select value into push_url from public.app_settings where key = 'push_url';
  select value into push_secret from public.app_settings where key = 'push_secret';
  if push_url is null or push_secret is null or new.parent_id is not null then
    return new;
  end if;

  perform net.http_post(
    url := push_url,
    body := jsonb_build_object('type', 'INSERT', 'table', 'messages', 'record', to_jsonb(new)),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', push_secret)
  );
  return new;
exception when others then
  return new; -- une notification ratée ne doit jamais empêcher l'envoi d'un message
end;
$$;

drop trigger if exists messages_notify_push on public.messages;
create trigger messages_notify_push
  after insert on public.messages
  for each row execute function public.notify_push();
