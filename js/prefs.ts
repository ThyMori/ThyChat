// Préférences gardées sur l'appareil (dernier écran, dossiers dépliés, messages privés repliés).

const LAST_KEY = "thychat:last";
const OPEN_KEY = "thychat:open";
const DM_OPEN_KEY = "thychat:dm-open";

export const readDmOpen = (): boolean => {
  try {
    return localStorage.getItem(DM_OPEN_KEY) === "1"; // repliés par défaut
  } catch {
    return false;
  }
};

// Dernier écran ouvert : { channel, chans: { [espace]: sous-salon }, … } (forme libre, relue au démarrage).
export type LastState = Record<string, any>;

export function readLast(): LastState {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) as string) || {};
  } catch {
    return {};
  }
}

export function readOpen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) as string) || []);
  } catch {
    return new Set();
  }
}

export function writeOpen(set: Set<string>): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...set]));
  } catch {
    /* stockage indisponible : sans conséquence */
  }
}

export function writeLast(patch: LastState): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ ...readLast(), ...patch }));
  } catch {
    /* stockage indisponible : sans conséquence */
  }
}
