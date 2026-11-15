-- ThyChat — migration 031 : la pastille « Support » marque l'entrée d'un administrateur général dans un espace existant.
--
-- À coller dans Supabase > SQL Editor > Run. Rejouable. Après la 030.
--
-- « Rejoindre » (Plateforme) marque désormais la ligne d'appartenance (workspace_members.support = true) : la pastille « Support »
-- n'apparaît que pour ces entrées de dépannage, pas dans les espaces que l'administrateur général a créés.

alter table public.workspace_members add column if not exists support boolean not null default false;

create or replace function public.join_workspace_as_support(ws uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super_admin() then raise exception 'Réservé à l''administrateur général'; end if;
  if not exists (select 1 from public.workspaces w where w.id = ws) then raise exception 'Espace introuvable'; end if;
  insert into public.workspace_members (workspace_id, user_id, role, support)
  values (ws, auth.uid(), 'admin', true)
  on conflict (workspace_id, user_id) do update set role = 'admin', support = true;
end;
$$;
revoke all on function public.join_workspace_as_support(uuid) from public, anon;
grant execute on function public.join_workspace_as_support(uuid) to authenticated;
