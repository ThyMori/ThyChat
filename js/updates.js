// Mises à jour : vérifie qu'une nouvelle version existe (au retour sur l'application, en ligne, toutes les 30 minutes)
// et prévient quand le service worker de la nouvelle version a pris la main. Rien ne se recharge tout seul.

export function watchUpdates({ sw = typeof navigator !== "undefined" ? navigator.serviceWorker : null, onUpdate, intervalMs = 30 * 60 * 1000, doc = globalThis.document, win = globalThis.window } = {}) {
  if (!sw) return () => {};
  let hadController = Boolean(sw.controller);
  let registration = null;

  const check = () => {
    if (!registration) return;
    try {
      Promise.resolve(registration.update()).catch(() => {});
    } catch {
      /* hors ligne ou service worker indisponible : sans conséquence */
    }
  };
  const onChange = () => {
    if (!hadController) {
      hadController = true; // première installation : rien à recharger
      return;
    }
    onUpdate();
  };
  const onVisible = () => {
    if (doc.visibilityState === "visible") check();
  };

  sw.addEventListener("controllerchange", onChange);
  Promise.resolve(sw.ready).then((r) => {
    registration = r;
  }, () => {});
  doc.addEventListener("visibilitychange", onVisible);
  win.addEventListener("online", check);
  const timer = setInterval(onVisible, intervalMs);
  return () => {
    clearInterval(timer);
    sw.removeEventListener("controllerchange", onChange);
    doc.removeEventListener("visibilitychange", onVisible);
    win.removeEventListener("online", check);
  };
}
