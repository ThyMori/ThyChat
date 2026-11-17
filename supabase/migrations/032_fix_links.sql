-- 032 : corrige l'ajout d'un lien web (fiche technique et feuilles de route).
-- La migration 028 avait remplacé les règles d'ajout sans la clause « path is null » (ajoutée par la 017) :
-- un lien n'a pas de fichier (path vide), il était donc refusé avec
-- « new row violates row-level security policy for table "room_sheets" ».
-- À coller dans Supabase > SQL Editor > Run. Rejouable. Supabase peut afficher « Potential issue detected » (drop policy) : c'est normal, clique sur « Run query ».

drop policy if exists room_sheets_insert on public.room_sheets;
create policy room_sheets_insert on public.room_sheets for insert to authenticated
  with check (
    public.can_edit_sheet(room_id)
    and (path is null or left(path, 43) = room_id::text || '/fiche/')
  );

drop policy if exists tag_documents_insert on public.tag_documents;
create policy tag_documents_insert on public.tag_documents for insert to authenticated
  with check (
    public.can_edit_roadmap(public.tag_room(tag_id))
    and (path is null or left(path, 74) = public.tag_room(tag_id)::text || '/' || tag_id::text || '/')
  );
