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
