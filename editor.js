// Touch-up editor: erase leftovers (hanger, floor…), bring parts back and optionally enhance, with zoom and pan.
// editImage(blob) resolves with { blob, enhanced } for the edited PNG, or null when nothing changed.
import { enhance } from './enhance.js?v=33';

const $ = (s) => document.querySelector(s);
const MAX_ZOOM = 10;

export async function editImage(blob) {
  const root = $('#editor');
  const view = $('#ed-view');
  const stage = $('#ed-stage');
  const canvas = $('#ed-canvas');
  const cursor = $('#ed-cursor');
  const sizeInput = $('#ed-size');

  const bmp = await createImageBitmap(blob);
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // The mask holds everything that was erased. Strokes are kept as a list so undo is cheap.
  const mask = document.createElement('canvas');
  mask.width = bmp.width;
  mask.height = bmp.height;
  const mctx = mask.getContext('2d');
  const strokes = [];

  // The picture being edited: the original, or an enhanced copy of it.
  let base = bmp;
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
  setTool('erase');
  fitView();

  /* ----- drawing ----- */

  let queued = false;
  function render() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(base, 0, 0);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(mask, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    });
  }

  function paint(stroke, from, to) {
    mctx.globalCompositeOperation = stroke.mode === 'erase' ? 'source-over' : 'destination-out';
    mctx.fillStyle = mctx.strokeStyle = '#000';
    mctx.lineCap = mctx.lineJoin = 'round';
    mctx.lineWidth = stroke.size;
    if (!to) {
      mctx.beginPath();
      mctx.arc(from.x, from.y, stroke.size / 2, 0, Math.PI * 2);
      mctx.fill();
    } else {
      mctx.beginPath();
      mctx.moveTo(from.x, from.y);
      mctx.lineTo(to.x, to.y);
      mctx.stroke();
    }
  }

  function rebuildMask() {
    mctx.globalCompositeOperation = 'source-over';
    mctx.clearRect(0, 0, mask.width, mask.height);
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
  enhanceInput.value = 0;
  enhanceOut.textContent = '0';

  function swapBase(next) {
    const old = base;
    base = next;
    if (old !== bmp) old.close?.();
    render();
  }

  async function applyEnhance(value) {
    amount = value;
    if (!value) return swapBase(bmp);
    const next = await createImageBitmap(await enhance(blob, value));
    if (amount !== value) return next.close?.(); // the slider moved on meanwhile
    swapBase(next);
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

  /* ----- finish ----- */

  return new Promise((resolve) => {
    const close = (result) => {
      ac.abort();
      root.hidden = true;
      if (base !== bmp) base.close?.();
      bmp.close?.();
      resolve(result);
    };
    on($('#ed-cancel'), 'click', () => close(null));
    on($('#ed-done'), 'click', async () => {
      clearTimeout(timer);
      const wanted = Number(enhanceInput.value) / 100;
      if (wanted !== amount) request(wanted);
      await inflight;
      // render() is queued in a frame; compose once more synchronously to be safe
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(base, 0, 0);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(mask, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      canvas.toBlob((b) => close(strokes.length || amount ? { blob: b, enhanced: amount > 0 } : null), 'image/png');
    });
  });
}
