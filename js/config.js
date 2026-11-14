// Configuration publique de ThyChat.
//
// Ces deux valeurs se trouvent dans Supabase : Project Settings > API.
//  - SUPABASE_URL      : l'URL du projet (https://xxxx.supabase.co)
//  - SUPABASE_ANON_KEY : la clé PUBLIQUE (« anon » ou « publishable »).
//
// ⚠️ Ne mets JAMAIS ici la clé « service_role » / « secret » : ce fichier est public.
// La clé publique est faite pour être exposée ; c'est le RLS (voir supabase/schema.sql)
// qui protège les données.

export const SUPABASE_URL = "";
export const SUPABASE_ANON_KEY = "";
