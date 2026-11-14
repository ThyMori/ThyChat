// Documents PDF des dates de tournée : envoi, liens temporaires, suppression (stockage privé).

const BUCKET = "tag-documents";
export const MAX_PDF_BYTES = 15 * 1024 * 1024;

export const isPdf = (file) => file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name || ""));

export function sizeLabel(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " Ko";
  return (bytes / (1024 * 1024)).toFixed(1).replace(".", ",") + " Mo";
}

// Range le fichier dans <salon>/<date>/<identifiant>.pdf.
export async function uploadTagDocument(supabase, roomId, tagId, file) {
  const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
  const path = `${roomId}/${tagId}/${id}.pdf`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: "application/pdf",
    cacheControl: "3600",
  });
  if (error) throw error;
  return { path, name: String(file.name || "Document.pdf").slice(0, 160), size_bytes: file.size };
}

export async function removeTagDocuments(supabase, paths) {
  if (!paths.length) return;
  try {
    await supabase.storage.from(BUCKET).remove(paths);
  } catch {
    /* fichier orphelin : sans conséquence pour l'application */
  }
}

// Liens temporaires (1 h) pour ouvrir les PDF : chemin -> lien.
export async function signDocuments(supabase, paths) {
  const out = new Map();
  if (!paths.length) return out;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600);
  if (error) throw error;
  for (const row of data || []) if (row.signedUrl && row.path) out.set(row.path, row.signedUrl);
  return out;
}

// Fiche technique d'un spectacle : rangée dans <salon>/fiche/<identifiant>.pdf (même stockage privé).
export async function uploadRoomSheet(supabase, roomId, file) {
  const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
  const path = `${roomId}/fiche/${id}.pdf`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: "application/pdf",
    cacheControl: "3600",
  });
  if (error) throw error;
  return { path, name: String(file.name || "Fiche technique.pdf").slice(0, 160), size_bytes: file.size };
}
