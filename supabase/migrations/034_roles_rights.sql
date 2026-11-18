-- 034 : droits des fonctions Technique, Prod et RG, précisés.
--   Fiche technique : Technique et RG lisent et modifient ; Prod lit seulement ; sans fonction : lecture si la case « lit la fiche technique » est cochée.
--   Feuilles de route : Prod seule les modifie ; tout le monde (ayant accès au spectacle) les lit.
--   Assigner des personnes au spectacle : Prod et RG (inchangé). Les administrateurs de l'espace gardent tous les droits.
-- Avant cette migration, Technique et Prod modifiaient la fiche, et Prod et RG modifiaient les feuilles de route : l'application
-- (version 5.4.0) masque déjà les boutons selon les nouvelles règles, la base ne les applique qu'après cette migration.
-- À coller dans Supabase > SQL Editor > Run. Rejouable.

create or replace function public.can_edit_sheet(rm uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.staff_has_as(auth.uid(), rm, array['technique', 'rg'], false);
$$;

create or replace function public.can_edit_roadmap(rm uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.staff_has_as(auth.uid(), rm, array['prod'], false);
$$;
