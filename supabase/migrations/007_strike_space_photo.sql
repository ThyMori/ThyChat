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
