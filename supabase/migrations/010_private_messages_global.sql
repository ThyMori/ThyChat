-- Messages privés valables dans tous les espaces + suppression d'une discussion privée.
-- Sans risque si exécuté deux fois.

-- 1. Une seule discussion par paire de personnes : on fusionne les doublons (un par espace jusqu'ici).
--    (Une discussion contenant déjà des photos n'est pas fusionnée : ses photos sont rangées dans son propre dossier.)
do $$
declare
  nm text;
  keep uuid;
  dup uuid;
begin
  for nm in select name from public.channels where kind = 'dm' group by name having count(*) > 1 loop
    select id into keep from public.channels where kind = 'dm' and name = nm order by created_at, id limit 1;
    for dup in select id from public.channels where kind = 'dm' and name = nm and id <> keep loop
      if not exists (
        select 1 from public.messages where channel_id = dup and jsonb_array_length(attachments) > 0
      ) then
        update public.messages set channel_id = keep where channel_id = dup;
        delete from public.channels where id = dup;
      end if;
    end loop;
  end loop;
end;
$$;

-- 2. Ouvrir (ou retrouver) la discussion privée avec une personne : la même quel que soit l'espace.
create or replace function public.open_dm(ws uuid, other uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  a uuid;
  b uuid;
  dm_name text;
  ch uuid;
begin
  if me is null then raise exception 'Non connecté'; end if;
  if other is null or other = me then raise exception 'Choisis une autre personne'; end if;
  if not exists (select 1 from public.workspace_members where workspace_id = ws and user_id = me)
     or not exists (select 1 from public.workspace_members where workspace_id = ws and user_id = other) then
    raise exception 'Vous devez appartenir tous les deux à cet espace';
  end if;

  if me < other then a := me; b := other; else a := other; b := me; end if;
  dm_name := 'dm:' || a || ':' || b;

  select c.id into ch from public.channels c where c.kind = 'dm' and c.name = dm_name order by c.created_at, c.id limit 1;
  if ch is null then
    insert into public.channels (workspace_id, name, kind, everyone)
    values (ws, dm_name, 'dm', false)
    returning id into ch;
    insert into public.channel_members (channel_id, user_id) values (ch, a), (ch, b);
  end if;
  return ch;
end;
$$;

revoke all on function public.open_dm(uuid, uuid) from public, anon;
grant execute on function public.open_dm(uuid, uuid) to authenticated;

-- 3. Quitter un espace ne coupe plus les discussions privées tant qu'on partage un autre espace avec l'interlocuteur.
create or replace function public.handle_member_removed()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.channel_members cm
  using public.channels c
  where cm.channel_id = c.id and c.kind = 'channel' and c.workspace_id = old.workspace_id and cm.user_id = old.user_id;

  delete from public.channel_members cm
  using public.channels c
  where cm.channel_id = c.id and c.kind = 'dm' and cm.user_id = old.user_id
    and not exists (
      select 1
      from public.channel_members other
      join public.workspace_members theirs on theirs.user_id = other.user_id
      join public.workspace_members mine on mine.workspace_id = theirs.workspace_id and mine.user_id = old.user_id
      where other.channel_id = c.id and other.user_id <> old.user_id
    );

  delete from public.room_members rm
  using public.rooms r
  where rm.room_id = r.id and r.workspace_id = old.workspace_id and rm.user_id = old.user_id;
  return old;
end;
$$;

-- 4. Supprimer toute une discussion privée (messages compris) : possible pour chacune des deux personnes.
drop policy if exists channels_delete on public.channels;
create policy channels_delete on public.channels for delete to authenticated
  using (
    (kind = 'channel' and public.is_workspace_admin(workspace_id))
    or (kind = 'dm' and exists (
      select 1 from public.channel_members m where m.channel_id = channels.id and m.user_id = auth.uid()
    ))
  );

-- Les photos d'une discussion privée peuvent être retirées par les deux personnes.
drop policy if exists message_images_delete on storage.objects;
create policy message_images_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'message-images'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and (
      owner = auth.uid()
      or public.can_moderate_channel(((storage.foldername(name))[1])::uuid)
      or exists (
        select 1 from public.channels c
        where c.id = ((storage.foldername(name))[1])::uuid and c.kind = 'dm' and public.can_access_channel(c.id)
      )
    )
  );
