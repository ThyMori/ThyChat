-- ThyChat — migration 025 : messages et photos épinglés en haut d'un fil (comme sur WhatsApp).
--
-- À coller dans Supabase > SQL Editor > Run. Rejouable. Nécessite les migrations 003 et suivantes (règles d'accès aux sous-salons).
-- Toute personne qui a accès au fil peut épingler ou détacher un message, pour tout le monde.
-- Durée au choix : 24 heures, 7 jours ou 30 jours. Trois épingles au plus par fil : en épingler une quatrième détache la plus ancienne.

create table if not exists public.message_pins (
  message_id  uuid primary key references public.messages(id) on delete cascade,
  channel_id  uuid not null references public.channels(id) on delete cascade,
  pinned_by   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  pinned_at   timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists message_pins_channel_idx on public.message_pins (channel_id, pinned_at);

alter table public.message_pins enable row level security;

-- Lecture seule : les écritures passent par les deux fonctions ci-dessous.
drop policy if exists message_pins_select on public.message_pins;
create policy message_pins_select on public.message_pins for select to authenticated
  using (public.can_access_channel(channel_id) and expires_at > now());

revoke all on public.message_pins from anon, authenticated;
grant select on public.message_pins to authenticated;

create or replace function public.pin_message(msg uuid, hours int)
returns void
language plpgsql security definer set search_path = public as $$
declare
  ch uuid;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if hours not in (24, 168, 720) then raise exception 'Durée invalide'; end if;
  select channel_id into ch from public.messages where id = msg;
  if ch is null or not public.can_access_channel(ch) then raise exception 'Message inaccessible'; end if;

  delete from public.message_pins where channel_id = ch and expires_at <= now();
  insert into public.message_pins (message_id, channel_id, pinned_by, pinned_at, expires_at)
    values (msg, ch, auth.uid(), now(), now() + make_interval(hours => hours))
  on conflict (message_id) do update
    set pinned_by = excluded.pinned_by, pinned_at = excluded.pinned_at, expires_at = excluded.expires_at;
  -- Trois au plus : on détache les plus anciennes.
  delete from public.message_pins
   where channel_id = ch
     and message_id not in (select message_id from public.message_pins where channel_id = ch order by pinned_at desc limit 3);
end;
$$;

create or replace function public.unpin_message(msg uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  ch uuid;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  select channel_id into ch from public.messages where id = msg;
  if ch is null or not public.can_access_channel(ch) then raise exception 'Message inaccessible'; end if;
  delete from public.message_pins where message_id = msg;
end;
$$;

revoke all on function public.pin_message(uuid, int) from public;
revoke all on function public.unpin_message(uuid) from public;
grant execute on function public.pin_message(uuid, int) to authenticated;
grant execute on function public.unpin_message(uuid) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.message_pins;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
