import { panByPixels, zoomAt } from "../view.js";

/**
 * Pointer pan, wheel zoom, and pinch zoom.
 * Coordinates are mapped from CSS pixels to the canvas backing-store size.
 */

export function attachPointerInput(canvas, view, { onViewChange }) {
  const pointers = new Map();
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let pinch = null;

  function metrics() {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / Math.max(rect.width, 1);
    const sy = canvas.height / Math.max(rect.height, 1);
    return { rect, sx, sy, width: canvas.width, height: canvas.height };
  }

  function toLocal(clientX, clientY) {
    const { rect, sx, sy } = metrics();
    return {
      x: (clientX - rect.left) * sx,
      y: (clientY - rect.top) * sy,
    };
  }

  function emit() {
    onViewChange(view);
  }

  function capturePinch() {
    if (pointers.size < 2) return null;
    const pts = [...pointers.values()];
    const a = pts[0];
    const b = pts[1];
    return {
      dist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
    };
  }

  function onPointerDown(e) {
    canvas.setPointerCapture(e.pointerId);
    const p = toLocal(e.clientX, e.clientY);
    pointers.set(e.pointerId, p);

    if (pointers.size === 2) {
      dragging = false;
      pinch = capturePinch();
      return;
    }

    if (pointers.size === 1) {
      dragging = true;
      lastX = p.x;
      lastY = p.y;
    }
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    const p = toLocal(e.clientX, e.clientY);
    pointers.set(e.pointerId, p);

    if (pointers.size >= 2 && pinch) {
      const next = capturePinch();
      if (!next) return;
      const { width, height } = metrics();
      const factor = next.dist / pinch.dist;
      if (Number.isFinite(factor) && factor > 0) {
        zoomAt(view, factor, pinch.midX, pinch.midY, width, height);
        panByPixels(view, next.midX - pinch.midX, next.midY - pinch.midY, width, height);
        emit();
      }
      pinch = next;
      return;
    }

    if (dragging && pointers.size === 1) {
      const { width, height } = metrics();
      panByPixels(view, p.x - lastX, p.y - lastY, width, height);
      lastX = p.x;
      lastY = p.y;
      emit();
    }
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) dragging = false;
    if (pointers.size === 1) {
      const rem = [...pointers.values()][0];
      dragging = true;
      lastX = rem.x;
      lastY = rem.y;
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const { width, height } = metrics();
    const p = toLocal(e.clientX, e.clientY);
    zoomAt(view, Math.exp(-e.deltaY * 0.0075), p.x, p.y, width, height);
    emit();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("wheel", onWheel);
  };
}
