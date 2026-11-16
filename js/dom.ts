// Petits outils d'interface : sélection d'éléments, boîtes de dialogue, historique du bouton « Retour », icônes, pastilles de couleur.

import { PALETTE } from "./themes.js";

export const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector(selector) as T;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const ACTION_ICONS: Record<string, string> = {
  reply: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v3"/>',
  quote: '<path d="M10 7C6 8 4 10 4 14v3h6v-6H7c0-2 1-3 3-4z"/><path d="M20 7c-4 1-6 3-6 7v3h6v-6h-3c0-2 1-3 3-4z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  forward: '<path d="m15 5 5 5-5 5"/><path d="M20 10H9a5 5 0 0 0-5 5v4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  strike: '<path d="M5 12h14"/><path d="M16 7.5C15 6 13.7 5.5 12 5.5c-2.2 0-4 1-4 3 0 4 8 2.5 8 7 0 2-1.8 3.5-4 3.5-1.9 0-3.4-.7-4.4-2"/>',
  unstrike: '<path d="M9 14 4 9l5-5"/><path d="M4 9h9a6 6 0 0 1 0 12h-3"/>',
  move: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 13h6m-2-2 2 2-2 2"/>',
  pin: '<path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 15v5"/>',
  unpin: '<path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 15v5M4 4l16 16"/>',
  delete: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
};
export function actionIcon(name: string): HTMLElement {
  const holder = document.createElement("span");
  holder.className = "act-ic";
  holder.innerHTML = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ACTION_ICONS[name] || ""}</svg>`;
  return holder;
}

// Bouton « Retour » du téléphone : sur mobile, on garde une entrée d'historique devant soi pour que « Retour »
// ferme la boîte de dialogue ou revienne à la liste des salons, au lieu de quitter l'application.
export const isMobile = (): boolean => Boolean(window.matchMedia && window.matchMedia("(max-width: 760px)").matches);

// Chrome ignore (au bouton « Retour ») les entrées d'historique ajoutées sans geste de l'utilisateur : la protection
// posée au démarrage pouvait être sautée et « Retour » quittait l'application (écran noir). On note donc si l'entrée
// a été posée pendant un geste, et on en repose une dès qu'un geste le permet.
export function guardHistory(): void {
  try {
    if (!isMobile()) return;
    const active = !navigator.userActivation || navigator.userActivation.isActive;
    const current = history.state;
    if (!(current && current.tcGuard) || (!current.act && active)) history.pushState({ tcGuard: true, act: active }, "");
  } catch {
    /* historique indisponible : sans conséquence */
  }
}

export function openDialog(selector: string): HTMLDialogElement {
  guardHistory();
  const dialog = $<HTMLDialogElement>(selector);
  if (dialog.showModal) dialog.showModal();
  else dialog.setAttribute("open", "");
  return dialog;
}

export function closeDialog(dialog: HTMLDialogElement): void {
  if (dialog.close) dialog.close();
  else dialog.removeAttribute("open");
}

export function setNotice(selector: string, text: string | null | undefined, kind = "error"): void {
  const node = $(selector);
  node.textContent = text || "";
  node.dataset.kind = kind;
  node.hidden = !text;
}

// Pastilles de couleur cliquables (création d'espace, réglages).
export function renderSwatches(container: HTMLElement, selectedKey: string | null | undefined, onPick: (key: string) => void): void {
  container.replaceChildren();
  for (const theme of PALETTE) {
    const button = el("button", "swatch");
    button.type = "button";
    button.title = theme.label;
    button.setAttribute("aria-label", theme.label);
    button.setAttribute("aria-pressed", String(theme.key === selectedKey));
    button.dataset.key = theme.key;
    button.style.setProperty("--sw", String(theme.hue));
    button.addEventListener("click", () => onPick(theme.key));
    container.append(button);
  }
}
