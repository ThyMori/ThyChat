-- ThyChat — migration 017 : documents et fiches techniques = PDF, images ou liens.
--
-- À coller dans Supabase > SQL Editor > Run. Rejouable. Nécessite les migrations 012 et 013.
-- Un document est soit un fichier (kind = 'file', rangé dans le stockage privé « tag-documents »), soit un lien web (kind = 'link').

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
