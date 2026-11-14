-- ThyChat — migration 014 : notification push quand un PDF est ajouté (document d'une date ou fiche technique).
--
-- À coller dans Supabase > SQL Editor > Run. Rejouable. Nécessite la migration 004 (réglages push_url / push_secret)
-- et le redéploiement de la fonction « send-push » (copier-coller du fichier supabase/functions/send-push/index.ts).

create or replace function public.notify_push_document()
returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  push_url text;
  push_secret text;
begin
  select value into push_url from public.app_settings where key = 'push_url';
  select value into push_secret from public.app_settings where key = 'push_secret';
  if push_url is null or push_secret is null then
    return new;
  end if;

  perform net.http_post(
    url := push_url,
    body := jsonb_build_object('type', 'INSERT', 'table', tg_table_name, 'record', to_jsonb(new)),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', push_secret)
  );
  return new;
exception when others then
  return new; -- une notification ratée ne doit jamais empêcher l'ajout d'un PDF
end;
$$;

drop trigger if exists tag_documents_notify_push on public.tag_documents;
create trigger tag_documents_notify_push
  after insert on public.tag_documents
  for each row execute function public.notify_push_document();

drop trigger if exists room_sheets_notify_push on public.room_sheets;
create trigger room_sheets_notify_push
  after insert on public.room_sheets
  for each row execute function public.notify_push_document();
