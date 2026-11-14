-- Recherche dans les messages sans tenir compte des accents ni des majuscules.
-- Sans risque si exécuté deux fois.

create extension if not exists unaccent with schema extensions;

-- La fonction s'exécute avec les droits de la personne qui cherche : les règles RLS limitent déjà les messages lisibles.
create or replace function public.search_messages(needle text, in_channel uuid default null, max_rows int default 50)
returns table (id uuid, channel_id uuid, user_id uuid, body text, created_at timestamptz)
language sql stable security invoker set search_path = public, extensions as $$
  select m.id, m.channel_id, m.user_id, m.body, m.created_at
  from public.messages m
  where m.parent_id is null
    and (in_channel is null or m.channel_id = in_channel)
    and extensions.unaccent(m.body) ilike
        '%' || replace(replace(replace(extensions.unaccent(needle), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  order by m.created_at desc
  limit least(greatest(max_rows, 1), 200);
$$;

revoke all on function public.search_messages(text, uuid, int) from public, anon;
grant execute on function public.search_messages(text, uuid, int) to authenticated;
