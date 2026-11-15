-- ThyChat — migration 023 : chaque case cochée d'une To-Do porte la signature de la personne qui l'a cochée.
--
-- À coller dans Supabase > SQL Editor > Run. Rejouable. Nécessite la migration 022.
-- Chaque ligne de `items` devient {"t": "texte", "done": true, "by": "<id de la personne>"} ; décocher retire la signature.

create or replace function public.set_todo_item(p_id uuid, p_index int, p_done boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  ch uuid;
  total int;
  idx text := p_index::text;
begin
  select channel_id, jsonb_array_length(items) into ch, total from public.postits where id = p_id and kind = 'todo';
  if ch is null or not public.can_access_channel(ch) then
    raise exception 'To-Do introuvable';
  end if;
  if p_index < 0 or p_index >= total then
    raise exception 'Case inconnue';
  end if;
  if p_done then
    update public.postits
       set items = jsonb_set(jsonb_set(items, array[idx, 'done'], 'true'::jsonb), array[idx, 'by'], to_jsonb(auth.uid()::text))
     where id = p_id;
  else
    update public.postits
       set items = jsonb_set(items, array[idx, 'done'], 'false'::jsonb) #- array[idx, 'by']
     where id = p_id;
  end if;
end;
$$;

revoke all on function public.set_todo_item(uuid, int, boolean) from public;
grant execute on function public.set_todo_item(uuid, int, boolean) to authenticated;
