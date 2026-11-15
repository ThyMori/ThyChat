-- ThyChat — migration 027 : demandes d'inscription.
--
-- À coller dans Supabase > SQL Editor > Run. Rejouable.
--
-- Une personne sans compte peut « demander à s'inscrire » depuis l'écran de connexion. La fonction `request-access`
-- enregistre la demande ici (trace conservée même si l'e-mail n'a pas pu partir) puis écrit à contact@thierry-morin.com.
-- Personne ne peut lire ou écrire cette table depuis l'application, sauf l'administrateur général qui peut la lire.

create table if not exists public.access_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  email text not null check (char_length(email) between 3 and 160),
  production text not null check (char_length(production) between 1 and 160),
  mail_sent boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists access_requests_created_idx on public.access_requests (created_at desc);

alter table public.access_requests enable row level security;
drop policy if exists access_requests_select on public.access_requests;
create policy access_requests_select on public.access_requests for select to authenticated
  using (public.is_super_as(auth.uid()));
