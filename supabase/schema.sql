-- ThyChat — schéma v1 (Supabase / PostgreSQL)
--
-- À coller dans Supabase > SQL Editor > New query, puis « Run ».
-- Le script peut être rejoué sans casser l'existant.
--
-- Modèle :
--   workspaces (espaces / équipes)
--     └─ workspace_members (qui est dans quel espace, rôle admin | member)
--     └─ channels (canaux de l'espace)
--          └─ messages (avec fils de discussion via parent_id, épinglage, pièces jointes)
--   profiles (nom affiché de chaque compte)
--
-- Sécurité : le RLS (Row Level Security) est activé sur toutes les tables.
-- Un utilisateur ne voit que les données des espaces dont il est membre.

-- ============================================================
-- Tables
-- ============================================================

create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  avatar_url   text,
  created_at   timestamptz not null default now()
);

create table if not exists public.workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 80),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'member' check (role in ('admin', 'member')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.channels (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 60),
  description  text,
  created_at   timestamptz not null default now(),
  unique (workspace_id, name)
);

create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  channel_id  uuid not null references public.channels(id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users(id),
  parent_id   uuid references public.messages(id) on delete cascade,
  body        text not null check (char_length(body) between 1 and 8000),
  pinned      boolean not null default false,
  attachments jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  edited_at   timestamptz
);

create index if not exists messages_channel_created_idx on public.messages (channel_id, created_at desc);
create index if not exists messages_parent_idx on public.messages (parent_id);
create index if not exists workspace_members_user_idx on public.workspace_members (user_id);

-- ============================================================
-- Fonctions utilitaires (SECURITY DEFINER pour éviter la récursion du RLS)
-- ============================================================

create or replace function public.is_workspace_member(ws uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_workspace_admin(ws uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid() and m.role = 'admin'
  );
$$;

create or replace function public.channel_workspace(ch uuid)
returns uuid
language sql stable security definer set search_path = public as $$
  select c.workspace_id from public.channels c where c.id = ch;
$$;

create or replace function public.shares_workspace_with(other uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.workspace_members a
    join public.workspace_members b on a.workspace_id = b.workspace_id
    where a.user_id = auth.uid() and b.user_id = other
  );
$$;

-- ============================================================
-- Triggers
-- ============================================================

-- Crée un profil à chaque nouveau compte.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Le créateur d'un espace en devient administrateur.
create or replace function public.handle_new_workspace()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.created_by, 'admin')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_workspace_created on public.workspaces;
create trigger on_workspace_created
  after insert on public.workspaces
  for each row execute function public.handle_new_workspace();

-- Un message de fil doit appartenir au même canal que son parent.
create or replace function public.check_message_parent()
returns trigger
language plpgsql set search_path = public as $$
begin
  if new.parent_id is not null and not exists (
    select 1 from public.messages p
    where p.id = new.parent_id and p.channel_id = new.channel_id
  ) then
    raise exception 'Le message parent doit appartenir au même canal';
  end if;
  return new;
end;
$$;

drop trigger if exists messages_check_parent on public.messages;
create trigger messages_check_parent
  before insert or update of parent_id, channel_id on public.messages
  for each row execute function public.check_message_parent();

-- ============================================================
-- Row Level Security
-- ============================================================

alter table public.profiles           enable row level security;
alter table public.workspaces         enable row level security;
alter table public.workspace_members  enable row level security;
alter table public.channels           enable row level security;
alter table public.messages           enable row level security;

-- profiles : visibles par soi-même et par les membres d'un même espace ; modifiables par soi-même.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_workspace_with(id));

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- workspaces : visibles par leurs membres (et par leur créateur, le temps que le trigger l'ajoute).
drop policy if exists workspaces_select on public.workspaces;
create policy workspaces_select on public.workspaces for select to authenticated
  using (created_by = auth.uid() or public.is_workspace_member(id));

drop policy if exists workspaces_insert on public.workspaces;
create policy workspaces_insert on public.workspaces for insert to authenticated
  with check (created_by = auth.uid());

drop policy if exists workspaces_update on public.workspaces;
create policy workspaces_update on public.workspaces for update to authenticated
  using (public.is_workspace_admin(id))
  with check (public.is_workspace_admin(id));

drop policy if exists workspaces_delete on public.workspaces;
create policy workspaces_delete on public.workspaces for delete to authenticated
  using (public.is_workspace_admin(id));

-- workspace_members : les membres voient les membres de leurs espaces ; les admins gèrent ;
-- chacun peut quitter un espace.
drop policy if exists members_select on public.workspace_members;
create policy members_select on public.workspace_members for select to authenticated
  using (user_id = auth.uid() or public.is_workspace_member(workspace_id));

drop policy if exists members_insert on public.workspace_members;
create policy members_insert on public.workspace_members for insert to authenticated
  with check (public.is_workspace_admin(workspace_id));

drop policy if exists members_update on public.workspace_members;
create policy members_update on public.workspace_members for update to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

drop policy if exists members_delete on public.workspace_members;
create policy members_delete on public.workspace_members for delete to authenticated
  using (public.is_workspace_admin(workspace_id) or user_id = auth.uid());

-- channels : visibles par les membres de l'espace ; gérés par les admins.
drop policy if exists channels_select on public.channels;
create policy channels_select on public.channels for select to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists channels_insert on public.channels;
create policy channels_insert on public.channels for insert to authenticated
  with check (public.is_workspace_admin(workspace_id));

drop policy if exists channels_update on public.channels;
create policy channels_update on public.channels for update to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

drop policy if exists channels_delete on public.channels;
create policy channels_delete on public.channels for delete to authenticated
  using (public.is_workspace_admin(workspace_id));

-- messages : lus par les membres de l'espace ; écrits en son propre nom ;
-- modifiés ou supprimés par leur auteur ou par un admin de l'espace.
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
  using (public.is_workspace_member(public.channel_workspace(channel_id)));

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.is_workspace_member(public.channel_workspace(channel_id))
  );

drop policy if exists messages_update on public.messages;
create policy messages_update on public.messages for update to authenticated
  using (user_id = auth.uid() or public.is_workspace_admin(public.channel_workspace(channel_id)))
  with check (user_id = auth.uid() or public.is_workspace_admin(public.channel_workspace(channel_id)));

drop policy if exists messages_delete on public.messages;
create policy messages_delete on public.messages for delete to authenticated
  using (user_id = auth.uid() or public.is_workspace_admin(public.channel_workspace(channel_id)));

-- ============================================================
-- Ajouter un membre à un espace par e-mail (réservé aux admins de l'espace)
-- Le compte doit exister : invite d'abord la personne depuis
-- Supabase > Authentication > Users > Invite user.
-- ============================================================

create or replace function public.add_member_by_email(ws uuid, member_email text, member_role text default 'member')
returns void
language plpgsql security definer set search_path = public, auth as $$
declare
  target uuid;
begin
  if not public.is_workspace_admin(ws) then
    raise exception 'Réservé aux administrateurs de cet espace';
  end if;
  if member_role not in ('admin', 'member') then
    raise exception 'Rôle invalide : %', member_role;
  end if;

  select u.id into target from auth.users u where lower(u.email) = lower(member_email);
  if target is null then
    raise exception 'Aucun compte pour cet e-mail. Invite d''abord la personne (Supabase > Authentication > Users > Invite user).';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (ws, target, member_role)
  on conflict (workspace_id, user_id) do update set role = excluded.role;
end;
$$;

revoke all on function public.add_member_by_email(uuid, text, text) from public, anon;
grant execute on function public.add_member_by_email(uuid, text, text) to authenticated;

-- ============================================================
-- Temps réel : les nouveaux messages sont diffusés aux abonnés (en respectant le RLS)
-- ============================================================

do $$
begin
  alter publication supabase_realtime add table public.messages;
exception
  when duplicate_object then null;
end;
$$;
