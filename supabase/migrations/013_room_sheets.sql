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
