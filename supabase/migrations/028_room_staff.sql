-- ThyChat — migration 028 : fonctions par spectacle (Technique, Prod, RG) et droits associés.
--
-- À coller dans Supabase > SQL Editor > Run. Rejouable. Après la 027. Redéployer aussi la fonction « send-push ».
--
-- Dans chaque spectacle, une personne peut avoir une ou plusieurs fonctions :
--   Technique : lit et modifie la fiche technique.
--   Prod, RG  : lisent et modifient la fiche technique ET les feuilles de route, et assignent des personnes au spectacle
--               (accès au spectacle, fonctions des autres).
-- Une personne sans fonction peut lire la fiche technique si la case « lit la fiche technique » est cochée.
-- Tout le monde lit les feuilles de route (documents des dates) des spectacles auxquels il a accès.
-- Les administrateurs de l'espace ont tous les droits sur tous les spectacles de leur espace.
-- Les droits sont dans la base (RLS et stockage), pas seulement dans l'interface.
--
-- IMPORTANT : jusqu'ici tout le monde lisait la fiche technique. Pour ne rien casser, cette migration donne la case
-- « lit la fiche technique » à toutes les personnes qui ont aujourd'hui accès à un spectacle. Décoche-la ensuite si besoin.

create table if not exists public.room_staff (
  room_id     uuid not null references public.rooms(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  functions   text[] not null default '{}' check (functions <@ array['technique', 'prod', 'rg']),
  sheet_read  boolean not null default false,
  primary key (room_id, user_id)
);
create index if not exists room_staff_user_idx on public.room_staff (user_id);

-- Les droits (administrateur de l'espace, ou fonction dans le spectacle ET accès au spectacle).
create or replace function public.staff_has_as(uid uuid, rm uuid, wanted text[], with_sheet_read boolean)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.rooms r where r.id = rm and public.ws_admin_as(uid, r.workspace_id))
      or (
        public.can_access_room_as(uid, rm)
        and exists (
          select 1 from public.room_staff s
          where s.room_id = rm and s.user_id = uid
            and (s.functions && wanted or (with_sheet_read and s.sheet_read))
        )
      );
$$;

create or replace function public.can_read_sheet(rm uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.staff_has_as(auth.uid(), rm, array['technique', 'prod', 'rg'], true);
$$;
create or replace function public.can_edit_sheet(rm uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.staff_has_as(auth.uid(), rm, array['technique', 'prod', 'rg'], false);
$$;
create or replace function public.can_edit_roadmap(rm uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.staff_has_as(auth.uid(), rm, array['prod', 'rg'], false);
$$;
create or replace function public.can_assign_room(rm uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.staff_has_as(auth.uid(), rm, array['prod', 'rg'], false);
$$;

-- Réglages de l'équipe : lisibles par la personne et par ceux qui assignent ; modifiables par ceux qui assignent.
alter table public.room_staff enable row level security;

drop policy if exists room_staff_select on public.room_staff;
create policy room_staff_select on public.room_staff for select to authenticated
  using (user_id = auth.uid() or public.can_assign_room(room_id));

drop policy if exists room_staff_insert on public.room_staff;
create policy room_staff_insert on public.room_staff for insert to authenticated
  with check (public.can_assign_room(room_id) and public.user_in_room_workspace(room_id, user_id));

drop policy if exists room_staff_update on public.room_staff;
create policy room_staff_update on public.room_staff for update to authenticated
  using (public.can_assign_room(room_id))
  with check (public.can_assign_room(room_id) and public.user_in_room_workspace(room_id, user_id));

drop policy if exists room_staff_delete on public.room_staff;
create policy room_staff_delete on public.room_staff for delete to authenticated
  using (public.can_assign_room(room_id));

grant select, insert, update, delete on public.room_staff to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.room_staff;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;

-- Assigner des personnes à un spectacle : administrateurs de l'espace, Prod et RG de ce spectacle.
drop policy if exists room_members_insert on public.room_members;
create policy room_members_insert on public.room_members for insert to authenticated
  with check (public.can_assign_room(room_id) and public.user_in_room_workspace(room_id, user_id));

drop policy if exists room_members_delete on public.room_members;
create policy room_members_delete on public.room_members for delete to authenticated
  using (public.can_assign_room(room_id));

-- Fiche technique : lecture selon le droit de lecture, ajout et suppression selon le droit de modification.
drop policy if exists room_sheets_select on public.room_sheets;
create policy room_sheets_select on public.room_sheets for select to authenticated
  using (public.can_read_sheet(room_id));

drop policy if exists room_sheets_insert on public.room_sheets;
create policy room_sheets_insert on public.room_sheets for insert to authenticated
  with check (public.can_edit_sheet(room_id) and left(path, 43) = room_id::text || '/fiche/');

drop policy if exists room_sheets_delete on public.room_sheets;
create policy room_sheets_delete on public.room_sheets for delete to authenticated
  using (public.can_edit_sheet(room_id));

-- Feuilles de route (documents des dates) : tout le monde lit ; Prod et RG modifient.
drop policy if exists tag_documents_insert on public.tag_documents;
create policy tag_documents_insert on public.tag_documents for insert to authenticated
  with check (
    public.can_edit_roadmap(public.tag_room(tag_id))
    and left(path, 74) = public.tag_room(tag_id)::text || '/' || tag_id::text || '/'
  );

drop policy if exists tag_documents_delete on public.tag_documents;
create policy tag_documents_delete on public.tag_documents for delete to authenticated
  using (public.can_edit_roadmap(public.tag_room(tag_id)));

-- Les mêmes règles pour les fichiers (stockage « tag-documents » : <spectacle>/fiche/… pour la fiche technique).
drop policy if exists tag_documents_files_select on storage.objects;
create policy tag_documents_files_select on storage.objects for select to authenticated
  using (
    bucket_id = 'tag-documents'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and case when (storage.foldername(name))[2] = 'fiche'
         then public.can_read_sheet(((storage.foldername(name))[1])::uuid)
         else public.can_access_room(((storage.foldername(name))[1])::uuid) end
  );

drop policy if exists tag_documents_files_insert on storage.objects;
create policy tag_documents_files_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'tag-documents'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and case when (storage.foldername(name))[2] = 'fiche'
         then public.can_edit_sheet(((storage.foldername(name))[1])::uuid)
         else public.can_edit_roadmap(((storage.foldername(name))[1])::uuid) end
  );

drop policy if exists tag_documents_files_delete on storage.objects;
create policy tag_documents_files_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'tag-documents'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and case when (storage.foldername(name))[2] = 'fiche'
         then public.can_edit_sheet(((storage.foldername(name))[1])::uuid)
         else public.can_edit_roadmap(((storage.foldername(name))[1])::uuid) end
  );

-- Quitter l'espace : les fonctions dans ses spectacles disparaissent aussi.
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

  delete from public.room_staff s
  using public.rooms r
  where s.room_id = r.id and r.workspace_id = old.workspace_id and s.user_id = old.user_id;
  return old;
end;
$$;

-- Reprise de l'existant : toutes les personnes qui ont accès à un spectacle continuent de lire sa fiche technique.
insert into public.room_staff (room_id, user_id, sheet_read)
select r.id, m.user_id, true
from public.rooms r
join public.workspace_members m on m.workspace_id = r.workspace_id and m.role <> 'admin'
where r.everyone or exists (select 1 from public.room_members rm where rm.room_id = r.id and rm.user_id = m.user_id)
on conflict (room_id, user_id) do nothing;
