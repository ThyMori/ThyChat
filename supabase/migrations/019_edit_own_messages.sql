-- ThyChat — migration 019 : seul l'auteur modifie le texte (ou les dates #) de son message.
--
-- À coller dans Supabase > SQL Editor > Run. Rejouable.
-- L'application laisse chacun modifier ses propres messages ; cette règle l'impose aussi côté base : un administrateur
-- peut supprimer, rayer ou déplacer un message, mais pas réécrire ce qu'une autre personne a écrit.
-- La date de modification (« modifié ») est posée par la base. Le déplacement d'un message (migration 015) reste permis.

create or replace function public.guard_message_edit()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.channel_id is not distinct from old.channel_id
     and (new.body is distinct from old.body or new.tag_ids is distinct from old.tag_ids) then
    if auth.uid() is not null and auth.uid() <> old.user_id then
      raise exception 'Seul l''auteur peut modifier son message';
    end if;
    new.edited_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists messages_guard_edit on public.messages;
create trigger messages_guard_edit
  before update of body, tag_ids on public.messages
  for each row execute function public.guard_message_edit();
