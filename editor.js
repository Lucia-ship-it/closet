// Touch-up editor: erase leftovers (hanger, floor…), bring parts back and optionally enhance, with zoom and pan.
// editImage(blob, { original, enhanceStart, previewOnly }) resolves with { blob, enhanced, enhanceAmount } for the edited PNG,
// or null when nothing changed (always an object with previewOnly, unless cancelled).
// With `original` (the photo before background removal), Restore can bring back parts the removal cut away.
// `enhanceStart` is the strength (0..1) the Enhance slider starts at. With `previewOnly` the enhancement is only shown
// while editing and is NOT baked into the result: the caller keeps the chosen `enhanceAmount` and applies it later.
import { enhance } from './enhance.js?v=53';

const $ = (s) => document.querySelector(s);
const MAX_ZOOM = 10;

export async function editImage(blob, { original, enhanceStart = 0, previewOnly = false } = {}) {
  const root = $('#editor');
  const view = $('#ed-view');
  const stage = $('#ed-stage');
  const canvas = $('#ed-canvas');
  const cursor = $('#ed-cursor');
  const sizeInput = $('#ed-size');

  const bmp = await createImageBitmap(blob);
  const origBmp = original ? await createImageBitmap(original) : null;
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Two masks: `mask` holds what was erased, `showMask` what was brought back from the original photo.
  // Strokes are kept as a list so undo is cheap.
  const makeMask = () => {
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    return c;
  };
  const mask = makeMask();
  const mctx = mask.getContext('2d');
  const showMask = makeMask();
  const sctx = showMask.getContext('2d');
  const scratch = makeMask();
  const xctx = scratch.getContext('2d');
  const strokes = [];

  // The picture being edited: the original, or an enhanced copy of it.
  let base = bmp;
  let origBase = origBmp; // the original photo, enhanced together with the cutout
  let amount = 0;
  let inflight = Promise.resolve();
  let timer;

  let tool = 'erase';
  let s = 1;
  let tx = 0;
  let ty = 0;
  let baseW = 0;
  let current = null;
  let gesture = null;
  let panFrom = null;
  const pointers = new Map();
  const ignored = new Set();

  const ac = new AbortController();
  const on = (target, type, fn, opts = {}) => target.addEventListener(type, fn, { ...opts, signal: ac.signal });

  root.hidden = false;
  $('#ed-restore-note').hidden = !origBmp;
  setTool('erase');
  fitView();

  /* ----- drawing ----- */

  // Puts the picture together: the cutout, plus the original photo where it was brought back,
  // minus what was erased.
  function compose(raw = false) {
    const shownBase = raw ? bmp : base;
    const shownOrig = raw ? origBmp : origBase; // raw: without enhancement
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(shownBase, 0, 0);
    if (shownOrig && strokes.some((st) => st.mode === 'restore')) {
      xctx.globalCompositeOperation = 'source-over';
      xctx.clearRect(0, 0, scratch.width, scratch.height);
      xctx.drawImage(shownOrig, 0, 0, scratch.width, scratch.height);
      xctx.globalCompositeOperation = 'destination-in';
      xctx.drawImage(showMask, 0, 0);
      ctx.drawImage(scratch, 0, 0);
    }
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(mask, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }

  let queued = false;
  function render() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      compose();
    });
  }

  // Draws one dot or one line segment of a stroke on a mask, adding to it or cutting from it.
  function stamp(c, add, size, from, to) {
    c.globalCompositeOperation = add ? 'source-over' : 'destination-out';
    c.fillStyle = c.strokeStyle = '#000';
    c.lineCap = c.lineJoin = 'round';
    c.lineWidth = size;
    c.beginPath();
    if (!to) {
      c.arc(from.x, from.y, size / 2, 0, Math.PI * 2);
      c.fill();
    } else {
      c.moveTo(from.x, from.y);
      c.lineTo(to.x, to.y);
      c.stroke();
    }
  }

  // Erasing hides the spot and takes back anything restored there; restoring does the opposite.
  // Without an original photo, restoring just undoes erasing.
  function paint(stroke, from, to) {
    const erase = stroke.mode === 'erase';
    stamp(mctx, erase, stroke.size, from, to);
    if (origBmp || erase) stamp(sctx, !erase, stroke.size, from, to);
  }

  function rebuildMask() {
    for (const [c, m] of [[mctx, mask], [sctx, showMask]]) {
      c.globalCompositeOperation = 'source-over';
      c.clearRect(0, 0, m.width, m.height);
    }
    for (const st of strokes) {
      paint(st, st.pts[0]);
      for (let i = 1; i < st.pts.length; i++) paint(st, st.pts[i - 1], st.pts[i]);
    }
    render();
  }

  const rect = () => canvas.getBoundingClientRect();

  function toCanvas(e) {
    const r = rect();
    return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
  }

  const brushSize = () => (Number(sizeInput.value) * canvas.width) / rect().width;

  /* ----- zoom and pan ----- */

  function apply() {
    stage.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  }

  function fitView() {
    const v = view.getBoundingClientRect();
    const k = Math.min(v.width / canvas.width, v.height / canvas.height);
    baseW = canvas.width * k;
    canvas.style.width = `${baseW}px`;
    canvas.style.height = `${canvas.height * k}px`;
    s = 1;
    tx = (v.width - baseW) / 2;
    ty = (v.height - canvas.height * k) / 2;
    apply();
  }

  function zoomAt(px, py, factor) {
    const next = Math.min(MAX_ZOOM, Math.max(1, s * factor));
    const ratio = next / s;
    tx = px - (px - tx) * ratio;
    ty = py - (py - ty) * ratio;
    s = next;
    apply();
  }

  const viewPoint = (e) => {
    const v = view.getBoundingClientRect();
    return { x: e.clientX - v.left, y: e.clientY - v.top };
  };

  /* ----- pointer input: one finger draws (or pans in Move mode), two fingers pinch and pan ----- */

  function startGesture() {
    const [a, b] = [...pointers.values()];
    const v = view.getBoundingClientRect();
    gesture = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      mid: { x: (a.x + b.x) / 2 - v.left, y: (a.y + b.y) / 2 - v.top },
      s, tx, ty,
    };
  }

  on(view, 'pointerdown', (e) => {
    view.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      if (current) {
        strokes.pop(); // the first finger was a pinch, not a stroke
        current = null;
        rebuildMask();
      }
      panFrom = null;
      startGesture();
      return;
    }
    if (pointers.size > 2) return;

    if (tool === 'move') {
      panFrom = { x: e.clientX, y: e.clientY, tx, ty };
      return;
    }
    const p = toCanvas(e);
    current = { mode: tool, size: brushSize(), pts: [p] };
    strokes.push(current);
    paint(current, p);
    render();
  });

  on(view, 'pointermove', (e) => {
    if (e.pointerType === 'mouse') {
      const v = viewPoint(e);
      const d = Number(sizeInput.value);
      cursor.style.cssText = `display:${tool === 'move' ? 'none' : 'block'};width:${d}px;height:${d}px;left:${v.x - d / 2}px;top:${v.y - d / 2}px`;
    }
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (gesture && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const v = view.getBoundingClientRect();
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2 - v.left, y: (a.y + b.y) / 2 - v.top };
      const next = Math.min(MAX_ZOOM, Math.max(1, gesture.s * (dist / gesture.dist)));
      const ratio = next / gesture.s;
      s = next;
      tx = mid.x - (gesture.mid.x - gesture.tx) * ratio;
      ty = mid.y - (gesture.mid.y - gesture.ty) * ratio;
      apply();
      return;
    }

    if (current && !ignored.has(e.pointerId)) {
      const p = toCanvas(e);
      const last = current.pts[current.pts.length - 1];
      current.pts.push(p);
      paint(current, last, p);
      render();
    } else if (panFrom && pointers.size === 1) {
      tx = panFrom.tx + (e.clientX - panFrom.x);
      ty = panFrom.ty + (e.clientY - panFrom.y);
      apply();
    }
  });

  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) gesture = null;
    if (pointers.size === 0) ignored.clear();
    // a finger left over from a pinch must not start drawing
    else for (const id of pointers.keys()) ignored.add(id);
    current = null;
    panFrom = null;
  };
  on(view, 'pointerup', release);
  on(view, 'pointercancel', release);
  on(view, 'pointerleave', (e) => {
    if (e.pointerType === 'mouse') cursor.style.display = 'none';
  });

  on(view, 'wheel', (e) => {
    e.preventDefault();
    const v = viewPoint(e);
    zoomAt(v.x, v.y, e.deltaY < 0 ? 1.2 : 1 / 1.2);
  }, { passive: false });

  /* ----- toolbar ----- */

  function setTool(name) {
    tool = name;
    document.querySelectorAll('#ed-tools button').forEach((b) => b.classList.toggle('on', b.dataset.tool === name));
    view.dataset.tool = name;
  }

  document.querySelectorAll('#ed-tools button').forEach((b) => on(b, 'click', () => setTool(b.dataset.tool)));

  // Enhance slider: only the latest requested strength is kept in memory.
  const enhanceInput = $('#ed-enhance');
  const enhanceOut = $('#ed-enhance-value');
  enhanceInput.value = Math.round(enhanceStart * 100);
  enhanceOut.textContent = String(Math.round(enhanceStart * 100));

  function swapBase(next, nextOrig) {
    const old = base;
    const oldOrig = origBase;
    base = next;
    origBase = nextOrig;
    if (old !== bmp) old.close?.();
    if (oldOrig && oldOrig !== origBmp) oldOrig.close?.();
    render();
  }

  async function applyEnhance(value) {
    amount = value;
    if (!value) return swapBase(bmp, origBmp);
    const next = await createImageBitmap(await enhance(blob, value));
    const nextOrig = original ? await createImageBitmap(await enhance(original, value)) : null;
    if (amount !== value) {
      next.close?.(); // the slider moved on meanwhile
      nextOrig?.close?.();
      return;
    }
    swapBase(next, nextOrig);
  }

  const request = (value) => (inflight = applyEnhance(value));

  on(enhanceInput, 'input', () => {
    enhanceOut.textContent = enhanceInput.value;
    clearTimeout(timer);
    timer = setTimeout(() => request(Number(enhanceInput.value) / 100), 120);
  });

  const center = () => {
    const v = view.getBoundingClientRect();
    return { x: v.width / 2, y: v.height / 2 };
  };
  on($('#ed-zoom-in'), 'click', () => zoomAt(center().x, center().y, 1.5));
  on($('#ed-zoom-out'), 'click', () => zoomAt(center().x, center().y, 1 / 1.5));
  on($('#ed-fit'), 'click', fitView);

  on($('#ed-undo'), 'click', () => {
    if (!strokes.length) return;
    strokes.pop();
    rebuildMask();
  });

  render();
  if (enhanceStart) request(enhanceStart);

  /* ----- finish ----- */

  return new Promise((resolve) => {
    const close = (result) => {
      ac.abort();
      root.hidden = true;
      if (base !== bmp) base.close?.();
      if (origBase && origBase !== origBmp) origBase.close?.();
      bmp.close?.();
      origBmp?.close?.();
      resolve(result);
    };
    on($('#ed-cancel'), 'click', () => close(null));
    on($('#ed-done'), 'click', async () => {
      clearTimeout(timer);
      const wanted = Number(enhanceInput.value) / 100;
      if (wanted !== amount) request(wanted);
      await inflight;
      compose(previewOnly); // render() is queued in a frame; compose once more synchronously to be safe
      canvas.toBlob((b) => {
        if (previewOnly) close({ blob: strokes.length ? b : blob, enhanced: false, enhanceAmount: amount });
        else close(strokes.length || amount ? { blob: b, enhanced: amount > 0, enhanceAmount: amount } : null);
      }, 'image/png');
    });
  });
}
