-- Couleur (thème) de chaque espace.
-- À coller dans Supabase > SQL Editor > New query, puis « Run ». Sans risque si exécuté plusieurs fois.
--
-- Valeurs possibles : ambre, cerise, magenta, violet, indigo, bleu, turquoise, vert, citron, moutarde.
-- Sans valeur, ThyChat déduit une couleur de l'identifiant de l'espace.

alter table public.workspaces add column if not exists theme text;
