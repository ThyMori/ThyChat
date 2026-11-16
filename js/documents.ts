// Documents des dates de tournée et fiches techniques : PDF, images ou liens web (envoi, liens temporaires, suppression ; stockage privé).

import type { Db } from "./types.js";

const BUCKET = "tag-documents";
export const MAX_PDF_BYTES = 15 * 1024 * 1024;

// Fichier minimal : un File du navigateur ou un objet de même forme.
interface FileLike { type?: string; name?: string; size?: number }

export const isPdf = (file: FileLike | null | undefined): boolean => !!file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name || ""));

const TYPES = [
  { mime: "application/pdf", ext: "pdf", re: /\.pdf$/i },
  { mime: "image/jpeg", ext: "jpg", re: /\.jpe?g$/i },
  { mime: "image/png", ext: "png", re: /\.png$/i },
  { mime: "image/webp", ext: "webp", re: /\.webp$/i },
  { mime: "image/gif", ext: "gif", re: /\.gif$/i },
];
export const FILE_ACCEPT = "application/pdf,image/jpeg,image/png,image/webp,image/gif,.pdf,.jpg,.jpeg,.png,.webp,.gif";

// Type accepté (PDF ou image) d'un fichier, ou null.
export function fileType(file: FileLike | null | undefined) {
  if (!file) return null;
  return TYPES.find((t) => t.mime === file.type) || TYPES.find((t) => t.re.test(file.name || "")) || null;
}

// Lien web valable (http ou https) : renvoie l'adresse nettoyée, ou "" si elle est refusée.
export function cleanUrl(text: unknown): string {
  let value = String(text || "").trim();
  if (value && !/^[a-z][a-z0-9+.-]*:/i.test(value)) value = "https://" + value;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".") || /\s/.test(value) || value.length > 2000) return "";
    return url.href;
  } catch {
    return "";
  }
}

export function sizeLabel(bytes: number | null | undefined): string {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " Ko";
  return (bytes / (1024 * 1024)).toFixed(1).replace(".", ",") + " Mo";
}

// Range le fichier dans <salon>/<date>/<identifiant>.pdf.
export async function uploadTagDocument(supabase: Db, roomId: string, tagId: string, file: File) {
  const type = fileType(file) || TYPES[0];
  const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
  const path = `${roomId}/${tagId}/${id}.${type.ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: type.mime,
    cacheControl: "3600",
  });
  if (error) throw error;
  return { path, name: String(file.name || "Document.pdf").slice(0, 160), size_bytes: file.size };
}

export async function removeTagDocuments(supabase: Db, allPaths: (string | null | undefined)[] | null | undefined): Promise<void> {
  const paths = (allPaths || []).filter(Boolean) as string[]; // les liens web n'ont pas de fichier
  if (!paths.length) return;
  try {
    await supabase.storage.from(BUCKET).remove(paths);
  } catch {
    /* fichier orphelin : sans conséquence pour l'application */
  }
}

// Liens temporaires (1 h) pour ouvrir les PDF : chemin -> lien.
export async function signDocuments(supabase: Db, input: (string | null | undefined)[] | null | undefined): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const paths = (input || []).filter(Boolean) as string[];
  if (!paths.length) return out;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600);
  if (error) throw error;
  for (const row of data || []) if (row.signedUrl && row.path) out.set(row.path, row.signedUrl);
  return out;
}

// Fiche technique d'un spectacle : rangée dans <salon>/fiche/<identifiant>.pdf (même stockage privé).
export async function uploadRoomSheet(supabase: Db, roomId: string, file: File) {
  const type = fileType(file) || TYPES[0];
  const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
  const path = `${roomId}/fiche/${id}.${type.ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: type.mime,
    cacheControl: "3600",
  });
  if (error) throw error;
  return { path, name: String(file.name || "Fiche technique.pdf").slice(0, 160), size_bytes: file.size };
}
