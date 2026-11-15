-- ThyChat — migration 021 : l'auteur d'un Post-it peut en modifier le texte.
--
-- À coller dans Supabase > SQL Editor > Run. Rejouable. Nécessite la migration 020.

drop policy if exists postits_update on public.postits;
create policy postits_update on public.postits for update to authenticated
  using (user_id = auth.uid() and public.can_access_channel(channel_id))
  with check (user_id = auth.uid() and public.can_access_channel(channel_id));

-- Seul le texte peut changer (pas l'auteur, pas le fil).
revoke update on public.postits from authenticated;
grant update (body) on public.postits to authenticated;
