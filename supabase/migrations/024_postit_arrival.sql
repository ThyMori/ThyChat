-- ThyChat — migration 024 : une personne qui arrive dans un fil ne voit que les Post-it posés après son arrivée.
--
-- À coller dans Supabase > SQL Editor > Run. Rejouable. Nécessite la migration 020.
-- « Arrivée » = la date la plus récente parmi : entrée dans l'espace, entrée dans le spectacle (s'il est sur invitation),
-- entrée dans le sous-salon (s'il est sur invitation). Les To-Do restent visibles par tout le monde tant qu'elles ne sont pas terminées.
-- Rien ne change pour les personnes déjà là : tous les Post-it existants datent d'après leur arrivée.

create or replace function public.postit_arrival(uid uuid, ch uuid)
returns timestamptz
language sql stable security definer set search_path = public as $$
  select greatest(
    coalesce((select wm.created_at from public.workspace_members wm where wm.workspace_id = c.workspace_id and wm.user_id = uid), '-infinity'::timestamptz),
    case when c.kind = 'channel' and r.id is not null and not r.everyone
      then coalesce((select rm.created_at from public.room_members rm where rm.room_id = r.id and rm.user_id = uid), '-infinity'::timestamptz)
      else '-infinity'::timestamptz end,
    case when c.kind = 'dm' or not c.everyone
      then coalesce((select cm.created_at from public.channel_members cm where cm.channel_id = c.id and cm.user_id = uid), '-infinity'::timestamptz)
      else '-infinity'::timestamptz end
  )
  from public.channels c
  left join public.rooms r on r.id = c.room_id
  where c.id = ch;
$$;

revoke all on function public.postit_arrival(uuid, uuid) from public;
grant execute on function public.postit_arrival(uuid, uuid) to authenticated;

drop policy if exists postits_select on public.postits;
create policy postits_select on public.postits for select to authenticated
  using (
    public.can_access_channel(channel_id)
    and (kind = 'todo' or user_id = auth.uid() or created_at >= public.postit_arrival(auth.uid(), channel_id))
  );
