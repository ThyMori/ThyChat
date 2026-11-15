-- ThyChat — migration 029 : tout membre d'un spectacle peut créer des sous-salons et y inviter les membres de ce spectacle.
--
-- À coller dans Supabase > SQL Editor > Run. Rejouable. Après la 028.
--
-- - Chaque sous-salon garde la trace de son créateur (channels.created_by).
-- - Toute personne qui a accès à un spectacle peut y créer un sous-salon (ouvert à tous ou réservé) ; le créateur le renomme,
--   le supprime et choisit qui y entre, parmi les personnes qui ont accès au spectacle. Il y accède toujours, tant qu'il a accès au spectacle.
-- - Les administrateurs de l'espace gardent tous les droits. Une personne Prod ou RG qui n'est pas invitée dans un sous-salon réservé
--   ne le voit pas et ne peut pas agir dessus.

alter table public.channels add column if not exists created_by uuid default auth.uid() references auth.users(id) on delete set null;

create or replace function public.channel_room(ch uuid)
returns uuid
language sql stable security definer set search_path = public as $$
  select c.room_id from public.channels c where c.id = ch;
$$;

-- Créateur d'un sous-salon (qui a toujours accès au spectacle) ou administrateur de l'espace.
create or replace function public.can_manage_channel(ch uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.channels c
    where c.id = ch and c.kind = 'channel' and (
      public.is_workspace_admin(c.workspace_id)
      or (c.created_by = auth.uid() and public.can_access_room(c.room_id))
    )
  );
$$;

-- Le créateur accède à son sous-salon même réservé (sans devoir s'y ajouter lui-même).
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
          and (c.everyone or c.created_by = uid or exists (
            select 1 from public.channel_members m where m.channel_id = c.id and m.user_id = uid))
        )
      ))
      or (c.kind = 'dm' and exists (
        select 1 from public.channel_members m where m.channel_id = c.id and m.user_id = uid))
      or (c.kind = 'notes' and c.owner_id = uid and public.can_access_room_as(uid, c.room_id))
    )
  );
$$;

drop policy if exists channels_insert on public.channels;
create policy channels_insert on public.channels for insert to authenticated
  with check (
    kind = 'channel' and (
      public.is_workspace_admin(workspace_id)
      or (room_id is not null and created_by = auth.uid() and public.can_access_room(room_id))
    )
  );

drop policy if exists channels_update on public.channels;
create policy channels_update on public.channels for update to authenticated
  using (kind = 'channel' and public.can_manage_channel(id))
  with check (
    kind = 'channel' and (
      public.is_workspace_admin(workspace_id)
      or (created_by = auth.uid() and room_id is not null and public.can_access_room(room_id))
    )
  );

drop policy if exists channels_delete on public.channels;
create policy channels_delete on public.channels for delete to authenticated
  using (
    (kind = 'channel' and public.can_manage_channel(id))
    or (kind = 'dm' and exists (
      select 1 from public.channel_members m where m.channel_id = channels.id and m.user_id = auth.uid()
    ))
  );

-- Inviter dans un sous-salon : un administrateur (tout membre de l'espace) ou le créateur (membres du spectacle seulement).
drop policy if exists channel_members_insert on public.channel_members;
create policy channel_members_insert on public.channel_members for insert to authenticated
  with check (
    public.can_manage_channel(channel_id)
    and public.user_in_channel_workspace(channel_id, user_id)
    and (
      public.can_moderate_channel(channel_id)
      or public.can_access_room_as(user_id, public.channel_room(channel_id))
    )
  );

drop policy if exists channel_members_delete on public.channel_members;
create policy channel_members_delete on public.channel_members for delete to authenticated
  using (public.can_manage_channel(channel_id));
