-- Une date de tournée (étiquette) a une plage (début, fin) et des dates de représentation.
-- Sans risque si exécuté deux fois.

alter table public.tour_tags add column if not exists start_date date;
alter table public.tour_tags add column if not exists end_date date;
alter table public.tour_tags add column if not exists shows date[] not null default '{}';

-- Les anciennes dates uniques deviennent des plages d'un jour.
update public.tour_tags
   set start_date = on_date, end_date = on_date
 where on_date is not null and start_date is null and end_date is null;

alter table public.tour_tags drop constraint if exists tour_tags_range_check;
alter table public.tour_tags
  add constraint tour_tags_range_check check (
    (start_date is null and end_date is null)
    or (start_date is not null and end_date is not null and end_date >= start_date)
  );
