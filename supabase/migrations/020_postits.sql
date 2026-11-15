-- ThyChat — migration 020 : les Post-it (petits mots jaunes collés en haut d'un fil).
--
-- À coller dans Supabase > SQL Editor > Run. Rejouable. Nécessite les migrations 003 et suivantes (règles d'accès aux sous-salons).
-- Un Post-it est visible par toutes les personnes qui ont accès au fil. Chacune le « jette » pour elle seule :
--   - jeté : il disparaît du haut du fil et se retrouve dans « Post-it jetés » (menu ⋮) ;
--   - jeté définitivement : il disparaît aussi de cette liste (pour cette personne seulement).
-- L'auteur (ou un administrateur) peut le retirer pour tout le monde.

create table if not exists public.postits (
  id          uuid primary key default gen_random_uuid(),
  channel_id  uuid not null references public.channels(id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body        text not null check (char_length(btrim(body)) between 1 and 300),
  created_at  timestamptz not null default now()
);
create index if not exists postits_channel_idx on public.postits (channel_id, created_at);

alter table public.postits enable row level security;

drop policy if exists postits_select on public.postits;
create policy postits_select on public.postits for select to authenticated
  using (public.can_access_channel(channel_id));

drop policy if exists postits_insert on public.postits;
create policy postits_insert on public.postits for insert to authenticated
  with check (user_id = auth.uid() and public.can_access_channel(channel_id));

drop policy if exists postits_delete on public.postits;
create policy postits_delete on public.postits for delete to authenticated
  using ((user_id = auth.uid() and public.can_access_channel(channel_id)) or public.can_moderate_channel(channel_id));

grant select, insert, delete on public.postits to authenticated;

create table if not exists public.postit_states (
  postit_id   uuid not null references public.postits(id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  state       text not null check (state in ('discarded', 'purged')),
  updated_at  timestamptz not null default now(),
  primary key (postit_id, user_id)
);

alter table public.postit_states enable row level security;

drop policy if exists postit_states_own on public.postit_states;
create policy postit_states_own on public.postit_states for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from public.postits p where p.id = postit_id));

grant select, insert, update, delete on public.postit_states to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.postits;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;
