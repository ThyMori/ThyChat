-- ThyChat — schéma complet (Supabase / PostgreSQL) : v1 puis v2 (rôles, salons, push) à la suite
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

-- Couleur de l'espace (voir supabase/migrations/002_workspace_theme.sql)
alter table public.workspaces add column if not exists theme text;

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

-- ============================================================
-- ============================================================
-- Version 2 : voir aussi supabase/migrations/003_roles_salons_push.sql (contenu identique)
-- ============================================================

-- ThyChat — migration 003 : administrateur général, salons par assignation, messages privés,
-- profils (photo), messages non lus, notifications push et mises en silence.
--
-- À coller dans Supabase > SQL Editor > New query, puis « Run ». Rejouable sans risque.
-- À exécuter AVANT de publier la version 2.0.0 de l'application.
--
-- Ensuite, une seule fois, fais de ton compte l'administrateur général (remplace l'e-mail) :
--   update public.profiles set is_super_admin = true
--   where id = (select id from auth.users where email = 'TON@EMAIL');

-- ============================================================
-- 1. Administrateur général
-- ============================================================

alter table public.profiles add column if not exists is_super_admin boolean not null default false;

-- Chacun ne peut modifier que son nom et sa photo (jamais is_super_admin).
revoke update on public.profiles from authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;

-- Fonctions de droits « pour un utilisateur donné » (sert aussi à la fonction d'envoi des notifications).
create or replace function public.is_super_as(uid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p.is_super_admin from public.profiles p where p.id = uid), false);
$$;

create or replace function public.ws_member_as(uid uuid, ws uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_super_as(uid) or exists (
    select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = uid
  );
$$;

create or replace function public.ws_admin_as(uid uuid, ws uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_super_as(uid) or exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = uid and m.role = 'admin'
  );
$$;

create or replace function public.is_super_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_super_as(auth.uid());
$$;

-- L'administrateur général est administrateur de tous les espaces.
create or replace function public.is_workspace_member(ws uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.ws_member_as(auth.uid(), ws);
$$;

create or replace function public.is_workspace_admin(ws uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.ws_admin_as(auth.uid(), ws);
$$;

create or replace function public.shares_workspace_with(other uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_super_admin() or exists (
    select 1
    from public.workspace_members a
    join public.workspace_members b on a.workspace_id = b.workspace_id
    where a.user_id = auth.uid() and b.user_id = other
  );
$$;

-- Seul l'administrateur général crée des espaces.
drop policy if exists workspaces_insert on public.workspaces;
create policy workspaces_insert on public.workspaces for insert to authenticated
  with check (created_by = auth.uid() and public.is_super_admin());

-- ============================================================
-- 2. Salons : tous les membres, ou seulement certains ; messages privés
-- ============================================================

alter table public.channels add column if not exists kind text not null default 'channel';
alter table public.channels add column if not exists everyone boolean not null default true;

do $$
begin
  alter table public.channels add constraint channels_kind_check check (kind in ('channel', 'dm'));
exception
  when duplicate_object then null;
end;
$$;

-- Les messages privés ont un nom technique plus long (dm:<id>:<id>).
alter table public.channels drop constraint if exists channels_name_check;
alter table public.channels add constraint channels_name_check check (char_length(name) between 1 and 90);

create table if not exists public.channel_members (
  channel_id uuid not null references public.channels(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);
create index if not exists channel_members_user_idx on public.channel_members (user_id);

create or replace function public.can_access_channel_as(uid uuid, ch uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.channels c
    where c.id = ch and (
      (c.kind = 'channel' and (
        public.ws_admin_as(uid, c.workspace_id)
        or (c.everyone and public.ws_member_as(uid, c.workspace_id))
        or (public.ws_member_as(uid, c.workspace_id) and exists (
          select 1 from public.channel_members m where m.channel_id = c.id and m.user_id = uid))
      ))
      or (c.kind = 'dm' and exists (
        select 1 from public.channel_members m where m.channel_id = c.id and m.user_id = uid))
    )
  );
$$;

create or replace function public.can_access_channel(ch uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_access_channel_as(auth.uid(), ch);
$$;

-- Modérer (supprimer les messages d'autrui, gérer les accès) : admins, jamais dans un message privé.
create or replace function public.can_moderate_channel(ch uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.channels c
    where c.id = ch and c.kind = 'channel' and public.is_workspace_admin(c.workspace_id)
  );
$$;

create or replace function public.user_in_channel_workspace(ch uuid, uid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.channels c
    join public.workspace_members m on m.workspace_id = c.workspace_id
    where c.id = ch and m.user_id = uid
  );
$$;

-- Quitter un espace retire aussi des salons.
create or replace function public.handle_member_removed()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.channel_members cm
  using public.channels c
  where cm.channel_id = c.id and c.workspace_id = old.workspace_id and cm.user_id = old.user_id;
  return old;
end;
$$;

drop trigger if exists on_workspace_member_removed on public.workspace_members;
create trigger on_workspace_member_removed
  after delete on public.workspace_members
  for each row execute function public.handle_member_removed();

alter table public.channel_members enable row level security;

drop policy if exists channels_select on public.channels;
create policy channels_select on public.channels for select to authenticated
  using (public.can_access_channel(id));

drop policy if exists channels_insert on public.channels;
create policy channels_insert on public.channels for insert to authenticated
  with check (kind = 'channel' and public.is_workspace_admin(workspace_id));

drop policy if exists channels_update on public.channels;
create policy channels_update on public.channels for update to authenticated
  using (kind = 'channel' and public.is_workspace_admin(workspace_id))
  with check (kind = 'channel' and public.is_workspace_admin(workspace_id));

drop policy if exists channels_delete on public.channels;
create policy channels_delete on public.channels for delete to authenticated
  using (kind = 'channel' and public.is_workspace_admin(workspace_id));

drop policy if exists channel_members_select on public.channel_members;
create policy channel_members_select on public.channel_members for select to authenticated
  using (user_id = auth.uid() or public.can_access_channel(channel_id));

drop policy if exists channel_members_insert on public.channel_members;
create policy channel_members_insert on public.channel_members for insert to authenticated
  with check (public.can_moderate_channel(channel_id) and public.user_in_channel_workspace(channel_id, user_id));

drop policy if exists channel_members_delete on public.channel_members;
create policy channel_members_delete on public.channel_members for delete to authenticated
  using (public.can_moderate_channel(channel_id));

-- Messages : mêmes droits que l'accès au salon.
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
  using (public.can_access_channel(channel_id));

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (user_id = auth.uid() and public.can_access_channel(channel_id));

drop policy if exists messages_update on public.messages;
create policy messages_update on public.messages for update to authenticated
  using ((user_id = auth.uid() and public.can_access_channel(channel_id)) or public.can_moderate_channel(channel_id))
  with check ((user_id = auth.uid() and public.can_access_channel(channel_id)) or public.can_moderate_channel(channel_id));

drop policy if exists messages_delete on public.messages;
create policy messages_delete on public.messages for delete to authenticated
  using ((user_id = auth.uid() and public.can_access_channel(channel_id)) or public.can_moderate_channel(channel_id));

-- Ouvre (ou retrouve) la discussion privée entre moi et une autre personne d'un même espace.
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

  select c.id into ch from public.channels c where c.workspace_id = ws and c.name = dm_name;
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

-- ============================================================
-- 3. Messages non lus
-- ============================================================

create table if not exists public.channel_reads (
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  channel_id   uuid not null references public.channels(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (user_id, channel_id)
);

alter table public.channel_reads enable row level security;

drop policy if exists channel_reads_own on public.channel_reads;
create policy channel_reads_own on public.channel_reads for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.mark_channel_read(ch uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.can_access_channel(ch) then return; end if;
  insert into public.channel_reads (user_id, channel_id, last_read_at)
  values (auth.uid(), ch, now())
  on conflict (user_id, channel_id) do update set last_read_at = now();
end;
$$;

revoke all on function public.mark_channel_read(uuid) from public, anon;
grant execute on function public.mark_channel_read(uuid) to authenticated;

-- Nombre de messages non lus par salon pour un utilisateur donné (uniquement les salons avec du non lu).
create or replace function public.unread_counts_for(uid uuid)
returns table (channel_id uuid, workspace_id uuid, unread bigint)
language sql stable security definer set search_path = public as $$
  select c.id, c.workspace_id, count(m.id)
  from public.channels c
  left join public.channel_reads r on r.channel_id = c.id and r.user_id = uid
  left join public.channel_members cm on cm.channel_id = c.id and cm.user_id = uid
  left join public.workspace_members wm on wm.workspace_id = c.workspace_id and wm.user_id = uid
  join public.messages m
    on m.channel_id = c.id and m.user_id <> uid and m.parent_id is null
   and m.created_at > coalesce(
        r.last_read_at,
        case when c.kind = 'dm' or not c.everyone then cm.created_at else greatest(c.created_at, wm.created_at) end,
        c.created_at)
  where public.can_access_channel_as(uid, c.id)
  group by c.id, c.workspace_id;
$$;

revoke all on function public.unread_counts_for(uuid) from public, anon, authenticated;
grant execute on function public.unread_counts_for(uuid) to service_role;

create or replace function public.my_unread_counts()
returns table (channel_id uuid, workspace_id uuid, unread bigint)
language sql stable security definer set search_path = public as $$
  select * from public.unread_counts_for(auth.uid());
$$;

revoke all on function public.my_unread_counts() from public, anon;
grant execute on function public.my_unread_counts() to authenticated;

-- Les messages déjà présents sont considérés comme lus (pas de flot de pastilles au lancement).
insert into public.channel_reads (user_id, channel_id, last_read_at)
select m.user_id, c.id, now()
from public.workspace_members m
join public.channels c on c.workspace_id = m.workspace_id
on conflict do nothing;

-- ============================================================
-- 4. Silence par espace ou par salon
-- ============================================================

create table if not exists public.notification_mutes (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  scope       text not null check (scope in ('workspace', 'channel')),
  target_id   uuid not null,
  muted_until timestamptz,
  forever     boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (user_id, scope, target_id)
);

alter table public.notification_mutes enable row level security;

drop policy if exists notification_mutes_own on public.notification_mutes;
create policy notification_mutes_own on public.notification_mutes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================
-- 5. Notifications push
-- ============================================================

create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists push_subscriptions_select on public.push_subscriptions;
create policy push_subscriptions_select on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());

-- Un navigateur partagé entre deux comptes : l'abonnement passe au compte connecté.
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Non connecté'; end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, p_user_agent)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent;
end;
$$;

create or replace function public.remove_push_subscription(p_endpoint text)
returns void
language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;

revoke all on function public.save_push_subscription(text, text, text, text) from public, anon;
revoke all on function public.remove_push_subscription(text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.remove_push_subscription(text) to authenticated;

-- ============================================================
-- 6. Profils : photo (stockage public « avatars », un dossier par personne)
-- ============================================================

insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists avatars_read on storage.objects;
create policy avatars_read on storage.objects for select
  using (bucket_id = 'avatars');

drop policy if exists avatars_insert on storage.objects;
create policy avatars_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists avatars_update on storage.objects;
create policy avatars_update on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists avatars_delete on storage.objects;
create policy avatars_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================================
-- 7. Invitations (utilisé par la fonction « invite-member »)
-- ============================================================

create or replace function public.user_id_by_email(p_email text)
returns uuid
language sql stable security definer set search_path = public, auth as $$
  select u.id from auth.users u where lower(u.email) = lower(p_email);
$$;

revoke all on function public.user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.user_id_by_email(text) to service_role;

-- Les changements de salons et d'accès sont aussi diffusés en temps réel.
do $$
begin
  alter publication supabase_realtime add table public.channels;
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  alter publication supabase_realtime add table public.channel_members;
exception
  when duplicate_object then null;
end;
$$;

-- ============================================================
-- Déclencheur push (migration 004)
-- ============================================================

-- ThyChat — migration 004 : déclencheur des notifications push, en SQL (alternative au « Database Webhook »).
--
-- À coller dans Supabase > SQL Editor > Run. Rejouable.
-- Chaque nouveau message appelle la fonction « send-push » (pg_net), qui prévient les personnes concernées.
--
-- Ensuite, UNE FOIS, enregistre le secret (le même que PUSH_WEBHOOK_SECRET dans Edge Functions > Secrets) :
--   insert into public.app_settings (key, value) values
--     ('push_url', 'https://<ton-projet>.supabase.co/functions/v1/send-push'),
--     ('push_secret', 'LE_MOT_DE_PASSE_CHOISI')
--   on conflict (key) do update set value = excluded.value;

create extension if not exists pg_net with schema extensions;

-- Réglages serveur : RLS activé et aucune règle => illisible depuis l'application.
create table if not exists public.app_settings (
  key   text primary key,
  value text not null
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

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

drop trigger if exists messages_notify_push on public.messages;
create trigger messages_notify_push
  after insert on public.messages
  for each row execute function public.notify_push();

-- ============================================================
-- Salons (spectacles) et sous-salons (migration 005)
-- ============================================================

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
-- Message « rayé » par son auteur, et photo (logo) de chaque espace.
-- Sans risque si exécuté deux fois.

alter table public.messages add column if not exists struck_at timestamptz;

alter table public.workspaces add column if not exists avatar_url text;

-- Les photos d'espace sont rangées dans le dossier « ws/<id de l'espace> » du stockage « avatars » ;
-- seuls les administrateurs de l'espace peuvent les envoyer, les remplacer ou les supprimer.
drop policy if exists avatars_ws_insert on storage.objects;
create policy avatars_ws_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = 'ws'
    and (storage.foldername(name))[2] ~ '^[0-9a-f-]{36}$'
    and public.is_workspace_admin(((storage.foldername(name))[2])::uuid)
  );

drop policy if exists avatars_ws_update on storage.objects;
create policy avatars_ws_update on storage.objects for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = 'ws'
    and (storage.foldername(name))[2] ~ '^[0-9a-f-]{36}$'
    and public.is_workspace_admin(((storage.foldername(name))[2])::uuid)
  );

drop policy if exists avatars_ws_delete on storage.objects;
create policy avatars_ws_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = 'ws'
    and (storage.foldername(name))[2] ~ '^[0-9a-f-]{36}$'
    and public.is_workspace_admin(((storage.foldername(name))[2])::uuid)
  );
-- Une date de tournée (étiquette) a une plage (début, fin) et des dates de représentation.
-- Sans risque si exécuté deux fois.

alter table public.tour_tags add column if not exists start_date date;
alter table public.tour_tags add column if not exists end_date date;
alter table public.tour_tags add column if not exists shows date[] not null default '{}';

-- Les anciennes dates uniques deviennent des plages d'un jour.
update public.tour_tags
   set start_date = on_date, end_date = on_date
 where on_date is not null and start_date is null and end_date is null;

alter table public.tour_tags drop constraint if exists tour_tags_range_check;
alter table public.tour_tags
  add constraint tour_tags_range_check check (
    (start_date is null and end_date is null)
    or (start_date is not null and end_date is not null and end_date >= start_date)
  );
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
-- Recherche dans les messages sans tenir compte des accents ni des majuscules.
-- Sans risque si exécuté deux fois.

create extension if not exists unaccent with schema extensions;

-- La fonction s'exécute avec les droits de la personne qui cherche : les règles RLS limitent déjà les messages lisibles.
create or replace function public.search_messages(needle text, in_channel uuid default null, max_rows int default 50)
returns table (id uuid, channel_id uuid, user_id uuid, body text, created_at timestamptz)
language sql stable security invoker set search_path = public, extensions as $$
  select m.id, m.channel_id, m.user_id, m.body, m.created_at
  from public.messages m
  where m.parent_id is null
    and (in_channel is null or m.channel_id = in_channel)
    and extensions.unaccent(m.body) ilike
        '%' || replace(replace(replace(extensions.unaccent(needle), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  order by m.created_at desc
  limit least(greatest(max_rows, 1), 200);
$$;

revoke all on function public.search_messages(text, uuid, int) from public, anon;
grant execute on function public.search_messages(text, uuid, int) to authenticated;
-- Documents PDF attachés à une date de tournée (feuilles de route, billets, livrets d'accueil…).
-- Les administrateurs de l'espace les ajoutent et les retirent ; toutes les personnes qui ont accès au spectacle les lisent.
-- Sans risque si exécuté deux fois.

create or replace function public.tag_room(tag uuid)
returns uuid
language sql stable security definer set search_path = public as $$
  select t.room_id from public.tour_tags t where t.id = tag;
$$;

create table if not exists public.tag_documents (
  id          uuid primary key default gen_random_uuid(),
  tag_id      uuid not null references public.tour_tags(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 160),
  path        text not null unique,
  size_bytes  integer check (size_bytes is null or size_bytes >= 0),
  created_by  uuid default auth.uid() references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists tag_documents_tag_idx on public.tag_documents (tag_id);

alter table public.tag_documents enable row level security;

drop policy if exists tag_documents_select on public.tag_documents;
create policy tag_documents_select on public.tag_documents for select to authenticated
  using (public.can_access_room(public.tag_room(tag_id)));

-- Le fichier doit être rangé dans le dossier <salon>/<date>/ correspondant.
drop policy if exists tag_documents_insert on public.tag_documents;
create policy tag_documents_insert on public.tag_documents for insert to authenticated
  with check (
    public.can_moderate_room(public.tag_room(tag_id))
    and left(path, 74) = public.tag_room(tag_id)::text || '/' || tag_id::text || '/'
  );

drop policy if exists tag_documents_delete on public.tag_documents;
create policy tag_documents_delete on public.tag_documents for delete to authenticated
  using (public.can_moderate_room(public.tag_room(tag_id)));

grant select, insert, delete on public.tag_documents to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.tag_documents;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;

-- Stockage privé « tag-documents » (PDF, 15 Mo maximum).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tag-documents', 'tag-documents', false, 15728640, array['application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = 15728640, allowed_mime_types = array['application/pdf'];

drop policy if exists tag_documents_files_select on storage.objects;
create policy tag_documents_files_select on storage.objects for select to authenticated
  using (
    bucket_id = 'tag-documents'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.can_access_room(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists tag_documents_files_insert on storage.objects;
create policy tag_documents_files_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'tag-documents'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.can_moderate_room(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists tag_documents_files_delete on storage.objects;
create policy tag_documents_files_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'tag-documents'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.can_moderate_room(((storage.foldername(name))[1])::uuid)
  );
-- Fiche technique (PDF) de chaque spectacle, avec la date de sa version.
-- Les administrateurs de l'espace ajoutent des versions successives ; toutes les personnes qui ont accès au spectacle les lisent.
-- Sans risque si exécuté deux fois.

create table if not exists public.room_sheets (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references public.rooms(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 160),
  path          text not null unique,
  version_date  date not null default current_date,
  size_bytes    integer check (size_bytes is null or size_bytes >= 0),
  created_by    uuid default auth.uid() references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists room_sheets_room_idx on public.room_sheets (room_id, version_date desc);

alter table public.room_sheets enable row level security;

drop policy if exists room_sheets_select on public.room_sheets;
create policy room_sheets_select on public.room_sheets for select to authenticated
  using (public.can_access_room(room_id));

-- Le fichier doit être rangé dans <salon>/fiche/.
drop policy if exists room_sheets_insert on public.room_sheets;
create policy room_sheets_insert on public.room_sheets for insert to authenticated
  with check (
    public.can_moderate_room(room_id)
    and left(path, 43) = room_id::text || '/fiche/'
  );

drop policy if exists room_sheets_delete on public.room_sheets;
create policy room_sheets_delete on public.room_sheets for delete to authenticated
  using (public.can_moderate_room(room_id));

grant select, insert, delete on public.room_sheets to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.room_sheets;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;

-- Les fichiers sont dans le stockage privé « tag-documents » (migration 012), dossier <salon>/fiche/ :
-- ses règles (lecture : accès au spectacle ; ajout et suppression : administrateurs) s'appliquent déjà.

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

-- ThyChat — migration 015 : un administrateur peut déplacer un message vers un autre sous-salon ou spectacle
-- (en cas d'erreur). À coller dans Supabase > SQL Editor > Run. Rejouable.
--
-- Règles : réservé aux administrateurs ; même espace ; pas de messages privés ; les photos suivent le message
-- (déplacées par l'application, voir migration 016) ; les dates (#) sont retirées si on change de spectacle
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

-- ---- 017 : documents et fiches techniques = PDF, images ou liens ----
alter table public.tag_documents add column if not exists kind text not null default 'file';
alter table public.tag_documents add column if not exists url text;
alter table public.tag_documents alter column path drop not null;

alter table public.room_sheets add column if not exists kind text not null default 'file';
alter table public.room_sheets add column if not exists url text;
alter table public.room_sheets alter column path drop not null;

alter table public.tag_documents drop constraint if exists tag_documents_kind_check;
alter table public.tag_documents add constraint tag_documents_kind_check check (
  (kind = 'file' and path is not null and url is null)
  or (kind = 'link' and path is null and url ~* '^https?://[^ ]+$' and char_length(url) <= 2000)
);

alter table public.room_sheets drop constraint if exists room_sheets_kind_check;
alter table public.room_sheets add constraint room_sheets_kind_check check (
  (kind = 'file' and path is not null and url is null)
  or (kind = 'link' and path is null and url ~* '^https?://[^ ]+$' and char_length(url) <= 2000)
);

-- Un fichier doit être rangé dans le bon dossier ; un lien n'a pas de fichier.
drop policy if exists tag_documents_insert on public.tag_documents;
create policy tag_documents_insert on public.tag_documents for insert to authenticated
  with check (
    public.can_moderate_room(public.tag_room(tag_id))
    and (path is null or left(path, 74) = public.tag_room(tag_id)::text || '/' || tag_id::text || '/')
  );

drop policy if exists room_sheets_insert on public.room_sheets;
create policy room_sheets_insert on public.room_sheets for insert to authenticated
  with check (
    public.can_moderate_room(room_id)
    and (path is null or left(path, 43) = room_id::text || '/fiche/')
  );

-- Le stockage accepte aussi les images.
update storage.buckets
  set allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']
  where id = 'tag-documents';

-- ---- 018 : nettoyage automatique des documents des dates passées ----
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create or replace function public.purge_old_documents()
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  push_url text;
  push_secret text;
begin
  select value into push_url from public.app_settings where key = 'push_url';
  select value into push_secret from public.app_settings where key = 'push_secret';
  if push_url is null or push_secret is null then
    return;
  end if;

  perform net.http_post(
    url := replace(push_url, '/send-push', '/purge-documents'),
    body := jsonb_build_object('days', 10),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', push_secret)
  );
end;
$$;

revoke all on function public.purge_old_documents() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'purge-old-documents';
  perform cron.schedule('purge-old-documents', '30 3 * * *', 'select public.purge_old_documents()');
end;
$$;

-- ---- 019 : seul l'auteur modifie son message ----
create or replace function public.guard_message_edit()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.channel_id is not distinct from old.channel_id
     and (new.body is distinct from old.body or new.tag_ids is distinct from old.tag_ids) then
    if auth.uid() is not null and auth.uid() <> old.user_id then
      raise exception 'Seul l''auteur peut modifier son message';
    end if;
    new.edited_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists messages_guard_edit on public.messages;
create trigger messages_guard_edit
  before update of body, tag_ids on public.messages
  for each row execute function public.guard_message_edit();

-- ---- 020 : Post-it ----
create table if not exists public.postits (
  id          uuid primary key default gen_random_uuid(),
  channel_id  uuid not null references public.channels(id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body        text not null check (char_length(btrim(body)) between 1 and 300),
  created_at  timestamptz not null default now()
);
create index if not exists postits_channel_idx on public.postits (channel_id, created_at);

alter table public.postits enable row level security;

drop policy if exists postits_select on public.postits;
create policy postits_select on public.postits for select to authenticated
  using (public.can_access_channel(channel_id));

drop policy if exists postits_insert on public.postits;
create policy postits_insert on public.postits for insert to authenticated
  with check (user_id = auth.uid() and public.can_access_channel(channel_id));

drop policy if exists postits_delete on public.postits;
create policy postits_delete on public.postits for delete to authenticated
  using ((user_id = auth.uid() and public.can_access_channel(channel_id)) or public.can_moderate_channel(channel_id));

grant select, insert, delete on public.postits to authenticated;

create table if not exists public.postit_states (
  postit_id   uuid not null references public.postits(id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  state       text not null check (state in ('discarded', 'purged')),
  updated_at  timestamptz not null default now(),
  primary key (postit_id, user_id)
);

alter table public.postit_states enable row level security;

drop policy if exists postit_states_own on public.postit_states;
create policy postit_states_own on public.postit_states for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from public.postits p where p.id = postit_id));

grant select, insert, update, delete on public.postit_states to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.postits;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;

-- ---- 021 : modification d'un Post-it par son auteur ----
drop policy if exists postits_update on public.postits;
create policy postits_update on public.postits for update to authenticated
  using (user_id = auth.uid() and public.can_access_channel(channel_id))
  with check (user_id = auth.uid() and public.can_access_channel(channel_id));

-- Seul le texte peut changer (pas l'auteur, pas le fil).
revoke update on public.postits from authenticated;
grant update (body) on public.postits to authenticated;

-- ---- 022 : les To-Do ----
alter table public.postits add column if not exists kind text not null default 'note';
alter table public.postits add column if not exists items jsonb;

alter table public.postits drop constraint if exists postits_kind_check;
alter table public.postits add constraint postits_kind_check check (kind in ('note', 'todo'));

alter table public.postits drop constraint if exists postits_items_check;
alter table public.postits add constraint postits_items_check check (
  (kind = 'note' and items is null)
  or (kind = 'todo' and jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 30)
);

-- L'auteur peut corriger le titre et la liste ; personne d'autre ne modifie la ligne directement.
revoke update on public.postits from authenticated;
grant update (body, items) on public.postits to authenticated;

-- Cocher / décocher une case : ouvert à toute personne ayant accès au fil.
create or replace function public.set_todo_item(p_id uuid, p_index int, p_done boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  ch uuid;
  total int;
begin
  select channel_id, jsonb_array_length(items) into ch, total from public.postits where id = p_id and kind = 'todo';
  if ch is null or not public.can_access_channel(ch) then
    raise exception 'To-Do introuvable';
  end if;
  if p_index < 0 or p_index >= total then
    raise exception 'Case inconnue';
  end if;
  update public.postits
     set items = jsonb_set(items, array[p_index::text, 'done'], to_jsonb(p_done))
   where id = p_id;
end;
$$;

revoke all on function public.set_todo_item(uuid, int, boolean) from public;
grant execute on function public.set_todo_item(uuid, int, boolean) to authenticated;

-- ---- 023 : signature des cases cochées ----
create or replace function public.set_todo_item(p_id uuid, p_index int, p_done boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  ch uuid;
  total int;
  idx text := p_index::text;
begin
  select channel_id, jsonb_array_length(items) into ch, total from public.postits where id = p_id and kind = 'todo';
  if ch is null or not public.can_access_channel(ch) then
    raise exception 'To-Do introuvable';
  end if;
  if p_index < 0 or p_index >= total then
    raise exception 'Case inconnue';
  end if;
  if p_done then
    update public.postits
       set items = jsonb_set(jsonb_set(items, array[idx, 'done'], 'true'::jsonb), array[idx, 'by'], to_jsonb(auth.uid()::text))
     where id = p_id;
  else
    update public.postits
       set items = jsonb_set(items, array[idx, 'done'], 'false'::jsonb) #- array[idx, 'by']
     where id = p_id;
  end if;
end;
$$;

revoke all on function public.set_todo_item(uuid, int, boolean) from public;
grant execute on function public.set_todo_item(uuid, int, boolean) to authenticated;

-- ---- 024 : Post-it visibles seulement après l'arrivée ----
create or replace function public.postit_arrival(uid uuid, ch uuid)
returns timestamptz
language sql stable security definer set search_path = public as $$
  select greatest(
    coalesce((select wm.created_at from public.workspace_members wm where wm.workspace_id = c.workspace_id and wm.user_id = uid), '-infinity'::timestamptz),
    case when c.kind = 'channel' and r.id is not null and not r.everyone
      then coalesce((select rm.created_at from public.room_members rm where rm.room_id = r.id and rm.user_id = uid), '-infinity'::timestamptz)
      else '-infinity'::timestamptz end,
    case when c.kind = 'dm' or not c.everyone
      then coalesce((select cm.created_at from public.channel_members cm where cm.channel_id = c.id and cm.user_id = uid), '-infinity'::timestamptz)
      else '-infinity'::timestamptz end
  )
  from public.channels c
  left join public.rooms r on r.id = c.room_id
  where c.id = ch;
$$;

revoke all on function public.postit_arrival(uuid, uuid) from public;
grant execute on function public.postit_arrival(uuid, uuid) to authenticated;

drop policy if exists postits_select on public.postits;
create policy postits_select on public.postits for select to authenticated
  using (
    public.can_access_channel(channel_id)
    and (kind = 'todo' or user_id = auth.uid() or created_at >= public.postit_arrival(auth.uid(), channel_id))
  );

-- ---- 025 : messages et photos épinglés ----
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
