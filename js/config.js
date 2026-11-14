// Configuration publique de ThyChat.
//
// Ces deux valeurs se trouvent dans Supabase : Project Settings > API.
//  - SUPABASE_URL      : l'URL du projet (https://xxxx.supabase.co)
//  - SUPABASE_ANON_KEY : la clé PUBLIQUE (« anon » ou « publishable »).
//
// ⚠️ Ne mets JAMAIS ici la clé « service_role » / « secret » : ce fichier est public.
// La clé publique est faite pour être exposée ; c'est le RLS (voir supabase/schema.sql)
// qui protège les données.

export const SUPABASE_URL = "https://ajhtjciomlnvynccjfbd.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_mSy4A6hatx-OLI96Y0bttQ_7S2zlONJ";

// Clé PUBLIQUE des notifications push (VAPID). La clé privée correspondante se dépose dans
// Supabase (Edge Functions > Secrets), jamais ici. Voir README, « Notifications push ».
export const VAPID_PUBLIC_KEY = "BN-FNRqHqNYPNQKSrajs8AzzuNQBH9XIRtxb8TczPX8EVD7OC8rDM8h7STz5T77DAgEikiD-_F-L0RaFWJhYO6M";
