// Silences (espace ou salon) : fonctions pures, sans accès au réseau ni au DOM.
//
// Une ligne de la table notification_mutes : { scope: "workspace"|"room"|"channel", target_id, muted_until, forever }.

export const MUTE_CHOICES: { key: MuteChoice; label: string }[] = [
  { key: "off", label: "Notifications activées" },
  { key: "8h", label: "Silence pendant 8 heures" },
  { key: "week", label: "Silence pendant 1 semaine" },
  { key: "forever", label: "Désactivées (toujours)" },
];

import type { MuteRow, MuteScope, MuteChoice, MuteChannel } from "./types.js";

const HOUR = 3600 * 1000;

// Convertit un choix en champs à enregistrer (null = réactiver).
export function muteFromChoice(choice: string, now = Date.now()): { muted_until: string | null; forever: boolean } | null {
  if (choice === "8h") return { muted_until: new Date(now + 8 * HOUR).toISOString(), forever: false };
  if (choice === "week") return { muted_until: new Date(now + 7 * 24 * HOUR).toISOString(), forever: false };
  if (choice === "forever") return { muted_until: null, forever: true };
  return null;
}

export function isActive(row: MuteRow | null | undefined, now = Date.now()): boolean {
  if (!row) return false;
  if (row.forever) return true;
  return Boolean(row.muted_until) && new Date(row.muted_until as string).getTime() > now;
}

// Les silences sont indexés par « scope:target_id ».
export const muteKey = (scope: MuteScope, id: string): string => `${scope}:${id}`;

export function isMuted(mutes: Map<string, MuteRow>, scope: MuteScope, id: string, now = Date.now()): boolean {
  return isActive(mutes.get(muteKey(scope, id)), now);
}

// Un sous-salon est silencieux s'il l'est lui-même, ou si son salon (spectacle) ou son espace l'est.
export function channelMuted(mutes: Map<string, MuteRow>, channel: MuteChannel, now = Date.now()): boolean {
  return (
    isMuted(mutes, "channel", channel.id, now) ||
    (channel.room_id ? isMuted(mutes, "room", channel.room_id, now) : false) ||
    (channel.kind !== "dm" && isMuted(mutes, "workspace", channel.workspace_id, now))
  );
}

// Choix actuellement appliqué à une ligne (pour pré-sélectionner la liste).
export function choiceOf(row: MuteRow | null | undefined, now = Date.now()): MuteChoice {
  if (!row || !isActive(row, now)) return "off";
  if (row.forever) return "forever";
  const remaining = new Date(row.muted_until as string).getTime() - now;
  return remaining > 24 * HOUR ? "week" : "8h";
}

const dayFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short" });
const hourFmt = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

// « Silence jusqu'à 18:30 », « Silence jusqu'à lun. 23 nov. », « Désactivées ».
export function muteLabel(row: MuteRow | null | undefined, now = Date.now()): string {
  if (!row || !isActive(row, now)) return "";
  if (row.forever) return "Désactivées";
  const until = new Date(row.muted_until as string);
  const sameDay = until.toDateString() === new Date(now).toDateString();
  return sameDay ? `Silence jusqu'à ${hourFmt.format(until)}` : `Silence jusqu'à ${dayFmt.format(until)}`;
}

// Total pour la pastille de l'icône : non lus des salons qui ne sont pas silencieux.
export function badgeTotal(unread: Map<string, number>, channels: MuteChannel[], mutes: Map<string, MuteRow>, now = Date.now()): number {
  let total = 0;
  for (const channel of channels) {
    const count = unread.get(channel.id) || 0;
    if (count > 0 && !channelMuted(mutes, channel, now)) total += count;
  }
  return total;
}

export const countLabel = (n: number): string => (n > 99 ? "99+" : String(n));
