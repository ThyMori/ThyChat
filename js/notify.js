// Silences (espace ou salon) : fonctions pures, sans accès au réseau ni au DOM.
//
// Une ligne de la table notification_mutes : { scope: "workspace"|"room"|"channel", target_id, muted_until, forever }.

export const MUTE_CHOICES = [
  { key: "off", label: "Notifications activées" },
  { key: "8h", label: "Silence pendant 8 heures" },
  { key: "week", label: "Silence pendant 1 semaine" },
  { key: "forever", label: "Désactivées (toujours)" },
];

const HOUR = 3600 * 1000;

// Convertit un choix en champs à enregistrer (null = réactiver).
export function muteFromChoice(choice, now = Date.now()) {
  if (choice === "8h") return { muted_until: new Date(now + 8 * HOUR).toISOString(), forever: false };
  if (choice === "week") return { muted_until: new Date(now + 7 * 24 * HOUR).toISOString(), forever: false };
  if (choice === "forever") return { muted_until: null, forever: true };
  return null;
}

export function isActive(row, now = Date.now()) {
  if (!row) return false;
  if (row.forever) return true;
  return Boolean(row.muted_until) && new Date(row.muted_until).getTime() > now;
}

// Les silences sont indexés par « scope:target_id ».
export const muteKey = (scope, id) => `${scope}:${id}`;

export function isMuted(mutes, scope, id, now = Date.now()) {
  return isActive(mutes.get(muteKey(scope, id)), now);
}

// Un sous-salon est silencieux s'il l'est lui-même, ou si son salon (spectacle) ou son espace l'est.
export function channelMuted(mutes, channel, now = Date.now()) {
  return (
    isMuted(mutes, "channel", channel.id, now) ||
    (channel.room_id ? isMuted(mutes, "room", channel.room_id, now) : false) ||
    isMuted(mutes, "workspace", channel.workspace_id, now)
  );
}

// Choix actuellement appliqué à une ligne (pour pré-sélectionner la liste).
export function choiceOf(row, now = Date.now()) {
  if (!isActive(row, now)) return "off";
  if (row.forever) return "forever";
  const remaining = new Date(row.muted_until).getTime() - now;
  return remaining > 24 * HOUR ? "week" : "8h";
}

const dayFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short" });
const hourFmt = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

// « Silence jusqu'à 18:30 », « Silence jusqu'à lun. 23 nov. », « Désactivées ».
export function muteLabel(row, now = Date.now()) {
  if (!isActive(row, now)) return "";
  if (row.forever) return "Désactivées";
  const until = new Date(row.muted_until);
  const sameDay = until.toDateString() === new Date(now).toDateString();
  return sameDay ? `Silence jusqu'à ${hourFmt.format(until)}` : `Silence jusqu'à ${dayFmt.format(until)}`;
}

// Total pour la pastille de l'icône : non lus des salons qui ne sont pas silencieux.
export function badgeTotal(unread, channels, mutes, now = Date.now()) {
  let total = 0;
  for (const channel of channels) {
    const count = unread.get(channel.id) || 0;
    if (count > 0 && !channelMuted(mutes, channel, now)) total += count;
  }
  return total;
}

export const countLabel = (n) => (n > 99 ? "99+" : String(n));
