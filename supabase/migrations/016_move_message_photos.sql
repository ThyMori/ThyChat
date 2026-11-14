-- ThyChat — migration 016 : correctif du déplacement de message (photos) — **indispensable si tu as déjà exécuté la 015**.
-- À coller dans Supabase > SQL Editor > Run. Rejouable.
--
-- La 015 renommait la photo dans la base sans la déplacer réellement dans le stockage : elle devenait introuvable.
-- Désormais l'application déplace elle-même les fichiers (API de stockage), puis la fonction met à jour le message.
-- Il faut donc l'autorisation de déplacer (mise à jour) dans le stockage « message-images » pour les administrateurs.

drop policy if exists message_images_update on storage.objects;
create policy message_images_update on storage.objects for update to authenticated
  using (
    bucket_id = 'message-images'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.can_moderate_channel(((storage.foldername(name))[1])::uuid)
  )
  with check (
    bucket_id = 'message-images'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.can_moderate_channel(((storage.foldername(name))[1])::uuid)
  );

create or replace function public.move_message(msg uuid, target uuid)
returns void
language plpgsql security definer set search_path = public, storage as $$
declare
  m public.messages%rowtype;
  src public.channels%rowtype;
  dst public.channels%rowtype;
  r record;
  item jsonb;
  newitems jsonb;
  old_path text;
  new_path text;
  same_room boolean;
begin
  select * into m from public.messages where id = msg;
  if not found then raise exception 'Message introuvable'; end if;
  if m.parent_id is not null then raise exception 'Déplace le message d''origine, pas sa réponse'; end if;

  select * into src from public.channels where id = m.channel_id;
  select * into dst from public.channels where id = target;
  if dst.id is null then raise exception 'Destination introuvable'; end if;
  if src.kind <> 'channel' or dst.kind <> 'channel' then raise exception 'Les messages privés ne se déplacent pas'; end if;
  if src.workspace_id <> dst.workspace_id then raise exception 'La destination est dans un autre espace'; end if;
  if src.id = dst.id then return; end if;
  if not (public.can_moderate_channel(src.id) and public.can_moderate_channel(dst.id)) then
    raise exception 'Réservé aux administrateurs';
  end if;

  same_room := src.room_id is not distinct from dst.room_id;

  if exists (select 1 from public.messages where parent_id = msg and jsonb_array_length(attachments) > 0) then
    raise exception 'Une réponse contient une photo : déplacement impossible';
  end if;

  -- Le message d'abord, puis ses éventuelles réponses.
  for r in select * from public.messages where id = msg or parent_id = msg order by (parent_id is not null) loop
    newitems := '[]'::jsonb;
    for item in select * from jsonb_array_elements(r.attachments) loop
      old_path := item->>'path';
      new_path := dst.id::text || '/' || substr(old_path, 38);
      newitems := newitems || jsonb_build_array(jsonb_set(item, '{path}', to_jsonb(new_path)));
    end loop;

    update public.messages
       set channel_id = dst.id,
           attachments = newitems,
           tag_ids = case when same_room then r.tag_ids else '{}'::uuid[] end,
           reply_to = null
     where id = r.id;
  end loop;

  -- Les messages restés dans l'ancien sous-salon qui citaient le message déplacé perdent leur citation.
  update public.messages
     set reply_to = null
   where channel_id <> dst.id
     and reply_to in (select id from public.messages where id = msg or parent_id = msg);
end;
$$;

revoke all on function public.move_message(uuid, uuid) from public, anon;
grant execute on function public.move_message(uuid, uuid) to authenticated;
