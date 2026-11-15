// Note manuscrite : page blanc cassé où l'on dessine au doigt, au stylet ou à la souris.
// Les traits restent des vecteurs dans l'éditeur (zoom net, annuler, gomme) ; à l'envoi la page est
// exportée en image PNG recadrée sur le dessin.

const PAPER = "#f6f1e4";
const COLORS = ["#1b1b1f", "#1f4fd8", "#c62828", "#2e7d32"];
const WIDTHS = [2, 4, 9];
const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const MAX_SIDE = 2000;

// Distance d'un point à un segment, pour la gomme.
function distToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  let t = len ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function drawStroke(ctx, s) {
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.w;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const pts = s.pts;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0], pts[0][1], s.w / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
  ctx.stroke();
}

// Branche la boîte de dialogue #dialog-ink. onDone(file) reçoit l'image PNG à joindre.
export function setupInk({ dialog, onDone, toast }) {
  const $ = (sel) => dialog.querySelector(sel);
  const canvas = $("#ink-canvas");
  let ctx = null;
  const state = {
    strokes: [],
    redo: [],
    color: COLORS[0],
    width: WIDTHS[1],
    eraser: false,
    scale: 1,
    tx: 0,
    ty: 0,
    pointers: new Map(),
    current: null,
    gesture: null,
    penSeen: false,
    dpr: 1,
  };

  const toWorld = (x, y) => [(x - state.tx) / state.scale, (y - state.ty) / state.scale];

  function resize() {
    ctx = canvas.getContext("2d");
    if (!ctx) return;
    const r = canvas.getBoundingClientRect();
    state.dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(r.width * state.dpr));
    canvas.height = Math.max(1, Math.round(r.height * state.dpr));
    redraw();
  }

  function redraw() {
    if (!ctx) return updateButtons();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Lignes très légères pour donner l'impression d'une page, qui suivent le zoom.
    ctx.setTransform(state.dpr * state.scale, 0, 0, state.dpr * state.scale, state.dpr * state.tx, state.dpr * state.ty);
    for (const s of state.strokes) drawStroke(ctx, s);
    if (state.current && !state.current.eraser) drawStroke(ctx, state.current);
    updateButtons();
  }

  function updateButtons() {
    $("#ink-undo").disabled = !state.strokes.length;
    $("#ink-redo").disabled = !state.redo.length;
    $("#ink-clear").disabled = !state.strokes.length;
    $("#ink-send").disabled = !state.strokes.length;
    $("#ink-eraser").setAttribute("aria-pressed", String(state.eraser));
    for (const b of dialog.querySelectorAll("[data-ink-color]")) b.setAttribute("aria-pressed", String(!state.eraser && b.dataset.inkColor === state.color));
    for (const b of dialog.querySelectorAll("[data-ink-width]")) b.setAttribute("aria-pressed", String(Number(b.dataset.inkWidth) === state.width));
  }

  function eraseAt(wx, wy) {
    const radius = 10 / state.scale;
    const before = state.strokes.length;
    state.strokes = state.strokes.filter((s) => {
      const reach = radius + s.w / 2;
      if (s.pts.length === 1) return Math.hypot(s.pts[0][0] - wx, s.pts[0][1] - wy) > reach;
      for (let i = 1; i < s.pts.length; i++) if (distToSegment([wx, wy], s.pts[i - 1], s.pts[i]) <= reach) return false;
      return true;
    });
    if (state.strokes.length !== before) state.redo = [];
  }

  function localXY(event) {
    const r = canvas.getBoundingClientRect();
    return [event.clientX - r.left, event.clientY - r.top];
  }

  function startGesture() {
    const pts = [...state.pointers.values()];
    if (pts.length < 2) return (state.gesture = null);
    const [a, b] = pts;
    state.gesture = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      scale: state.scale,
      tx: state.tx,
      ty: state.ty,
    };
  }

  function updateGesture() {
    const g = state.gesture;
    const pts = [...state.pointers.values()];
    if (!g || pts.length < 2) return;
    const [a, b] = pts;
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, g.scale * (dist / g.dist)));
    // Le point du dessin sous le milieu des doigts reste sous le milieu des doigts.
    const wx = (g.cx - g.tx) / g.scale;
    const wy = (g.cy - g.ty) / g.scale;
    state.scale = scale;
    state.tx = cx - wx * scale;
    state.ty = cy - wy * scale;
    redraw();
  }

  function zoomAt(x, y, factor) {
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, state.scale * factor));
    const wx = (x - state.tx) / state.scale;
    const wy = (y - state.ty) / state.scale;
    state.scale = scale;
    state.tx = x - wx * scale;
    state.ty = y - wy * scale;
    redraw();
  }

  function canDraw(event) {
    if (event.pointerType === "pen") return true;
    if (event.pointerType === "mouse") return event.button === 0;
    return !state.penSeen; // une fois le stylet utilisé, le doigt ne fait que déplacer la page
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "pen") state.penSeen = true;
    const [x, y] = localXY(event);
    canvas.setPointerCapture?.(event.pointerId);
    state.pointers.set(event.pointerId, { x, y, type: event.pointerType });
    if (state.pointers.size >= 2) {
      // Deuxième doigt : on annule le trait commencé et on passe en déplacement / zoom.
      state.current = null;
      startGesture();
      redraw();
      return;
    }
    if (event.pointerType === "mouse" && event.button === 1) {
      state.gesture = { pan: true, x, y, tx: state.tx, ty: state.ty };
      return;
    }
    if (!canDraw(event)) {
      state.gesture = { pan: true, x, y, tx: state.tx, ty: state.ty };
      return;
    }
    const [wx, wy] = toWorld(x, y);
    if (state.eraser) {
      eraseAt(wx, wy);
      state.current = { eraser: true, pts: [] };
      redraw();
    } else {
      state.current = { color: state.color, w: state.width, pts: [[wx, wy]] };
      redraw();
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    const p = state.pointers.get(event.pointerId);
    if (!p) return;
    const [x, y] = localXY(event);
    p.x = x;
    p.y = y;
    if (state.pointers.size >= 2) return updateGesture();
    if (state.gesture?.pan) {
      state.tx = state.gesture.tx + (x - state.gesture.x);
      state.ty = state.gesture.ty + (y - state.gesture.y);
      return redraw();
    }
    if (!state.current) return;
    const [wx, wy] = toWorld(x, y);
    if (state.current.eraser) {
      eraseAt(wx, wy);
      return redraw();
    }
    const last = state.current.pts[state.current.pts.length - 1];
    if (Math.hypot(wx - last[0], wy - last[1]) * state.scale < 1.2) return;
    state.current.pts.push([wx, wy]);
    redraw();
  });

  function end(event) {
    if (!state.pointers.has(event.pointerId)) return;
    state.pointers.delete(event.pointerId);
    if (state.current && !state.pointers.size) {
      if (!state.current.eraser) {
        state.strokes.push(state.current);
        state.redo = [];
      }
      state.current = null;
    }
    if (state.pointers.size < 2) state.gesture = null;
    if (state.pointers.size === 1) {
      // Il reste un doigt après un geste à deux doigts : on déplace la page avec lui.
      const [p] = [...state.pointers.values()];
      state.gesture = { pan: true, x: p.x, y: p.y, tx: state.tx, ty: state.ty };
      state.current = null;
    }
    redraw();
  }
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const [x, y] = localXY(event);
    if (event.ctrlKey || event.metaKey) zoomAt(x, y, Math.exp(-event.deltaY * 0.01));
    else zoomAt(x, y, Math.exp(-event.deltaY * 0.002));
  }, { passive: false });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  function fit() {
    const r = canvas.getBoundingClientRect();
    if (!state.strokes.length) {
      state.scale = 1;
      state.tx = 0;
      state.ty = 0;
      return redraw();
    }
    const b = bounds();
    const pad = 40;
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min((r.width - 2 * pad) / (b.w || 1), (r.height - 2 * pad) / (b.h || 1))));
    state.scale = scale;
    state.tx = (r.width - b.w * scale) / 2 - b.x * scale;
    state.ty = (r.height - b.h * scale) / 2 - b.y * scale;
    redraw();
  }

  function bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of state.strokes) {
      for (const p of s.pts) {
        x0 = Math.min(x0, p[0] - s.w / 2);
        y0 = Math.min(y0, p[1] - s.w / 2);
        x1 = Math.max(x1, p[0] + s.w / 2);
        y1 = Math.max(y1, p[1] + s.w / 2);
      }
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  async function exportPng() {
    const b = bounds();
    const margin = 24;
    const wx = b.x - margin;
    const wy = b.y - margin;
    const ww = b.w + 2 * margin;
    const wh = b.h + 2 * margin;
    const k = Math.min(2, MAX_SIDE / Math.max(ww, wh));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(ww * k));
    out.height = Math.max(1, Math.round(wh * k));
    const c = out.getContext("2d");
    c.fillStyle = PAPER;
    c.fillRect(0, 0, out.width, out.height);
    c.setTransform(k, 0, 0, k, -wx * k, -wy * k);
    for (const s of state.strokes) drawStroke(c, s);
    const blob = await new Promise((resolve, reject) => out.toBlob((x) => (x ? resolve(x) : reject(new Error("export"))), "image/png"));
    return new File([blob], "note-manuscrite.png", { type: "image/png" });
  }

  dialog.addEventListener("click", async (event) => {
    const t = event.target.closest("button");
    if (!t) return;
    if (t.dataset.inkColor) {
      state.color = t.dataset.inkColor;
      state.eraser = false;
    } else if (t.dataset.inkWidth) {
      state.width = Number(t.dataset.inkWidth);
      state.eraser = false;
    } else if (t.id === "ink-eraser") {
      state.eraser = !state.eraser;
    } else if (t.id === "ink-undo") {
      const s = state.strokes.pop();
      if (s) state.redo.push(s);
    } else if (t.id === "ink-redo") {
      const s = state.redo.pop();
      if (s) state.strokes.push(s);
    } else if (t.id === "ink-clear") {
      if (!state.strokes.length) return;
      if (!confirm("Effacer toute la note ?")) return;
      state.strokes = [];
      state.redo = [];
    } else if (t.id === "ink-fit") {
      return fit();
    } else if (t.id === "ink-zoom-in") {
      const r = canvas.getBoundingClientRect();
      return zoomAt(r.width / 2, r.height / 2, 1.4);
    } else if (t.id === "ink-zoom-out") {
      const r = canvas.getBoundingClientRect();
      return zoomAt(r.width / 2, r.height / 2, 1 / 1.4);
    } else if (t.id === "ink-send") {
      if (!state.strokes.length) return;
      try {
        const file = await exportPng();
        close();
        await onDone(file);
      } catch {
        toast("Impossible de créer l'image de la note.");
      }
      return;
    } else if (t.id === "ink-cancel") {
      if (state.strokes.length && !confirm("Abandonner cette note ?")) return;
      return close();
    } else return;
    redraw();
  });

  function close() {
    if (dialog.close) dialog.close();
    else dialog.removeAttribute("open");
  }

  dialog.addEventListener("cancel", (event) => {
    // Échap / retour : on ne perd pas une note commencée par mégarde.
    if (state.strokes.length && !confirm("Abandonner cette note ?")) event.preventDefault();
  });

  window.addEventListener("resize", () => dialog.open && resize());

  return function open() {
    state.strokes = [];
    state.redo = [];
    state.current = null;
    state.pointers.clear();
    state.gesture = null;
    state.scale = 1;
    state.tx = 0;
    state.ty = 0;
    state.eraser = false;
    state.color = COLORS[0];
    state.width = WIDTHS[1];
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute("open", "");
    resize();
  };
}
