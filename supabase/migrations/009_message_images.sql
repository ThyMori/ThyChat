-- Photos dans les messages : stockage privé, accessible aux seules personnes qui ont accès au sous-salon.
-- Sans risque si exécuté deux fois.

-- Un message peut ne contenir qu'une image.
alter table public.messages drop constraint if exists messages_body_check;
alter table public.messages drop constraint if exists messages_body_or_attachment_check;
alter table public.messages
  add constraint messages_body_or_attachment_check check (
    char_length(body) <= 8000
    and (char_length(body) >= 1 or jsonb_array_length(attachments) > 0)
  );

-- Les pièces jointes doivent être rangées dans le dossier du sous-salon du message (au plus 4).
create or replace function public.check_message_links()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  target_room uuid;
  item jsonb;
begin
  if new.reply_to is not null and not exists (
    select 1 from public.messages m where m.id = new.reply_to and m.channel_id = new.channel_id
  ) then
    raise exception 'La réponse doit viser un message du même sous-salon';
  end if;

  if coalesce(array_length(new.tag_ids, 1), 0) > 0 then
    select c.room_id into target_room from public.channels c where c.id = new.channel_id;
    if target_room is null or exists (
      select 1 from unnest(new.tag_ids) t
      where not exists (select 1 from public.tour_tags g where g.id = t and g.room_id = target_room)
    ) then
      raise exception 'Étiquette inconnue pour ce salon';
    end if;
  end if;

  if jsonb_typeof(new.attachments) <> 'array' or jsonb_array_length(new.attachments) > 4 then
    raise exception 'Au plus 4 images par message';
  end if;
  for item in select * from jsonb_array_elements(new.attachments) loop
    if left(coalesce(item->>'path', ''), 37) <> new.channel_id::text || '/' then
      raise exception 'Image rangée hors du sous-salon';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists messages_check_links on public.messages;
create trigger messages_check_links
  before insert or update of reply_to, tag_ids, attachments on public.messages
  for each row execute function public.check_message_links();

-- Stockage privé « message-images » (5 Mo maximum par image).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('message-images', 'message-images', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists message_images_select on storage.objects;
create policy message_images_select on storage.objects for select to authenticated
  using (
    bucket_id = 'message-images'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.can_access_channel(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists message_images_insert on storage.objects;
create policy message_images_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'message-images'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.can_access_channel(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists message_images_delete on storage.objects;
create policy message_images_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'message-images'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and (owner = auth.uid() or public.can_moderate_channel(((storage.foldername(name))[1])::uuid))
  );
