-- ThyChat — migration 015 : un administrateur peut déplacer un message vers un autre sous-salon ou spectacle
-- (en cas d'erreur). À coller dans Supabase > SQL Editor > Run. Rejouable.
--
-- Règles : réservé aux administrateurs ; même espace ; pas de messages privés ; les photos suivent le message
-- (déplacées dans le dossier du nouveau sous-salon) ; les dates (#) sont retirées si on change de spectacle
-- (elles appartiennent à un spectacle) ; les citations du message déplacé sont retirées.

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

  -- Le message d'abord, puis ses éventuelles réponses.
  for r in select * from public.messages where id = msg or parent_id = msg order by (parent_id is not null) loop
    newitems := '[]'::jsonb;
    for item in select * from jsonb_array_elements(r.attachments) loop
      old_path := item->>'path';
      new_path := dst.id::text || '/' || substr(old_path, 38);
      update storage.objects set name = new_path where bucket_id = 'message-images' and name = old_path;
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
