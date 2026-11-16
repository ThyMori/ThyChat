// Types partagés (effacés à la construction : ce fichier ne produit aucun code).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types.js";

// Client Supabase typé avec les tables et fonctions de la base (voir js/database.types.ts).
export type Db = SupabaseClient<Database>;

// Ligne de la table notification_mutes.
export interface MuteRow {
  scope?: "workspace" | "room" | "channel";
  target_id?: string;
  muted_until: string | null;
  forever: boolean;
}

export type MuteScope = "workspace" | "room" | "channel";
export type MuteChoice = "off" | "8h" | "week" | "forever";

// Champs d'un sous-salon utiles aux silences.
export interface MuteChannel {
  id: string;
  room_id?: string | null;
  workspace_id: string;
  kind: string;
}

export interface Workspace {
  id: string;
  name?: string;
  theme?: string | null;
}

export interface Theme {
  key: string;
  label: string;
  hue: number;
}

// Pièce jointe photo d'un message : chemin dans le stockage + taille.
export interface Attachment {
  path: string;
  w?: number;
  h?: number;
}

// Photo préparée avant envoi.
export interface PendingImage {
  blob: Blob;
  width: number;
  height: number;
}
