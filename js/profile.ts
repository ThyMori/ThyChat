// Profil : photo, nom affiché, adresse e-mail.

import type { Db } from "./types.js";

const MAX_SIDE = 256;

// Réduit et recadre la photo en carré (JPEG) avant l'envoi.
export async function squareJpeg(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.min(side, MAX_SIDE);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image illisible");
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Image illisible"))), "image/jpeg", 0.86)
  );
}

// N'affiche que des photos hébergées dans notre stockage Supabase.
export function safeAvatarUrl(url: unknown): string {
  return typeof url === "string" && /^https:\/\/[^/]+\/storage\/v1\/object\/public\/avatars\//.test(url) ? url : "";
}

export async function uploadAvatar(supabase: Db, userId: string, file: Blob): Promise<string> {
  const blob = await squareJpeg(file);
  const path = `${userId}/avatar.jpg`;
  const { error } = await supabase.storage.from("avatars").upload(path, blob, {
    upsert: true,
    contentType: "image/jpeg",
    cacheControl: "3600",
  });
  if (error) throw error;
  const { data } = supabase.storage.from("avatars").getPublicUrl(path);
  const url = `${data.publicUrl}?v=${Date.now()}`; // contourne le cache après un changement de photo
  const { error: updateError } = await supabase.from("profiles").update({ avatar_url: url }).eq("id", userId);
  if (updateError) throw updateError;
  return url;
}

// Photo d'un espace (production ou compagnie) : réservée à ses administrateurs.
export async function uploadWorkspaceAvatar(supabase: Db, workspaceId: string, file: Blob): Promise<string> {
  const blob = await squareJpeg(file);
  const path = `ws/${workspaceId}/logo.jpg`;
  const { error } = await supabase.storage.from("avatars").upload(path, blob, {
    upsert: true,
    contentType: "image/jpeg",
    cacheControl: "3600",
  });
  if (error) throw error;
  const { data } = supabase.storage.from("avatars").getPublicUrl(path);
  const url = `${data.publicUrl}?v=${Date.now()}`;
  const { error: updateError } = await supabase.from("workspaces").update({ avatar_url: url }).eq("id", workspaceId);
  if (updateError) throw updateError;
  return url;
}

export async function removeWorkspaceAvatar(supabase: Db, workspaceId: string): Promise<void> {
  await supabase.storage.from("avatars").remove([`ws/${workspaceId}/logo.jpg`]);
  const { error } = await supabase.from("workspaces").update({ avatar_url: null }).eq("id", workspaceId);
  if (error) throw error;
}

export async function removeAvatar(supabase: Db, userId: string): Promise<void> {
  await supabase.storage.from("avatars").remove([`${userId}/avatar.jpg`]);
  const { error } = await supabase.from("profiles").update({ avatar_url: null }).eq("id", userId);
  if (error) throw error;
}

export async function saveName(supabase: Db, userId: string, name: string): Promise<void> {
  const { error } = await supabase.from("profiles").update({ display_name: name }).eq("id", userId);
  if (error) throw error;
  await supabase.auth.updateUser({ data: { display_name: name } });
}

export async function changeEmail(supabase: Db, email: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ email }, { emailRedirectTo: location.origin + location.pathname });
  if (error) throw error;
}
