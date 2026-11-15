-- ThyChat — migration 026 : « Mes notes », un salon personnel par spectacle.
--
-- À coller dans Supabase > SQL Editor > Run. Rejouable. Nécessite les migrations 003 et suivantes (droits d'accès), 009 (photos) et 020 (Post-it).
--
-- Chaque personne a, dans chaque spectacle auquel elle a accès, un salon « Mes notes » (créé à la première ouverture) :
-- messages, photos, Post-it et To-Do personnels. Il n'est lisible QUE par son propriétaire : ni les administrateurs de l'espace,
-- ni l'administrateur général ne le voient dans l'application (les droits sont dans la base : RLS, jamais seulement dans l'interface).
-- Aucune notification n'est envoyée pour ce salon.
-- Limites de place par personne (tous spectacles confondus) : 25 Mo de photos et 2 000 notes (messages + Post-it + To-Do).
-- Pour changer les limites : modifier les fonctions notes_photo_limit() et notes_item_limit() ci-dessous.

-- 1. Un nouveau type de salon : « notes », rattaché à un spectacle et à son propriétaire.
alter table public.channels add column if not exists owner_id uuid references auth.users(id) on delete cascade;
alter table public.channels drop constraint if exists channels_kind_check;
alter table public.channels add constraint channels_kind_check check (kind in ('channel', 'dm', 'notes'));
create unique index if not exists channels_notes_owner_room_idx on public.channels (room_id, owner_id) where kind = 'notes';

create or replace function public.check_channel_room()
returns trigger
language plpgsql set search_path = public as $$
begin
  if new.kind in ('channel', 'notes') and (
       new.room_id is null
       or not exists (select 1 from public.rooms r where r.id = new.room_id and r.workspace_id = new.workspace_id)
     ) then
    raise exception 'Un sous-salon doit appartenir à un salon de cet espace';
  end if;
  if new.kind = 'notes' and new.owner_id is null then
    raise exception 'Un salon de notes a un propriétaire';
  end if;
  return new;
end;
$$;

-- 2. Droits : seul le propriétaire (et seulement s'il a toujours accès au spectacle). Les administrateurs n'y ont pas accès.
--    can_moderate_channel() ne concerne que les sous-salons (kind = 'channel') : personne ne peut supprimer les notes d'un autre.
create or replace function public.can_access_channel_as(uid uuid, ch uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.channels c
    where c.id = ch and (
      (c.kind = 'channel' and (
        public.ws_admin_as(uid, c.workspace_id)
        or (
          public.can_access_room_as(uid, c.room_id)
          and (c.everyone or exists (
            select 1 from public.channel_members m where m.channel_id = c.id and m.user_id = uid))
        )
      ))
      or (c.kind = 'dm' and exists (
        select 1 from public.channel_members m where m.channel_id = c.id and m.user_id = uid))
      or (c.kind = 'notes' and c.owner_id = uid and public.can_access_room_as(uid, c.room_id))
    )
  );
$$;

-- 3. Limites de place.
create or replace function public.notes_photo_limit() returns bigint language sql immutable as $$ select 26214400::bigint $$; -- 25 Mo
create or replace function public.notes_item_limit() returns int language sql immutable as $$ select 2000 $$;

create or replace function public.notes_usage_as(uid uuid)
returns table (photo_bytes bigint, items bigint, photo_limit bigint, item_limit int)
language sql stable security definer set search_path = public, storage as $$
  select
    coalesce((
      select sum(coalesce((o.metadata->>'size')::bigint, 0))
      from storage.objects o
      join public.channels c on c.id::text = (storage.foldername(o.name))[1]
      where o.bucket_id = 'message-images' and c.kind = 'notes' and c.owner_id = uid
    ), 0)::bigint,
    ((select count(*) from public.messages m join public.channels c on c.id = m.channel_id where c.kind = 'notes' and c.owner_id = uid)
     + (select count(*) from public.postits p join public.channels c on c.id = p.channel_id where c.kind = 'notes' and c.owner_id = uid))::bigint,
    public.notes_photo_limit(),
    public.notes_item_limit();
$$;
revoke all on function public.notes_usage_as(uuid) from public, anon, authenticated;

-- Ma consommation, pour l'afficher dans l'application.
create or replace function public.my_notes_usage()
returns table (photo_bytes bigint, items bigint, photo_limit bigint, item_limit int)
language sql stable security definer set search_path = public as $$
  select * from public.notes_usage_as(auth.uid());
$$;
revoke all on function public.my_notes_usage() from public, anon;
grant execute on function public.my_notes_usage() to authenticated;

-- Refuse un nouveau message ou Post-it quand la limite est atteinte (et une photo quand les 25 Mo sont pleins).
create or replace function public.check_notes_quota()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  c record;
  u record;
  has_photo boolean := false;
begin
  select kind, owner_id into c from public.channels where id = new.channel_id;
  if c.kind is distinct from 'notes' then return new; end if;
  select * into u from public.notes_usage_as(c.owner_id);
  if u.items >= u.item_limit then
    raise exception 'Mes notes : limite de % notes atteinte. Supprime d''anciennes notes.', u.item_limit;
  end if;
  if tg_table_name = 'messages' then
    has_photo := jsonb_typeof(new.attachments) = 'array' and jsonb_array_length(new.attachments) > 0;
    if has_photo and u.photo_bytes >= u.photo_limit then
      raise exception 'Mes notes : plus de place pour les photos (% Mo). Supprime d''anciennes photos.', u.photo_limit / 1048576;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists messages_notes_quota on public.messages;
create trigger messages_notes_quota before insert on public.messages
  for each row execute function public.check_notes_quota();
drop trigger if exists postits_notes_quota on public.postits;
create trigger postits_notes_quota before insert on public.postits
  for each row execute function public.check_notes_quota();

-- Envoi d'une photo : refusé dans « Mes notes » quand les 25 Mo sont atteints.
create or replace function public.notes_can_upload(ch uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.channels c where c.id = ch and c.kind = 'notes')
      or (select u.photo_bytes < u.photo_limit from public.notes_usage_as(auth.uid()) u);
$$;
revoke all on function public.notes_can_upload(uuid) from public, anon;
grant execute on function public.notes_can_upload(uuid) to authenticated;

drop policy if exists message_images_insert on storage.objects;
create policy message_images_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'message-images'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.can_access_channel(((storage.foldername(name))[1])::uuid)
    and public.notes_can_upload(((storage.foldername(name))[1])::uuid)
  );

-- 4. Aucune notification pour « Mes notes » (le déclencheur ne prévient personne).
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
  if exists (select 1 from public.channels c where c.id = new.channel_id and c.kind = 'notes') then
    return new; -- « Mes notes » est privé : jamais de notification
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

-- 5. Ouvrir (et créer à la première fois) mon salon « Mes notes » d'un spectacle.
create or replace function public.open_notes(rm uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  ws uuid;
  ch uuid;
begin
  if uid is null then raise exception 'Connexion requise'; end if;
  if not public.can_access_room_as(uid, rm) then raise exception 'Spectacle inaccessible'; end if;
  select id into ch from public.channels where kind = 'notes' and room_id = rm and owner_id = uid;
  if ch is not null then return ch; end if;
  select workspace_id into ws from public.rooms where id = rm;
  insert into public.channels (workspace_id, room_id, kind, name, everyone, owner_id)
    values (ws, rm, 'notes', 'notes:' || substr(md5(uid::text), 1, 16), false, uid)
    on conflict (room_id, owner_id) where kind = 'notes' do nothing;
  select id into ch from public.channels where kind = 'notes' and room_id = rm and owner_id = uid;
  return ch;
end;
$$;
revoke all on function public.open_notes(uuid) from public, anon;
grant execute on function public.open_notes(uuid) to authenticated;
