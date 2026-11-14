// Thèmes de couleur : chaque espace (production, compagnie…) a sa couleur, qui teinte
// toute l'interface pour qu'on sache au premier coup d'œil dans quel espace on se trouve.
//
// La couleur est enregistrée dans workspaces.theme (clé de la palette ci-dessous), donc
// identique pour tous les membres. Sans valeur enregistrée, elle est déduite de l'id de l'espace.

export const PALETTE = [
  { key: "ambre", label: "Ambre", hue: 28 },
  { key: "cerise", label: "Cerise", hue: 350 },
  { key: "magenta", label: "Magenta", hue: 316 },
  { key: "violet", label: "Violet", hue: 274 },
  { key: "indigo", label: "Indigo", hue: 240 },
  { key: "bleu", label: "Bleu", hue: 206 },
  { key: "turquoise", label: "Turquoise", hue: 176 },
  { key: "vert", label: "Vert", hue: 145 },
  { key: "citron", label: "Citron vert", hue: 96 },
  { key: "moutarde", label: "Moutarde", hue: 52 },
];

export const DEFAULT_THEME = PALETTE[0];

// Hachage FNV-1a (32 bits, non signé) : stable d'un appareil à l'autre.
export function hashString(text) {
  let hash = 2166136261;
  for (const char of String(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

export function themeByKey(key) {
  return PALETTE.find((theme) => theme.key === key) || null;
}

// Thème d'un espace : celui enregistré, sinon déduit de son id.
export function themeFor(workspace) {
  const saved = themeByKey(workspace && workspace.theme);
  if (saved) return saved;
  return PALETTE[hashString((workspace && workspace.id) || "") % PALETTE.length];
}

// Thème proposé à la création : une couleur pas encore utilisée par les autres espaces.
export function pickUnusedTheme(usedKeys, seed = "") {
  const free = PALETTE.filter((theme) => !usedKeys.includes(theme.key));
  const pool = free.length ? free : PALETTE;
  return pool[hashString(seed) % pool.length];
}

// Couleur du nom d'un auteur dans les bulles (stable pour une même personne).
export function authorHue(userId) {
  return PALETTE[hashString(userId || "") % PALETTE.length].hue;
}
