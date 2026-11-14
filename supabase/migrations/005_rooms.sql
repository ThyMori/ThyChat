-- ThyChat — migration 005 : salons (spectacles) et sous-salons.
--
-- Hiérarchie : espace (production ou compagnie) > salon (un spectacle) > sous-salon (là où l'on discute).
--   - Un salon est ouvert à tous les utilisateurs de l'espace, ou réservé aux personnes assignées.
--   - Dans un salon, un sous-salon est ouvert à tous ceux qui ont accès au salon, ou réservé à certains.
--
-- À coller dans Supabase > SQL Editor > New query, puis « Run ». Rejouable.
-- Les salons existants deviennent chacun un salon (spectacle) ; leurs messages restent dans un sous-salon « Tous ».
-- Exécute d'abord les migrations 003 et 004.

-- ============================================================
-- 1. Tables
-- ============================================================

create table if not exists public.rooms (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 80),
  description  text,
  everyone     boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (workspace_id, name)
);

create table if not exists public.room_members (
  room_id    uuid not null references public.rooms(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index if not exists room_members_user_idx on public.room_members (user_id);

alter table public.channels add column if not exists room_id uuid references public.rooms(id) on delete cascade;

-- Un même nom de sous-salon peut exister dans deux salons ; les messages privés restent uniques par espace.
alter table public.channels drop constraint if exists channels_workspace_id_name_key;

-- ============================================================
-- 2. Reprise des salons existants : chacun devient un salon (spectacle) avec un sous-salon « Tous »
-- ============================================================

do $$
declare
  c record;
  r uuid;
begin
  for c in select * from public.channels where kind = 'channel' and room_id is null loop
    insert into public.rooms (workspace_id, name, description, everyone)
    values (c.workspace_id, c.name, c.description, c.everyone)
    returning id into r;

    insert into public.room_members (room_id, user_id, created_at)
    select r, m.user_id, m.created_at from public.channel_members m where m.channel_id = c.id
    on conflict do nothing;

    delete from public.channel_members where channel_id = c.id;
    update public.channels set room_id = r, name = 'Tous', description = null, everyone = true where id = c.id;
  end loop;
end;
$$;

create unique index if not exists channels_room_name_key on public.channels (room_id, name) where room_id is not null;
create unique index if not exists channels_dm_name_key on public.channels (workspace_id, name) where kind = 'dm';

-- Un sous-salon appartient à un salon du même espace.
create or replace function public.check_channel_room()
returns trigger
language plpgsql set search_path = public as $$
begin
  if new.kind = 'channel' and (
       new.room_id is null
       or not exists (select 1 from public.rooms r where r.id = new.room_id and r.workspace_id = new.workspace_id)
     ) then
    raise exception 'Un sous-salon doit appartenir à un salon de cet espace';
  end if;
  return new;
end;
$$;

drop trigger if exists channels_check_room on public.channels;
create trigger channels_check_room
  before insert or update of room_id, workspace_id, kind on public.channels
  for each row execute function public.check_channel_room();

-- ============================================================
-- 3. Droits d'accès
-- ============================================================

create or replace function public.can_access_room_as(uid uuid, rm uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.rooms r
    where r.id = rm and (
      public.ws_admin_as(uid, r.workspace_id)
      or (public.ws_member_as(uid, r.workspace_id) and (
        r.everyone
        or exists (select 1 from public.room_members m where m.room_id = r.id and m.user_id = uid)
      ))
    )
  );
$$;

create or replace function public.can_access_room(rm uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_access_room_as(auth.uid(), rm);
$$;

create or replace function public.can_moderate_room(rm uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.rooms r where r.id = rm and public.is_workspace_admin(r.workspace_id));
$$;

create or replace function public.user_in_room_workspace(rm uuid, uid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.rooms r
    join public.workspace_members m on m.workspace_id = r.workspace_id
    where r.id = rm and m.user_id = uid
  );
$$;

-- Sous-salon : accès au salon ET (ouvert à tous ou assigné). Les administrateurs de l'espace voient tout.
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
    )
  );
$$;

-- Quitter un espace retire aussi des salons et sous-salons.
create or replace function public.handle_member_removed()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.channel_members cm
  using public.channels c
  where cm.channel_id = c.id and c.workspace_id = old.workspace_id and cm.user_id = old.user_id;

  delete from public.room_members rm
  using public.rooms r
  where rm.room_id = r.id and r.workspace_id = old.workspace_id and rm.user_id = old.user_id;
  return old;
end;
$$;

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;

drop policy if exists rooms_select on public.rooms;
create policy rooms_select on public.rooms for select to authenticated
  using (public.can_access_room(id));

drop policy if exists rooms_insert on public.rooms;
create policy rooms_insert on public.rooms for insert to authenticated
  with check (public.is_workspace_admin(workspace_id));

drop policy if exists rooms_update on public.rooms;
create policy rooms_update on public.rooms for update to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

drop policy if exists rooms_delete on public.rooms;
create policy rooms_delete on public.rooms for delete to authenticated
  using (public.is_workspace_admin(workspace_id));

drop policy if exists room_members_select on public.room_members;
create policy room_members_select on public.room_members for select to authenticated
  using (user_id = auth.uid() or public.can_access_room(room_id));

drop policy if exists room_members_insert on public.room_members;
create policy room_members_insert on public.room_members for insert to authenticated
  with check (public.can_moderate_room(room_id) and public.user_in_room_workspace(room_id, user_id));

drop policy if exists room_members_delete on public.room_members;
create policy room_members_delete on public.room_members for delete to authenticated
  using (public.can_moderate_room(room_id));

-- ============================================================
-- 4. Non lus, silences, temps réel
-- ============================================================

create or replace function public.unread_counts_for(uid uuid)
returns table (channel_id uuid, workspace_id uuid, unread bigint)
language sql stable security definer set search_path = public as $$
  select c.id, c.workspace_id, count(m.id)
  from public.channels c
  left join public.channel_reads r on r.channel_id = c.id and r.user_id = uid
  left join public.channel_members cm on cm.channel_id = c.id and cm.user_id = uid
  left join public.room_members rm on rm.room_id = c.room_id and rm.user_id = uid
  left join public.workspace_members wm on wm.workspace_id = c.workspace_id and wm.user_id = uid
  join public.messages m
    on m.channel_id = c.id and m.user_id <> uid and m.parent_id is null
   and m.created_at > coalesce(
        r.last_read_at,
        case when c.kind = 'dm' or not c.everyone then cm.created_at
             else greatest(c.created_at, wm.created_at, rm.created_at) end,
        c.created_at)
  where public.can_access_channel_as(uid, c.id)
  group by c.id, c.workspace_id;
$$;

revoke all on function public.unread_counts_for(uuid) from public, anon, authenticated;
grant execute on function public.unread_counts_for(uuid) to service_role;

-- Le silence peut aussi viser un salon (« room »).
alter table public.notification_mutes drop constraint if exists notification_mutes_scope_check;
alter table public.notification_mutes
  add constraint notification_mutes_scope_check check (scope in ('workspace', 'room', 'channel'));

do $$
begin
  alter publication supabase_realtime add table public.rooms;
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  alter publication supabase_realtime add table public.room_members;
exception
  when duplicate_object then null;
end;
$$;
