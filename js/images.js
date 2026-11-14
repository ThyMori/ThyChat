// Photos dans les messages : réduction avant envoi, envoi dans le stockage privé, liens temporaires.

const MAX_SIDE = 1600;
export const MAX_IMAGES = 4;
const BUCKET = "message-images";
const SIGN_SECONDS = 24 * 60 * 60;

// Réduit l'image (côté le plus long : 1600 px) et la convertit en JPEG.
export async function resizedJpeg(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // fond blanc pour les images transparentes
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Image illisible"))), "image/jpeg", 0.85)
  );
  return { blob, width, height };
}

export async function uploadMessageImage(supabase, channelId, image) {
  const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
  const path = `${channelId}/${id}.jpg`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, image.blob, {
    contentType: "image/jpeg",
    cacheControl: "3600",
  });
  if (error) throw error;
  return { path, w: image.width, h: image.height };
}

export async function removeMessageImages(supabase, paths) {
  if (!paths.length) return;
  try {
    await supabase.storage.from(BUCKET).remove(paths);
  } catch {
    /* fichier orphelin : sans conséquence pour la conversation */
  }
}

// Liens temporaires (24 h) pour afficher les images d'un stockage privé.
export async function signPaths(supabase, paths) {
  const out = new Map();
  if (!paths.length) return out;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, SIGN_SECONDS);
  if (error) return out;
  for (const row of data || []) if (row.signedUrl && row.path) out.set(row.path, row.signedUrl);
  return out;
}

// Retire toutes les photos rangées pour un sous-salon (suppression d'une discussion privée).
export async function removeChannelImages(supabase, channelId) {
  try {
    const { data } = await supabase.storage.from(BUCKET).list(channelId, { limit: 1000 });
    const paths = (data || []).filter((f) => f.name).map((f) => `${channelId}/${f.name}`);
    await removeMessageImages(supabase, paths);
  } catch {
    /* sans conséquence : la discussion est supprimée quand même */
  }
}
