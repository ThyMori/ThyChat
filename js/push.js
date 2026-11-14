// Notifications push : abonnement de cet appareil et pastille sur l'icône de l'application.
// L'envoi proprement dit est fait par la fonction Supabase « send-push » (voir README).

import { VAPID_PUBLIC_KEY } from "./config.js";

export const pushSupported = () =>
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  typeof window !== "undefined" &&
  "PushManager" in window &&
  "Notification" in window;

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandaloneNow = () =>
  (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;

function keyToBytes(base64) {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function toBase64Url(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.getRegistration();
  return registration ? registration.pushManager.getSubscription() : null;
}

// unsupported | needs-install (iPhone : il faut d'abord installer l'application) | unconfigured |
// denied | off | on
export async function pushStatus() {
  if (!pushSupported()) return isIos() && !isStandaloneNow() ? "needs-install" : "unsupported";
  if (isIos() && !isStandaloneNow()) return "needs-install";
  if (!VAPID_PUBLIC_KEY) return "unconfigured";
  if (Notification.permission === "denied") return "denied";
  try {
    const subscription = await currentSubscription();
    return subscription && Notification.permission === "granted" ? "on" : "off";
  } catch {
    return "off";
  }
}

export async function enablePush(supabase) {
  const status = await pushStatus();
  if (status !== "off" && status !== "on") throw new Error(status);

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("denied");

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyToBytes(VAPID_PUBLIC_KEY),
    });
  }
  const { error } = await supabase.rpc("save_push_subscription", {
    p_endpoint: subscription.endpoint,
    p_p256dh: toBase64Url(subscription.getKey("p256dh")),
    p_auth: toBase64Url(subscription.getKey("auth")),
    p_user_agent: navigator.userAgent.slice(0, 200),
  });
  if (error) throw error;
}

export async function disablePush(supabase) {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await supabase.rpc("remove_push_subscription", { p_endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}

// Si cet appareil est déjà autorisé, rattache l'abonnement au compte connecté (changement de compte).
export async function syncPush(supabase) {
  try {
    if ((await pushStatus()) !== "on") return;
    const subscription = await currentSubscription();
    await supabase.rpc("save_push_subscription", {
      p_endpoint: subscription.endpoint,
      p_p256dh: toBase64Url(subscription.getKey("p256dh")),
      p_auth: toBase64Url(subscription.getKey("auth")),
      p_user_agent: navigator.userAgent.slice(0, 200),
    });
  } catch {
    /* sans conséquence : l'abonnement sera resynchronisé à la prochaine ouverture */
  }
}

// Pastille sur l'icône de l'application installée (si le navigateur la gère).
export function setBadge(count) {
  try {
    if (count > 0 && navigator.setAppBadge) navigator.setAppBadge(count);
    else if (navigator.clearAppBadge) navigator.clearAppBadge();
  } catch {
    /* badge non pris en charge */
  }
}
