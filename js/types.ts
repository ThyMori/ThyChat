// Types partagés (effacés à la construction : ce fichier ne produit aucun code).

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
