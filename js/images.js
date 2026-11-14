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

// Déplace réellement des photos vers le dossier d'un autre sous-salon (administrateurs).
// Renvoie { moved: [[ancien, nouveau], …] } ; en cas d'échec, remet en place ce qui avait été déplacé et lève l'erreur.
export async function moveMessageImages(supabase, paths, targetChannelId) {
  const moved = [];
  try {
    for (const from of paths) {
      const to = `${targetChannelId}/${from.slice(from.indexOf("/") + 1)}`;
      const { error } = await supabase.storage.from(BUCKET).move(from, to);
      if (error) throw error;
      moved.push([from, to]);
    }
  } catch (error) {
    await moveBack(supabase, moved);
    throw error;
  }
  return moved;
}

export async function moveBack(supabase, moved) {
  for (const [from, to] of moved) {
    try {
      await supabase.storage.from(BUCKET).move(to, from);
    } catch {
      /* à la main : le fichier reste dans le dossier d'arrivée */
    }
  }
}

// Copie des photos dans le dossier d'un autre sous-salon (transfert d'un message) : renvoie les nouvelles pièces jointes.
export async function copyMessageImages(supabase, attachments, targetChannelId) {
  const copied = [];
  try {
    for (const item of attachments) {
      const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
      const to = `${targetChannelId}/${id}.jpg`;
      const { error } = await supabase.storage.from(BUCKET).copy(item.path, to);
      if (error) throw error;
      copied.push({ path: to, w: item.w, h: item.h });
    }
  } catch (error) {
    await removeMessageImages(supabase, copied.map((c) => c.path));
    throw error;
  }
  return copied;
}
