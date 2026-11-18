-- 033 : historique des notifications (la cloche de ThyChat).
-- La fonction « send-push » y inscrit, pour chaque personne prévenue, ce qu'elle a reçu (hors sourdines).
-- Chaque personne ne lit, ne marque comme lue et n'efface que SES lignes. Les lignes de plus de 30 jours sont purgées par la fonction.
-- À coller dans Supabase > SQL Editor > Run. Rejouable. Supabase peut afficher « Potential issue detected » (drop policy) : c'est normal, clique sur « Run query ».

create table if not exists public.notification_log (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  kind         text not null default 'message' check (kind in ('message', 'dm', 'doc')),
  title        text not null,
  body         text not null default '',
  workspace_id uuid references public.workspaces(id) on delete cascade,
  channel_id   uuid references public.channels(id) on delete set null,
  created_at   timestamptz not null default now(),
  read_at      timestamptz
);
create index if not exists notification_log_user_idx on public.notification_log (user_id, created_at desc);

alter table public.notification_log enable row level security;

drop policy if exists notification_log_select on public.notification_log;
create policy notification_log_select on public.notification_log for select to authenticated
  using (user_id = auth.uid());

drop policy if exists notification_log_update on public.notification_log;
create policy notification_log_update on public.notification_log for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists notification_log_delete on public.notification_log;
create policy notification_log_delete on public.notification_log for delete to authenticated
  using (user_id = auth.uid());

-- Pas de droit d'insertion : seule la fonction serveur (clé secrète) écrit. Seule la colonne « read_at » est modifiable.
revoke all on public.notification_log from anon, authenticated;
grant select, delete on public.notification_log to authenticated;
grant update (read_at) on public.notification_log to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.notification_log;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;
