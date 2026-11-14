-- Étiquettes de dates de tournée (rattachées à un salon = un spectacle) et réponses à un message.
-- Sans risque si exécuté deux fois.

create table if not exists public.tour_tags (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms(id) on delete cascade,
  label      text not null check (char_length(label) between 1 and 40),
  on_date    date,
  created_at timestamptz not null default now(),
  unique (room_id, label)
);
create index if not exists tour_tags_room_idx on public.tour_tags (room_id);

alter table public.tour_tags enable row level security;

drop policy if exists tour_tags_select on public.tour_tags;
create policy tour_tags_select on public.tour_tags for select to authenticated
  using (public.can_access_room(room_id));
drop policy if exists tour_tags_insert on public.tour_tags;
create policy tour_tags_insert on public.tour_tags for insert to authenticated
  with check (public.can_moderate_room(room_id));
drop policy if exists tour_tags_update on public.tour_tags;
create policy tour_tags_update on public.tour_tags for update to authenticated
  using (public.can_moderate_room(room_id)) with check (public.can_moderate_room(room_id));
drop policy if exists tour_tags_delete on public.tour_tags;
create policy tour_tags_delete on public.tour_tags for delete to authenticated
  using (public.can_moderate_room(room_id));

grant select, insert, update, delete on public.tour_tags to authenticated;

-- Un message peut répondre à un autre message du même sous-salon et porter des étiquettes.
alter table public.messages add column if not exists reply_to uuid references public.messages(id) on delete set null;
alter table public.messages add column if not exists tag_ids uuid[] not null default '{}';
create index if not exists messages_tag_ids_idx on public.messages using gin (tag_ids);

-- Vérifie que la réponse vise le même sous-salon et que les étiquettes sont celles du salon du message.
create or replace function public.check_message_links()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  target_room uuid;
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
  return new;
end;
$$;

drop trigger if exists messages_check_links on public.messages;
create trigger messages_check_links
  before insert or update of reply_to, tag_ids on public.messages
  for each row execute function public.check_message_links();

-- Quand une étiquette disparaît, on la retire des messages.
create or replace function public.untag_messages()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.messages set tag_ids = array_remove(tag_ids, old.id) where tag_ids @> array[old.id];
  return old;
end;
$$;

drop trigger if exists tour_tags_untag on public.tour_tags;
create trigger tour_tags_untag
  before delete on public.tour_tags
  for each row execute function public.untag_messages();

do $$
begin
  alter publication supabase_realtime add table public.tour_tags;
exception
  when duplicate_object then null;
end;
$$;
