// Texte des messages : initiales, mise en forme à la WhatsApp, liens sûrs, citations, pastilles de dates, recherche sans accents.
// Tout est inséré via textContent / createTextNode : jamais d'innerHTML avec du texte d'utilisateur.

import { el } from "./dom.js";

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

// Initiales pour les pastilles rondes (1 lettre pour un salon, jusqu'à 2 pour un espace).
export function initials(name: unknown, max = 1): string {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return words.slice(0, max).map((word) => Array.from(word)[0]).join("");
}

// Mise en forme à la WhatsApp : *gras*, _italique_, ~barré~ (le marqueur colle au texte et n'est pas au milieu d'un mot).
const FORMAT_RE = /(^|[^\p{L}\p{N}])([*_~])(?!\2)(?=\S)((?:(?!\2)[^\n])*?(?!\2)\S)\2(?![\p{L}\p{N}])/u;
const FORMAT_TAGS: Record<string, string> = { "*": "strong", _: "em", "~": "s" };

function renderInline(container: Node, text: string): void {
  let rest = text;
  while (rest) {
    const match = FORMAT_RE.exec(rest);
    if (!match) break;
    const before = rest.slice(0, match.index) + match[1];
    if (before) container.appendChild(document.createTextNode(before));
    const node = document.createElement(FORMAT_TAGS[match[2]]);
    renderInline(node, match[3]);
    container.appendChild(node);
    rest = rest.slice(match.index + match[0].length);
  }
  if (rest) container.appendChild(document.createTextNode(rest));
}

// Insère du texte brut en transformant les adresses http(s) en liens sûrs.
function renderBody(container: HTMLElement, text: string): void {
  text.split(URL_RE).forEach((part, index) => {
    if (index % 2 === 0) {
      if (part) renderInline(container, part);
      return;
    }
    const [, url, tail] = part.match(/^(.*?)([.,;:!?)\]]*)$/) as RegExpMatchArray;
    const link = el("a", "", url);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    container.append(link);
    if (tail) container.append(document.createTextNode(tail));
  });
}

// Date de tournée affichable en pastille dans le texte (#Date).
export interface HashTag {
  id: string;
  label: string;
  hue: number | string;
}

// Citation : les lignes de tête commençant par « > » s'affichent comme une citation.
export function renderMessageBody(container: HTMLElement, text: string, tags: HashTag[] = []): void {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].startsWith("> ")) {
    container.append(el("span", "quote-line", lines[i].slice(2)));
    i += 1;
  }
  const rest = lines.slice(i).join("\n").replace(/^\n+/, "");
  if (!rest) return;
  if (!tags.length) return renderBody(container, rest);
  // Les « #Date » choisies avec # s'affichent en pastille dans le texte.
  const byLabel = new Map(tags.map((tag) => [tag.label, tag]));
  const labels = [...byLabel.keys()].sort((a, b) => b.length - a.length).map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = rest.split(new RegExp(`#(${labels.join("|")})`));
  parts.forEach((part, index) => {
    if (index % 2 === 0) {
      if (part) renderBody(container, part);
      return;
    }
    const tag = byLabel.get(part) as HashTag;
    const pill = el("span", "hash-pill", "#" + part);
    pill.dataset.tag = tag.id;
    pill.style.setProperty("--h", String(tag.hue));
    container.append(pill);
  });
}

// Texte sans accents ni majuscules, pour la recherche.
export const plain = (text: unknown): string => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export const excerpt = (text: unknown, max = 90): string => {
  const flat = String(text || "").replace(/^(> .*\n?)+/, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};

export const PHOTO_LABEL = "📷 Photo";

export const messageExcerpt = (message: { body?: string | null; attachments?: unknown[] | null } | null | undefined, max = 90): string =>
  excerpt(message && message.body, max) || (message && message.attachments && message.attachments.length ? PHOTO_LABEL : "");
