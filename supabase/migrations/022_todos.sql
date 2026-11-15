-- ThyChat — migration 022 : les To-Do (feuille de carnet à cases à cocher, collée en haut d'un fil comme un Post-it).
--
-- À coller dans Supabase > SQL Editor > Run. Rejouable. Nécessite la migration 020 (Post-it) et la 021.
-- Une To-Do est une ligne de `postits` avec kind = 'todo' : `body` = le titre, `items` = [{"t": "texte", "done": false}, …].
-- Les cases sont communes à tout le fil : n'importe qui ayant accès au fil peut cocher (fonction set_todo_item).
-- Quand toutes les cases sont cochées, la feuille disparaît du haut du fil ; elle reste dans « Post-it jetés ».

alter table public.postits add column if not exists kind text not null default 'note';
alter table public.postits add column if not exists items jsonb;

alter table public.postits drop constraint if exists postits_kind_check;
alter table public.postits add constraint postits_kind_check check (kind in ('note', 'todo'));

alter table public.postits drop constraint if exists postits_items_check;
alter table public.postits add constraint postits_items_check check (
  (kind = 'note' and items is null)
  or (kind = 'todo' and jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 30)
);

-- L'auteur peut corriger le titre et la liste ; personne d'autre ne modifie la ligne directement.
revoke update on public.postits from authenticated;
grant update (body, items) on public.postits to authenticated;

-- Cocher / décocher une case : ouvert à toute personne ayant accès au fil.
create or replace function public.set_todo_item(p_id uuid, p_index int, p_done boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  ch uuid;
  total int;
begin
  select channel_id, jsonb_array_length(items) into ch, total from public.postits where id = p_id and kind = 'todo';
  if ch is null or not public.can_access_channel(ch) then
    raise exception 'To-Do introuvable';
  end if;
  if p_index < 0 or p_index >= total then
    raise exception 'Case inconnue';
  end if;
  update public.postits
     set items = jsonb_set(items, array[p_index::text, 'done'], to_jsonb(p_done))
   where id = p_id;
end;
$$;

revoke all on function public.set_todo_item(uuid, int, boolean) from public;
grant execute on function public.set_todo_item(uuid, int, boolean) to authenticated;
