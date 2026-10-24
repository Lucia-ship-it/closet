import * as db from './db.js?v=49';
import { loadScaled, removeBg, finalize, tightCrop } from './image.js?v=49';
import { editImage } from './editor.js?v=49';
import { enhance } from './enhance.js?v=49';

const CATS = { top: 'Top', bottom: 'Bottom', dress: 'Dress', sweater: 'Sweater', jacket: 'Jacket', shoes: 'Shoes' };
const PLURAL = { top: 'Tops', bottom: 'Bottoms', dress: 'Dresses', sweater: 'Sweaters', jacket: 'Jackets', shoes: 'Shoes' };
const ADD_LABEL = { top: 'a top', bottom: 'a bottom', dress: 'a dress', sweater: 'a sweater', jacket: 'a jacket', shoes: 'shoes' };

const state = {
  items: [],
  urls: new Map(),
  mode: 'tb', // tb = vrch + spodok, dress = šaty, sweater = vrch + sveter + spodok
  sel: {}, // aktuálne zobrazený kúsok v každej kategórii
  filter: 'all',
  picked: {}, // výber v mriežke šatníka
  editing: false,
  complete: false,
  shoes: false, // shoes are optional: shown only while this is on
  tight: new Map(), // id -> { url, aspect } of the item cropped to its real content
  outfits: [], // saved outfits
  savedEditing: false,
  shown: null, // the outfit currently shown in the Complete view
};

// New photos start with a light enhancement; the user can lower it to 0 or raise it.
const DEFAULT_ENHANCE = 0.35;

const add = { original: null, cutout: null, source: 'cutout', rotation: 0, cat: null, busy: false, token: 0, enhance: DEFAULT_ENHANCE };

const $ = (s) => document.querySelector(s);

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function urlFor(item) {
  if (!state.urls.has(item.id)) state.urls.set(item.id, URL.createObjectURL(item.blob));
  return state.urls.get(item.id);
}

const byCat = (cat) => state.items.filter((i) => i.cat === cat);

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

/* ---------- Záložky ---------- */

function showTab(tab) {
  document.querySelectorAll('.screen').forEach((s) => (s.hidden = s.id !== tab));
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  if (tab === 'outfit') renderOutfit();
  if (tab === 'wardrobe') renderWardrobe();
  if (tab === 'saved') renderSaved();
  if (tab === 'add') renderAdd();
}

document.querySelectorAll('.tabbar button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

/* ---------- Outfit ---------- */

// A mode says what the outfit is made of: tb (top + bottom), dress, and optionally a layer over
// it: sweater / jacket (e.g. 'sweater' = top + sweater + bottom, 'dressjacket' = dress + jacket).
const LAYER_CATS = ['sweater', 'jacket'];
const parseMode = (mode) => ({ withDress: mode.startsWith('dress'), layer: LAYER_CATS.find((c) => mode.endsWith(c)) ?? null });
const makeMode = (withDress, layer) => (withDress ? 'dress' : '') + (layer ?? '') || 'tb';

// The categories of an outfit in a fixed order (the order is part of how saved outfits are compared).
function slotsFor(mode) {
  const { withDress, layer } = parseMode(mode);
  const layers = layer ? [layer] : [];
  return withDress ? ['dress', ...layers] : ['top', ...layers, 'bottom'];
}

// Rows of swipeable strips; the layer sits next to the top or dress.
function rowsFor(mode) {
  const { withDress, layer } = parseMode(mode);
  const rows = withDress ? [layer ? ['dress', layer] : ['dress']] : [layer ? ['top', layer] : ['top'], ['bottom']];
  return state.shoes ? [...rows, ['shoes']] : rows;
}

function renderOutfit() {
  $('#complete').textContent = state.complete ? 'Edit' : 'Complete';
  $('#modes').hidden = state.complete;
  $('#save-outfit').hidden = true;
  if (state.complete) return renderComplete();
  const { withDress, layer } = parseMode(state.mode);
  document.querySelectorAll('#modes [data-base]').forEach((b) => b.classList.toggle('on', (b.dataset.base === 'dress') === withDress));
  document.querySelectorAll('#modes [data-layer]').forEach((b) => b.classList.toggle('on', b.dataset.layer === layer));
  $('#shoes-toggle').classList.toggle('on', state.shoes);
  const area = $('#outfit-area');
  area.replaceChildren();
  for (const row of rowsFor(state.mode)) {
    const r = el('div', row[0] === 'shoes' ? 'outfit-row shoes' : 'outfit-row');
    for (const cat of row) r.append(strip(cat, row.length > 1));
    area.append(r);
  }
}

// The item currently chosen in a category (falls back to the first one).
function current(cat) {
  const items = byCat(cat);
  return items.find((i) => i.id === state.sel[cat]) ?? items[0];
}

function pieceImg(item, className) {
  const img = new Image();
  img.src = urlFor(item);
  img.alt = CATS[item.cat];
  img.draggable = false;
  if (className) img.className = className;
  return img;
}

// "Complete" view: the outfit laid out as if worn. Garments are cropped to their real
// content first and then fitted one under the other (units: a figure 200 wide), so
// differently shaped photos still line up and the pieces touch each other.
const FIG_W = 200;
const OVERLAP = 8; // the top hangs this far over the bottoms
const ADJUST_KEY = 'satnik.adjust';
const NO_ADJUST = { dx: 0, dy: 0, scale: 1 };

// Hand adjustments of a sweater over a top, remembered per pair of items.
const adjusts = (() => {
  try {
    return JSON.parse(localStorage.getItem(ADJUST_KEY)) ?? {};
  } catch {
    return {};
  }
})();

function saveAdjusts() {
  try {
    localStorage.setItem(ADJUST_KEY, JSON.stringify(adjusts));
  } catch {
    // storage unavailable: the adjustment just lasts until the page closes
  }
}

async function tightOf(item) {
  if (!state.tight.has(item.id)) {
    const crop = await tightCrop(item.blob);
    // shape measurements fall back to neutral values, so a missing one can never break the layout
    const shoulder = Number.isFinite(crop.shoulder) ? crop.shoulder : 0;
    const body = Number.isFinite(crop.body) && crop.body > 0 ? crop.body : 0.5;
    state.tight.set(item.id, { ...crop, shoulder, body, url: URL.createObjectURL(crop.blob) });
  }
  return state.tight.get(item.id);
}

// Largest size with the given aspect ratio that fits the box.
function fit(aspect, maxW, maxH) {
  const w = Math.min(maxW, maxH * aspect);
  return { w, h: w / aspect };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));


// The items currently chosen for the active mode: { category: item id }.
function currentIds() {
  const ids = {};
  for (const cat of state.shoes ? [...slotsFor(state.mode), 'shoes'] : slotsFor(state.mode)) {
    const it = current(cat);
    if (it) ids[cat] = it.id;
  }
  return ids;
}

function placePiece(p, totalH) {
  const w = p.box.w * p.adj.scale;
  const h = p.box.h * p.adj.scale;
  const y = p.anchorY + p.adj.dy - p.shoulder * h;
  Object.assign(p.img.style, {
    left: `${((100 + p.adj.dx - w / 2) / FIG_W) * 100}%`,
    top: `${(y / totalH) * 100}%`,
    width: `${(w / FIG_W) * 100}%`,
    height: `${(h / totalH) * 100}%`,
  });
}

// Builds the picture of an outfit: { body, pieces, totalH }, or null when none of its items exist.
// ids: { category: item id }, adjMap: hand adjustments by piece key.
async function buildOutfit(mode, ids, adjMap) {
  const find = (cat) => state.items.find((i) => i.id === ids[cat] && i.cat === cat);
  const { withDress, layer } = parseMode(mode);
  const dress = withDress ? find('dress') : null;
  const top = withDress ? null : find('top');
  const sweater = layer ? find(layer) : null; // the layer over the top or dress: a sweater or a jacket
  const layerLabel = layer ? CATS[layer] : 'Sweater';
  const bottom = withDress ? null : find('bottom');

  const shoes = ids.shoes ? find('shoes') : null;
  const [dressT, topT, sweaterT, bottomT, shoesT] = await Promise.all(
    [dress, top, sweater, bottom, shoes].map((it) => (it ? tightOf(it) : null)),
  );

  // The garment a sweater goes over: the dress, or else the top.
  const main = dress ?? top;
  const mainT = dressT ?? topT;
  const mainLabel = dressT ? 'Dress' : 'Top';
  const UPPER = [150, 190];
  const mainMax = dressT ? [170, 420] : UPPER;

  // A single piece is simply fitted; a sweater over a top or dress is lined up by the
  // shoulders and scaled to the same body width, whatever the photos look like.
  let mainBox = null;
  let sweaterBox = null;
  let mainBottom = 0;
  let shoulderY = 0;
  if (mainT && sweaterT) {
    const t = fit(mainT.aspect, ...mainMax);
    const base = fit(sweaterT.aspect, ...UPPER);
    const sw = clamp((t.w * mainT.body) / sweaterT.body, base.w * 0.6, base.w * 1.6);
    const s = { w: sw, h: sw / sweaterT.aspect };
    shoulderY = Math.max(t.h * mainT.shoulder, s.h * sweaterT.shoulder);
    mainBox = { ...t, y: shoulderY - t.h * mainT.shoulder };
    sweaterBox = { ...s, y: shoulderY - s.h * sweaterT.shoulder };
    mainBottom = Math.max(mainBox.y + mainBox.h, sweaterBox.y + sweaterBox.h);
  } else if (mainT || sweaterT) {
    const single = mainT ?? sweaterT;
    mainBox = { ...fit(single.aspect, ...(mainT ? mainMax : UPPER)), y: 0 };
    mainBottom = mainBox.h;
  }

  const bottomDims = bottomT ? fit(bottomT.aspect, 120, 300) : null;
  const bottomY = mainBottom ? mainBottom - OVERLAP : 0;
  const clothesH = Math.max(mainBottom, bottomY + (bottomDims?.h ?? 0));
  // shoes go at the very bottom, just under the hem
  const shoesDims = shoesT ? fit(shoesT.aspect, 110, 70) : null;
  const shoesY = shoesDims ? Math.max(0, clothesH - 6) : 0;
  const totalH = shoesDims ? shoesY + shoesDims.h : clothesH;
  if (!totalH) return null;

  const body = el('div', 'mannequin');
  body.style.aspectRatio = `${FIG_W} / ${totalH}`;

  const put = (parent, tight, alt) => {
    const img = new Image();
    img.src = tight.url;
    img.alt = alt;
    img.draggable = false;
    img.className = 'piece';
    parent.append(img);
    return img;
  };

  // A half of the picture; whatever is put in is only visible on that side.
  const half = (side) => {
    const clip = el('div', `clip ${side}`);
    const inner = el('div', 'clip-inner');
    clip.append(inner);
    body.append(clip);
    return inner;
  };

  const pieces = []; // what can be adjusted by hand

  if (bottomT) {
    // bottoms can be moved and resized too, e.g. a short skirt does not have to be trouser-sized
    pieces.push({
      label: 'Bottom', box: { ...bottomDims, y: bottomY }, shoulder: 0, anchorY: bottomY, key: `bottom|${bottom.id}`,
      img: put(body, bottomT, 'Bottom'),
    });
  }

  if (mainT && sweaterT) {
    // A top is shown on the left half and the sweater on the right half. A dress stays whole,
    // and the sweater lies over its right half.
    pieces.push({
      label: mainLabel, box: mainBox, shoulder: mainT.shoulder, anchorY: shoulderY, key: `${mainLabel.toLowerCase()}|${main.id}`,
      img: put(dressT ? body : half('left'), mainT, mainLabel),
    });
    pieces.push({
      label: layerLabel, box: sweaterBox, shoulder: sweaterT.shoulder, anchorY: shoulderY, key: `${main.id}|${sweater.id}`,
      img: put(half('right'), sweaterT, layerLabel),
    });
  } else if (mainT || sweaterT) {
    const [item, tight, label] = mainT ? [main, mainT, mainLabel] : [sweater, sweaterT, layerLabel];
    pieces.push({
      label, box: mainBox, shoulder: tight.shoulder, anchorY: mainBox.y + tight.shoulder * mainBox.h,
      key: `${label.toLowerCase()}|${item.id}`,
      img: put(body, tight, label),
    });
  }

  if (shoesT) {
    pieces.push({
      label: 'Shoes', box: { ...shoesDims, y: shoesY }, shoulder: 0, anchorY: shoesY, key: `shoes|${shoes.id}`,
      img: put(body, shoesT, 'Shoes'),
    });
  }

  for (const p of pieces) {
    p.adj = { ...NO_ADJUST, ...adjMap?.[p.key] };
    placePiece(p, totalH);
  }
  return { body, pieces, totalH };
}

let completeToken = 0;

async function renderComplete() {
  const token = ++completeToken;
  const area = $('#outfit-area');
  const mode = state.mode;
  const ids = currentIds();
  const built = await buildOutfit(mode, ids, adjusts);
  if (token !== completeToken || !state.complete) return;

  const figure = el('div', 'figure');
  if (!built) {
    state.shown = null;
    area.replaceChildren(figure);
    updateHeart();
    toast('Add some items to see your outfit here.');
    return;
  }

  figure.append(built.body);
  area.replaceChildren(figure);
  state.shown = { mode, ids, pieces: built.pieces };

  const hint = el('div', 'complete-hint');
  setUpAdjust(built.body, hint, built.pieces, built.totalH);
  if (hint.children.length) area.append(hint);
  updateHeart();
}

// Is the picture of this piece visible (not transparent) at the given screen point?
const alphaMasks = new WeakMap();
function alphaAt(img, x, y) {
  const r = img.getBoundingClientRect();
  if (!img.naturalWidth || x < r.left || x > r.right || y < r.top || y > r.bottom) return 0;
  let mask = alphaMasks.get(img);
  if (!mask) {
    const k = Math.min(1, 160 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, c.width, c.height);
    mask = { ctx, w: c.width, h: c.height };
    alphaMasks.set(img, mask);
  }
  const px = Math.min(mask.w - 1, Math.floor(((x - r.left) / r.width) * mask.w));
  const py = Math.min(mask.h - 1, Math.floor(((y - r.top) / r.height) * mask.h));
  return mask.ctx.getImageData(px, py, 1, 1).data[3];
}

// Hand adjustment of the tops: drag to move, pinch (or scroll) to resize around the shoulder line.
// With a sweater over a top, the Top / Sweater buttons choose which one is adjusted.
function setUpAdjust(body, hint, pieces, totalH) {
  // Nothing is selected at first, so nothing can be moved by accident.
  let active = null;
  const isDefault = (adj) => adj.dx === 0 && adj.dy === 0 && adj.scale === 1;

  // A dashed frame marks the selected piece.
  const frame = el('div', 'selection');
  body.append(frame);
  const updateFrame = () => {
    frame.classList.toggle('show', !!active);
    if (!active) return;
    const s = active.img.style;
    Object.assign(frame.style, { left: s.left, top: s.top, width: s.width, height: s.height });
  };

  const place = (p) => {
    placePiece(p, totalH);
    if (p === active) updateFrame();
  };

  // The piece under a point: the topmost one whose picture is really visible there.
  const byImg = new Map(pieces.map((p) => [p.img, p]));
  const pieceAt = (x, y) => {
    for (const node of document.elementsFromPoint(x, y)) {
      const p = byImg.get(node);
      if (p && alphaAt(node, x, y) > 30) return p;
    }
    return null;
  };

  // Fingers are bigger than small pieces such as shoes, so a touch that lands just beside a piece
  // still counts: look in a few rings around the point, nearest first.
  const pieceNear = (x, y) => {
    for (const r of [0, 10, 20]) {
      const steps = r ? 8 : 1;
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const hit = pieceAt(x + Math.cos(a) * r, y + Math.sin(a) * r);
        if (hit) return hit;
      }
    }
    return null;
  };

  // The selected piece can be grabbed anywhere inside (and a little around) its frame.
  const insideFrame = (p, x, y, margin = 14) => {
    const r = p.img.getBoundingClientRect();
    const clip = p.img.closest('.clip')?.getBoundingClientRect(); // only the visible half of a half-piece
    const left = Math.max(r.left, clip?.left ?? -Infinity) - margin;
    const right = Math.min(r.right, clip?.right ?? Infinity) + margin;
    return x >= left && x <= right && y >= r.top - margin && y <= r.bottom + margin;
  };

  // Keeps a piece fully inside the outfit area (the grey card), however it is moved or resized.
  const bounds = () => {
    const card = body.parentElement.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    const u = b.width / FIG_W || 1; // screen pixels per figure unit
    return { x0: (card.left - b.left) / u, x1: (card.right - b.left) / u, y0: (card.top - b.top) / u, y1: (card.bottom - b.top) / u };
  };
  const keepInside = (p) => {
    const B = bounds();
    const maxScale = Math.min((B.x1 - B.x0) / p.box.w, (B.y1 - B.y0) / p.box.h);
    if (!Number.isFinite(maxScale) || maxScale <= 0) return;
    p.adj.scale = clamp(p.adj.scale, Math.min(0.4, maxScale), Math.min(2.5, maxScale));
    const w = p.box.w * p.adj.scale;
    const h = p.box.h * p.adj.scale;
    const left = clamp(100 + p.adj.dx - w / 2, B.x0, Math.max(B.x0, B.x1 - w));
    const top = clamp(p.anchorY + p.adj.dy - p.shoulder * h, B.y0, Math.max(B.y0, B.y1 - h));
    p.adj.dx = left + w / 2 - 100;
    p.adj.dy = top - p.anchorY + p.shoulder * h;
  };

  const bar = el('div', 'adjust-bar');
  const pick = el('div', 'pills');
  const reset = el('button', 'text-btn', 'Reset');
  const note = el('span', '');
  // Resizing with buttons is easier than pinching on a small piece.
  const sizeBtns = el('div', 'size-btns');
  const smaller = el('button', 'small-btn', '−');
  const bigger = el('button', 'small-btn', '+');
  smaller.setAttribute('aria-label', 'Smaller');
  bigger.setAttribute('aria-label', 'Bigger');
  sizeBtns.append(smaller, bigger);
  const refresh = () => {
    pick.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', pieces[i] === active));
    reset.hidden = !active || isDefault(active.adj);
    sizeBtns.hidden = !active;
    note.textContent = active
      ? `${active.label} selected. Drag to move, pinch to resize, tap outside to deselect.`
      : 'Tap a piece to adjust it.';
    updateFrame();
  };
  const select = (p) => {
    active = p;
    refresh();
  };

  if (pieces.length > 1) {
    for (const p of pieces) {
      const b = el('button', '', p.label);
      b.onclick = () => select(active === p ? null : p); // tapping the selected one again deselects it
      pick.append(b);
    }
  }
  bar.append(pick, sizeBtns, reset);
  hint.append(bar, note);

  const store = (p) => {
    if (isDefault(p.adj)) delete adjusts[p.key];
    else adjusts[p.key] = { ...p.adj };
    saveAdjusts();
    updateHeart();
  };

  const resize = (factor) => {
    if (!active) return;
    active.adj.scale = clamp(active.adj.scale * factor, 0.4, 2.5);
    keepInside(active);
    place(active);
    refresh();
    store(active);
  };
  smaller.onclick = () => resize(1 / 1.15);
  bigger.onclick = () => resize(1.15);

  reset.onclick = () => {
    if (!active) return;
    Object.assign(active.adj, NO_ADJUST);
    store(active);
    place(active);
    refresh();
  };

  const pointers = new Map();
  let pinch = null;
  let tapOutside = null;
  const unit = () => body.getBoundingClientRect().width / FIG_W; // screen pixels per figure unit

  body.style.touchAction = 'none';
  body.addEventListener('pointerdown', (e) => {
    try {
      body.setPointerCapture(e.pointerId);
    } catch {
      // not a capturable pointer (e.g. it already ended); the gesture still works without capture
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      const hit = pieceNear(e.clientX, e.clientY) ?? (active && insideFrame(active, e.clientX, e.clientY) ? active : null);
      if (hit) {
        tapOutside = null;
        select(hit);
      } else {
        // Touching empty space only deselects if it stays a tap: dragging or pinching with a
        // selection keeps working, so the fingers do not have to land exactly on a small piece.
        tapOutside = { x: e.clientX, y: e.clientY };
      }
    } else {
      tapOutside = null;
    }
    if (pointers.size === 2 && active) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: active.adj.scale };
    }
  });
  body.addEventListener('pointermove', (e) => {
    const last = pointers.get(e.pointerId);
    if (!last) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (tapOutside && Math.hypot(e.clientX - tapOutside.x, e.clientY - tapOutside.y) > 8) tapOutside = null;
    if (!active) return;
    const adj = active.adj;
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      adj.scale = clamp(pinch.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist), 0.4, 2.5);
    } else if (pointers.size === 1) {
      adj.dx = clamp(adj.dx + (e.clientX - last.x) / unit(), -400, 400);
      adj.dy = clamp(adj.dy + (e.clientY - last.y) / unit(), -400, 400);
    }
    keepInside(active);
    place(active);
    refresh();
  });
  const release = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0 && active) store(active);
    if (pointers.size === 0 && tapOutside && e.type === 'pointerup') select(null); // a plain tap on empty space
    if (pointers.size === 0) tapOutside = null;
  };
  body.addEventListener('pointerup', release);
  body.addEventListener('pointercancel', release);
  body.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!active) return;
    active.adj.scale = clamp(active.adj.scale * (e.deltaY < 0 ? 1.05 : 1 / 1.05), 0.4, 2.5);
    keepInside(active);
    place(active);
    refresh();
    store(active);
  }, { passive: false });

  pieces.forEach((p) => {
    keepInside(p); // an old adjustment that sticks out gets pulled back in
    place(p);
  });
  refresh();
}

$('#complete').onclick = () => {
  state.complete = !state.complete;
  renderOutfit();
};

/* ---------- Saved outfits ---------- */

const round1 = (n) => Math.round(n * 10) / 10;
const isDefaultAdj = (adj) => adj.dx === 0 && adj.dy === 0 && adj.scale === 1;

// What gets saved: the mode, the chosen items and every hand adjustment (rounded, so equal looks compare equal).
function shownSnapshot() {
  const s = state.shown;
  if (!s) return null;
  const adj = {};
  for (const p of s.pieces) adj[p.key] = { dx: round1(p.adj.dx), dy: round1(p.adj.dy), scale: Math.round(p.adj.scale * 100) / 100 };
  return { mode: s.mode, ids: s.ids, adj };
}

const signature = (o) => JSON.stringify([o.mode, o.ids, o.adj]);
const findSaved = (snap) => state.outfits.find((o) => signature(o) === signature(snap));

// The heart is filled while the outfit on screen is already saved.
function updateHeart() {
  const btn = $('#save-outfit');
  const snap = state.complete ? shownSnapshot() : null;
  btn.hidden = !snap;
  btn.classList.toggle('on', !!snap && !!findSaved(snap));
}

$('#save-outfit').onclick = async () => {
  const snap = shownSnapshot();
  if (!snap) return;
  const existing = findSaved(snap);
  if (existing) {
    await db.removeOutfit(existing.id);
    state.outfits = state.outfits.filter((o) => o !== existing);
    toast('Removed from Saved');
  } else {
    const outfit = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), created: Date.now(), ...snap };
    await db.putOutfit(outfit);
    state.outfits.push(outfit);
    toast('Saved to your outfits');
  }
  updateHeart();
};

let savedToken = 0;

async function renderSaved() {
  const token = ++savedToken;
  $('#saved-edit').textContent = state.savedEditing ? 'Done' : 'Edit';
  const grid = $('#saved-grid');
  const outfits = [...state.outfits].sort((a, b) => b.created - a.created);

  if (!outfits.length) {
    const empty = el('div', 'empty');
    empty.append(el('span', '', 'No saved outfits yet'), el('span', '', 'Tap the heart in the Complete view to save one.'));
    grid.replaceChildren(empty);
    return;
  }

  const built = await Promise.all(outfits.map((o) => buildOutfit(o.mode, o.ids, o.adj)));
  if (token !== savedToken) return;

  const cards = outfits.map((o, i) => {
    const card = el('button', 'outfit-card');
    card.setAttribute('aria-label', 'Saved outfit');
    if (built[i]) card.append(built[i].body);
    else card.append(el('span', 'missing', 'Some items were deleted'));
    if (state.savedEditing) card.append(el('span', 'badge', '×'));
    card.onclick = () => (state.savedEditing ? deleteOutfit(o) : openOutfit(o));
    return card;
  });
  grid.replaceChildren(...cards);
}

// Shows a saved outfit again in the Complete view, exactly as it was saved.
function openOutfit(outfit) {
  state.mode = outfit.mode;
  state.shoes = !!outfit.ids.shoes;
  for (const [cat, id] of Object.entries(outfit.ids)) state.sel[cat] = id;
  for (const [key, adj] of Object.entries(outfit.adj)) {
    if (isDefaultAdj(adj)) delete adjusts[key];
    else adjusts[key] = { ...adj };
  }
  saveAdjusts();
  state.complete = true;
  showTab('outfit');
}

async function deleteOutfit(outfit) {
  if (!confirm('Delete this saved outfit?')) return;
  await db.removeOutfit(outfit.id);
  state.outfits = state.outfits.filter((o) => o !== outfit);
  renderSaved();
}

$('#saved-edit').onclick = () => {
  state.savedEditing = !state.savedEditing;
  renderSaved();
};

function strip(cat, half) {
  const wrap = el('div', 'strip-wrap');
  const items = byCat(cat);

  if (!items.length) {
    const empty = el('button', 'empty');
    empty.append(el('span', 'plus', '+'), el('span', '', `Add ${ADD_LABEL[cat]}`));
    empty.onclick = () => {
      add.cat = cat;
      showTab('add');
    };
    wrap.append(empty);
    return wrap;
  }

  const s = el('div', half ? 'strip half' : 'strip');
  for (const it of items) {
    const slide = el('div', 'slide');
    const img = new Image();
    img.src = urlFor(it);
    img.alt = CATS[cat];
    img.draggable = false;
    slide.append(img);
    s.append(slide);
  }

  const dots = el('div', 'dots');
  const useDots = items.length <= 10;
  if (useDots) items.forEach(() => dots.append(el('span')));

  const mark = (i) => {
    state.sel[cat] = items[i].id;
    if (useDots) [...dots.children].forEach((d, j) => d.classList.toggle('on', j === i));
    else dots.textContent = `${i + 1} / ${items.length}`;
  };

  const start = Math.max(0, items.findIndex((i) => i.id === state.sel[cat]));
  mark(start);

  // Ktorý kúsok je práve v strede pásu
  let frame;
  s.addEventListener('scroll', () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const center = s.scrollLeft + s.clientWidth / 2;
      let best = 0;
      let bestDist = Infinity;
      [...s.children].forEach((c, i) => {
        const d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - center);
        if (d < bestDist) [best, bestDist] = [i, d];
      });
      mark(best);
    });
  });

  // Po vykreslení posunieme pás na vybraný kúsok
  requestAnimationFrame(() => scrollToIndex(s, start, 'instant'));

  wrap.append(s, dots);
  return wrap;
}

function scrollToIndex(s, i, behavior = 'smooth') {
  const c = s.children[i];
  if (c) s.scrollTo({ left: c.offsetLeft - (s.clientWidth - c.offsetWidth) / 2, behavior });
}

// Top + bottom / Dress keeps the chosen layer; tapping the active layer again turns it off.
document.querySelectorAll('#modes [data-base]').forEach((b) => {
  b.onclick = () => {
    state.mode = makeMode(b.dataset.base === 'dress', parseMode(state.mode).layer);
    renderOutfit();
  };
});

document.querySelectorAll('#modes [data-layer]').forEach((b) => {
  b.onclick = () => {
    const { withDress, layer } = parseMode(state.mode);
    state.mode = makeMode(withDress, layer === b.dataset.layer ? null : b.dataset.layer);
    renderOutfit();
  };
});

$('#shoes-toggle').onclick = () => {
  state.shoes = !state.shoes;
  renderOutfit();
};


/* ---------- Šatník ---------- */

function renderWardrobe() {
  const filters = $('#filters');
  filters.replaceChildren();
  for (const [key, label] of [['all', 'All'], ...Object.entries(PLURAL)]) {
    const b = el('button', state.filter === key ? 'on' : '', label);
    b.onclick = () => {
      state.filter = key;
      renderWardrobe();
    };
    filters.append(b);
  }

  $('#edit-toggle').textContent = state.editing ? 'Done' : 'Edit';
  $('#edit-hint').hidden = !state.editing;

  const grid = $('#grid');
  grid.replaceChildren();
  const items = state.items
    .filter((i) => state.filter === 'all' || i.cat === state.filter)
    .sort((a, b) => b.created - a.created);

  if (!items.length) {
    const empty = el('button', 'empty');
    const what = state.filter === 'all' ? 'your first item' : ADD_LABEL[state.filter];
    empty.append(el('span', 'plus', '+'), el('span', '', `Add ${what}`));
    empty.onclick = () => {
      if (state.filter !== 'all') add.cat = state.filter;
      showTab('add');
    };
    grid.append(empty);
  }

  for (const it of items) {
    const picked = state.picked[it.cat] === it.id;
    const tile = el('button', 'tile' + (picked && !state.editing ? ' picked' : ''));
    tile.setAttribute('aria-label', CATS[it.cat]);
    const img = new Image();
    img.src = urlFor(it);
    img.alt = '';
    tile.append(img);
    if (picked && !state.editing) tile.append(el('span', 'badge', '✓'));
    tile.onclick = () => (state.editing ? openSheet(it) : togglePick(it));
    grid.append(tile);
  }

  const count = Object.values(state.picked).filter(Boolean).length;
  const go = $('#wardrobe-go');
  go.hidden = state.editing || count === 0;
  go.textContent = `View outfit (${count})`;
}

// Z každej kategórie sa dá vybrať jeden kúsok.
function togglePick(item) {
  state.picked[item.cat] = state.picked[item.cat] === item.id ? undefined : item.id;
  renderWardrobe();
}

/* Item sheet: change category, touch up the photo or delete the item. */

let sheetItem = null;

function openSheet(item) {
  sheetItem = item;
  $('#sheet-img').src = urlFor(item);
  const cats = $('#sheet-cats');
  cats.replaceChildren();
  for (const [key, label] of Object.entries(CATS)) {
    const b = el('button', item.cat === key ? 'on' : '', label);
    b.onclick = () => changeCategory(item, key);
    cats.append(b);
  }
  $('#sheet').hidden = false;
}

function closeSheet() {
  sheetItem = null;
  $('#sheet').hidden = true;
}

async function changeCategory(item, cat) {
  if (cat === item.cat) return closeSheet();
  const old = item.cat;
  item.cat = cat;
  await db.put(item);
  // forget the item in the old category's selection
  if (state.sel[old] === item.id) state.sel[old] = undefined;
  if (state.picked[old] === item.id) state.picked[old] = undefined;
  state.sel[cat] = item.id;
  closeSheet();
  renderWardrobe();
  toast(`Moved to ${PLURAL[cat]}`);
}

$('#sheet-close').onclick = closeSheet;
document.querySelector('#sheet .sheet-backdrop').onclick = closeSheet;
$('#sheet-touch').onclick = () => {
  const item = sheetItem;
  closeSheet();
  touchUpItem(item);
};
$('#sheet-delete').onclick = async () => {
  const item = sheetItem;
  if (await deleteItem(item)) closeSheet();
};

async function deleteItem(item) {
  const using = state.outfits.filter((o) => Object.values(o.ids).includes(item.id));
  const extra = using.length ? ` It is part of ${using.length} saved outfit${using.length > 1 ? 's' : ''}, which will be deleted too.` : '';
  if (!confirm(`Delete this ${CATS[item.cat].toLowerCase()}?${extra}`)) return false;
  await db.remove(item.id);
  for (const o of using) await db.removeOutfit(o.id);
  state.outfits = state.outfits.filter((o) => !using.includes(o));
  URL.revokeObjectURL(state.urls.get(item.id));
  state.urls.delete(item.id);
  const tight = state.tight.get(item.id);
  if (tight) URL.revokeObjectURL(tight.url);
  state.tight.delete(item.id);
  state.items = state.items.filter((i) => i.id !== item.id);
  if (state.picked[item.cat] === item.id) state.picked[item.cat] = undefined;
  if (state.sel[item.cat] === item.id) state.sel[item.cat] = undefined;
  renderWardrobe();
  return true;
}

async function touchUpItem(item) {
  const edited = await editImage(item.blob);
  if (!edited) return;
  item.blob = await finalize(edited.blob, 0);
  await db.put(item);
  for (const map of [state.urls, state.tight]) {
    const old = map.get(item.id);
    if (old) URL.revokeObjectURL(old.url ?? old);
    map.delete(item.id);
  }
  renderWardrobe();
}

$('#edit-toggle').onclick = () => {
  state.editing = !state.editing;
  renderWardrobe();
};

$('#wardrobe-go').onclick = () => {
  const p = state.picked;
  for (const [cat, id] of Object.entries(p)) if (id) state.sel[cat] = id;
  state.shoes = !!p.shoes;
  state.mode = makeMode(!!p.dress && !p.top && !p.bottom, LAYER_CATS.find((c) => p[c]) ?? null);
  state.picked = {};
  state.complete = false;
  showTab('outfit');
};

/* ---------- Pridanie kúsku ---------- */

function renderAdd() {
  $('#add-start').hidden = !!add.original;
  $('#storage-note').hidden = !!add.original;
  $('#add-review').hidden = !add.original;

  const pick = $('#cat-pick');
  pick.replaceChildren();
  for (const [key, label] of Object.entries(CATS)) {
    const b = el('button', add.cat === key ? 'on' : '', label);
    b.onclick = () => {
      add.cat = key;
      $('#cat-error').hidden = true;
      renderAdd();
    };
    pick.append(b);
  }

  document.querySelectorAll('#source-toggle button').forEach((b) => {
    b.classList.toggle('on', b.dataset.src === add.source);
  });

  const blob = add.source === 'cutout' && add.cutout ? add.cutout : add.original;
  const preview = $('#preview');
  const key = blob ? `${blobId(blob)}:${add.enhance}` : null;
  if (blob && preview.dataset.key !== key) {
    preview.dataset.key = key;
    setPreview(blob, add.enhance);
  }

  $('#retry-cutout').hidden = !add.cutout;
  $('#enhance-pick').value = Math.round(add.enhance * 100);
  $('#enhance-value').textContent = Math.round(add.enhance * 100);
  preview.style.transform = `rotate(${add.rotation}deg)`;
}

let previewToken = 0;

// Shows the photo; with enhancing on, a small copy is processed so the preview stays quick.
async function setPreview(blob, amount) {
  const token = ++previewToken;
  const shown = amount ? await enhance(blob, amount, 600) : blob;
  if (token !== previewToken) return;
  const preview = $('#preview');
  const old = preview.src;
  preview.src = URL.createObjectURL(shown);
  if (old.startsWith('blob:')) URL.revokeObjectURL(old);
}

const blobIds = new WeakMap();
let nextBlobId = 0;
function blobId(blob) {
  if (!blobIds.has(blob)) blobIds.set(blob, String(nextBlobId++));
  return blobIds.get(blob);
}

function setStatus(text) {
  const s = $('#status');
  s.hidden = !text;
  s.textContent = text ?? '';
}

$('#file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;

  // Ak medzitým príde ďalšia fotka, výsledok tejto sa zahodí.
  const token = ++add.token;
  add.busy = true;
  const original = await loadScaled(file);
  if (token !== add.token) return;
  add.original = original;
  add.cutout = null;
  add.source = 'original';
  add.rotation = 0;
  $('#rotate').value = 0;
  renderAdd();
  setStatus('Preparing…');

  try {
    const cutout = await removeBg(original, (text, pct) => {
      if (token === add.token) setStatus(pct == null ? text : `${text} ${pct} %`);
    });
    if (token !== add.token) return;
    add.cutout = cutout;
    add.source = 'cutout';
    setStatus(null);
  } catch (err) {
    if (token !== add.token) return;
    console.error(err);
    setStatus("Couldn't remove the background. You can still save the original photo.");
  }
  add.busy = false;
  renderAdd();
};

document.querySelectorAll('#source-toggle button').forEach((b) => {
  b.onclick = () => {
    if (b.dataset.src === 'cutout' && !add.cutout) return;
    add.source = b.dataset.src;
    renderAdd();
  };
});

// A bigger background-removal model: slower and a larger one-time download, but better on
// difficult photos (busy patterns, items that look like the floor).
$('#retry-cutout').onclick = async () => {
  if (add.busy || !add.original) return;
  const token = add.token;
  const original = add.original;
  add.busy = true;
  setStatus('Preparing…');
  try {
    const cutout = await removeBg(original, (text, pct) => {
      if (token === add.token) setStatus(pct == null ? text : `${text} ${pct} %`);
    }, 'medium');
    if (token !== add.token) return;
    add.cutout = cutout;
    add.source = 'cutout';
    setStatus(null);
  } catch (err) {
    console.error(err);
    if (token === add.token) setStatus("Couldn't run the higher quality cutout. The earlier cutout is still there.");
  }
  if (token === add.token) add.busy = false;
  renderAdd();
};

$('#touch-up').onclick = async () => {
  if (!add.cutout) return toast('The cutout is not ready yet.');
  // The editor starts at the same Enhance value as this screen and hands the chosen value back;
  // the enhancement itself is applied once, when the item is saved.
  const edited = await editImage(add.cutout, { original: add.original, enhanceStart: add.enhance, previewOnly: true });
  if (!edited) return;
  add.cutout = edited.blob;
  add.source = 'cutout';
  add.enhance = edited.enhanceAmount;
  renderAdd();
};

// the slider only reports its position while dragging; the preview is rebuilt shortly after
let enhanceTimer;
$('#enhance-pick').oninput = (e) => {
  $('#enhance-value').textContent = e.target.value;
  clearTimeout(enhanceTimer);
  enhanceTimer = setTimeout(() => {
    add.enhance = Number(e.target.value) / 100;
    renderAdd();
  }, 120);
};

$('#rotate').oninput = (e) => {
  const quarter = Math.round(add.rotation / 90) * 90;
  add.rotation = quarter + Number(e.target.value);
  renderAdd();
};

$('#rotate90').onclick = () => {
  add.rotation += 90;
  renderAdd();
};

function resetAdd() {
  add.token++;
  add.busy = false;
  add.cat = null; // every new item starts without a category, so nothing is saved under the wrong one
  add.enhance = DEFAULT_ENHANCE;
  add.original = null;
  add.cutout = null;
  add.rotation = 0;
  add.source = 'cutout';
  setStatus(null);
}

$('#cancel').onclick = () => {
  resetAdd();
  renderAdd();
};

async function finalizeAndEnhance(source, rotation, amount) {
  const done = await finalize(source, rotation);
  return amount ? enhance(done, amount) : done;
}

$('#save').onclick = async () => {
  if (add.busy) return toast('Hang on, still processing the photo…');
  if (!add.cat) {
    $('#cat-error').hidden = false;
    return;
  }
  const source = add.source === 'cutout' && add.cutout ? add.cutout : add.original;
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    cat: add.cat,
    blob: await finalizeAndEnhance(source, add.rotation, add.enhance),
    created: Date.now(),
  };
  await db.put(item);
  state.items.push(item);
  state.sel[item.cat] = item.id;
  toast(`Saved: ${CATS[item.cat]}`);
  resetAdd();
  renderAdd();
};

/* ---------- Štart ---------- */

function showNotice(text) {
  const n = $('#notice');
  n.textContent = text;
  n.hidden = false;
}

// A new version of the storage cannot be set up while another tab or window of the app is open.
db.onBlocked(() => showNotice('Your closet is updating, but another tab or window with this app is still open. Close it and this page will continue by itself. Your items are safe.'));

try {
  state.items = await db.getAll();
  state.outfits = await db.getOutfits();
  $('#notice').hidden = true;
} catch (err) {
  console.error(err);
  showNotice(`Could not open your closet (${err.name}: ${err.message}). Your items have not been deleted. Reload the page.`);
}
db.askPersist();
showTab(state.items.length ? 'outfit' : 'add');

/* ---------- Updates ---------- */

// A home-screen web app on iPhone has no refresh gesture and keeps old files for a while.
// So the app checks for itself whether a newer version is published (the version is the
// ?v=NN number in index.html) and reloads from the network when there is one.
const RUNNING_VERSION = Number(new URL(import.meta.url).searchParams.get('v')) || 0;

async function latestVersion() {
  try {
    const res = await fetch(`index.html?check=${Date.now()}`, { cache: 'no-store' });
    const match = (await res.text()).match(/app\.js\?v=(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null; // offline: nothing to check
  }
}

function loadVersion(version) {
  // a URL that was never visited cannot come from the cache
  location.replace(`./?u=${version}`);
}

// Inside the About sheet the answer is written under the button (a toast would cover it).
function say(text) {
  if ($('#about').hidden) return toast(text);
  $('#about-status').textContent = text;
}

async function checkForUpdate({ manual = false } = {}) {
  const latest = await latestVersion();
  if (latest && latest > RUNNING_VERSION) {
    if (manual) return showUpdate(latest);
    // at launch: update straight away, unless this page was just loaded by an update
    let tried = null;
    try {
      tried = sessionStorage.getItem('closet.updating');
      sessionStorage.setItem('closet.updating', String(latest));
    } catch {
      // storage unavailable: show the button instead of reloading automatically
      return showUpdate(latest);
    }
    if (tried === String(latest)) return showUpdate(latest);
    return loadVersion(latest);
  }
  if (manual) say(latest ? 'You have the latest version' : "Couldn't check for updates");
}

function showUpdate(version) {
  const bar = $('#update-bar');
  bar.hidden = false;
  $('#update-now').onclick = () => loadVersion(version);
}

document.documentElement.dataset.version = String(RUNNING_VERSION); // not shown to users; handy when debugging
$('#check-update').onclick = () => checkForUpdate({ manual: true });

// About: credits, the storage note and the update check, kept out of the main screens
const openAbout = (open) => {
  $('#about').hidden = !open;
  $('#about-status').textContent = '';
};
$('#about-open').onclick = () => openAbout(true);
$('#about-close').onclick = () => openAbout(false);
document.querySelector('#about .sheet-backdrop').onclick = () => openAbout(false);
// coming back to the app after a while: look for a newer version, but let the user choose when to reload
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  const latest = await latestVersion();
  if (latest && latest > RUNNING_VERSION) showUpdate(latest);
});
checkForUpdate();
