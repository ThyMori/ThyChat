// Recadrage d'une photo de profil ou d'espace : on déplace et on zoome l'image sous un cadre carré, puis on valide.

import { $, openDialog, closeDialog } from "./dom.js";

export const OUTPUT_SIDE = 256; // taille (en pixels) de la photo envoyée
export const MAX_ZOOM = 4; // zoom maximum (4 fois l'image « remplie »)

export interface CropState {
  w: number; // largeur de l'image d'origine
  h: number; // hauteur de l'image d'origine
  zoom: number; // 1 = l'image remplit tout juste le cadre
  cx: number; // point de l'image (en pixels d'origine) placé au centre du cadre
  cy: number;
}

// Côté (en pixels de l'image d'origine) de la zone visible dans le cadre.
export const cropSide = (s: CropState): number => Math.min(s.w, s.h) / s.zoom;

// Ramène le centre pour que le cadre ne sorte jamais de l'image (pas de bord vide).
export function clampCrop(s: CropState): CropState {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, s.zoom));
  const half = Math.min(s.w, s.h) / zoom / 2;
  return { ...s, zoom, cx: Math.min(s.w - half, Math.max(half, s.cx)), cy: Math.min(s.h - half, Math.max(half, s.cy)) };
}

// Zone à copier de l'image d'origine : coin haut gauche + côté.
export function cropRect(s: CropState): { sx: number; sy: number; side: number } {
  const side = cropSide(s);
  return { sx: s.cx - side / 2, sy: s.cy - side / 2, side };
}

// Glisser de (dx, dy) pixels d'écran : l'image suit le doigt, donc le centre va dans l'autre sens.
export function panCrop(s: CropState, dx: number, dy: number, frame: number): CropState {
  const perPixel = cropSide(s) / frame; // pixels d'origine par pixel d'écran
  return clampCrop({ ...s, cx: s.cx - dx * perPixel, cy: s.cy - dy * perPixel });
}

// Ouvre la fenêtre de recadrage. Renvoie la photo carrée (JPEG) ou null si on annule.
export async function cropPhoto(file: Blob): Promise<Blob | null> {
  const bitmap = await createImageBitmap(file);
  const dialog = openDialog("#dialog-crop");
  const canvas = $<HTMLCanvasElement>("#crop-canvas");
  const zoomInput = $<HTMLInputElement>("#crop-zoom");
  const ctx = canvas.getContext("2d");
  let state: CropState = { w: bitmap.width, h: bitmap.height, zoom: 1, cx: bitmap.width / 2, cy: bitmap.height / 2 };
  zoomInput.value = "1";
  // Ferme la fenêtre ; sans dialog.close (vieux navigateur, jsdom), on déclenche nous-mêmes l'événement « close ».
  const shut = (): void => {
    closeDialog(dialog);
    if (!dialog.close) dialog.dispatchEvent(new (dialog.ownerDocument.defaultView?.Event ?? Event)("close"));
  };

  // Dessine la zone visible dans le canvas.
  const draw = (): void => {
    if (!ctx) return;
    const { sx, sy, side } = cropRect(state);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, canvas.width, canvas.height);
  };
  draw();

  // Taille du cadre à l'écran (le canvas est mis à l'échelle par le CSS).
  const frame = (): number => canvas.getBoundingClientRect().width || canvas.width;

  // Doigts / souris posés sur le cadre : un seul = déplacer, deux = pincer pour zoomer.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  const onDown = (e: PointerEvent): void => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture?.(e.pointerId);
    pinch = pointers.size === 2 ? distance() : 0;
  };
  const distance = (): number => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const onMove = (e: PointerEvent): void => {
    const last = pointers.get(e.pointerId);
    if (!last) return;
    const now = { x: e.clientX, y: e.clientY };
    if (pointers.size === 1) state = panCrop(state, now.x - last.x, now.y - last.y, frame());
    pointers.set(e.pointerId, now);
    if (pointers.size === 2 && pinch > 0) {
      const d = distance();
      state = clampCrop({ ...state, zoom: state.zoom * (d / pinch) });
      pinch = d;
      zoomInput.value = String(state.zoom);
    }
    draw();
  };
  const onUp = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    pinch = 0;
  };
  const onZoom = (): void => {
    state = clampCrop({ ...state, zoom: Number(zoomInput.value) });
    draw();
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    state = clampCrop({ ...state, zoom: state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1) });
    zoomInput.value = String(state.zoom);
    draw();
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  zoomInput.addEventListener("input", onZoom);

  return new Promise<Blob | null>((resolve) => {
    let result: Blob | null = null;
    const ok = $("#crop-ok");
    const cancel = $("#crop-cancel");
    // Valider : on redessine à la taille finale puis on convertit en JPEG.
    const onOk = (): void => {
      const out = document.createElement("canvas");
      out.width = out.height = OUTPUT_SIDE;
      const octx = out.getContext("2d");
      if (!octx) return shut();
      const { sx, sy, side } = cropRect(state);
      octx.drawImage(bitmap, sx, sy, side, side, 0, 0, OUTPUT_SIDE, OUTPUT_SIDE);
      out.toBlob((blob) => {
        result = blob;
        shut();
      }, "image/jpeg", 0.86);
    };
    const onCancel = (): void => shut();
    // À la fermeture (valider, annuler, « Retour », Échap) : on nettoie et on rend la main.
    const onClose = (): void => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      zoomInput.removeEventListener("input", onZoom);
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      dialog.removeEventListener("close", onClose);
      bitmap.close?.();
      resolve(result);
    };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    dialog.addEventListener("close", onClose);
  });
}
