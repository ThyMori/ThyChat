-- ThyChat — migration 030 : l'administrateur général gère la structure de la plateforme, sans lire les contenus.
--
-- À coller dans Supabase > SQL Editor > Run. Rejouable. Après la 029. Redéployer aussi la fonction « send-push ».
--
-- Jusqu'ici l'administrateur général était d'office membre et administrateur de TOUS les espaces : il lisait tout.
-- Désormais il n'est plus que ce qu'il est vraiment (membre des espaces où il a été ajouté) et il dispose, en plus, de pouvoirs de structure :
--   - voir la liste de tous les espaces (nom, nombre de membres et d'administrateurs, espaces « sans administrateur ») ;
--   - créer un espace ;
--   - s'ajouter lui-même comme administrateur d'un espace (« Rejoindre ») pour dépanner, sans validation des administrateurs de l'espace.
--     Cet ajout est visible : il apparaît dans la liste des membres (pastille « Support »).
-- Il ne lit donc plus les messages, sous-salons privés ou fichiers d'un espace dans lequel il n'est pas entré.
-- Il ne reçoit plus de notifications pour les espaces dont il n'est pas membre (voir la fonction send-push).

-- 1. Plus de passe-droit : les droits d'un espace viennent de l'appartenance à cet espace.
create or replace function public.ws_member_as(uid uuid, ws uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = uid);
$$;

create or replace function public.ws_admin_as(uid uuid, ws uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = uid and m.role = 'admin'
  );
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

-- 2. Pouvoirs de structure de l'administrateur général.
drop policy if exists workspaces_select_super on public.workspaces;
create policy workspaces_select_super on public.workspaces for select to authenticated
  using (public.is_super_admin());

-- La liste de tous les espaces, avec de simples comptes (jamais de contenu).
create or replace function public.platform_workspaces()
returns table (id uuid, name text, theme text, avatar_url text, members bigint, admins bigint, joined boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_super_admin() then raise exception 'Réservé à l''administrateur général'; end if;
  return query
    select w.id, w.name, w.theme, w.avatar_url,
      (select count(*) from public.workspace_members m where m.workspace_id = w.id),
      (select count(*) from public.workspace_members m where m.workspace_id = w.id and m.role = 'admin'),
      exists (select 1 from public.workspace_members m where m.workspace_id = w.id and m.user_id = auth.uid())
    from public.workspaces w
    order by w.name;
end;
$$;
revoke all on function public.platform_workspaces() from public, anon;
grant execute on function public.platform_workspaces() to authenticated;

-- Se rajouter comme administrateur d'un espace (support, espace sans administrateur).
create or replace function public.join_workspace_as_support(ws uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super_admin() then raise exception 'Réservé à l''administrateur général'; end if;
  if not exists (select 1 from public.workspaces w where w.id = ws) then raise exception 'Espace introuvable'; end if;
  insert into public.workspace_members (workspace_id, user_id, role)
  values (ws, auth.uid(), 'admin')
  on conflict (workspace_id, user_id) do update set role = 'admin';
end;
$$;
revoke all on function public.join_workspace_as_support(uuid) from public, anon;
grant execute on function public.join_workspace_as_support(uuid) to authenticated;

-- 3. Pour ne rien perdre : un administrateur général reste membre administrateur des espaces qu'il a créés.
insert into public.workspace_members (workspace_id, user_id, role)
select w.id, w.created_by, 'admin'
from public.workspaces w
join public.profiles p on p.id = w.created_by and p.is_super_admin
on conflict (workspace_id, user_id) do nothing;
