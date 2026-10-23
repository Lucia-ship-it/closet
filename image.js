// Photo processing: downscale, remove background, straighten and crop.
const BG_REMOVAL_URL = 'https://esm.sh/@imgly/background-removal@1.4.5';
const MAX_INPUT = 1600; // väčšie fotky sa zmenšia, aby to v mobile nebolo pomalé
const MAX_OUTPUT = 1000;

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toBlob(c, type = 'image/png', quality) {
  return new Promise((resolve) => c.toBlob(resolve, type, quality));
}

export async function loadScaled(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_INPUT / Math.max(bmp.width, bmp.height));
  const c = canvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return toBlob(c, 'image/jpeg', 0.92);
}

let removerPromise;

// onProgress(text, percent) – pri prvom použití sa sťahuje AI model (raz, potom je v pamäti).
export async function removeBg(blob, onProgress) {
  removerPromise ??= import(BG_REMOVAL_URL);
  const { removeBackground } = await removerPromise;
  return removeBackground(blob, {
    model: 'small', // menší model – rýchlejšie stiahnutie a beh v mobile
    output: { format: 'image/png' },
    progress: (key, current, total) => {
      const pct = total ? Math.round((current / total) * 100) : null;
      onProgress(key.startsWith('fetch') ? 'Downloading AI model (first time only)…' : 'Removing background…', pct);
    },
  });
}

// Otočí obrázok, oreže prázdne okraje a vycentruje kúsok s malým okrajom.
export async function finalize(blob, degrees) {
  const bmp = await createImageBitmap(blob);
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const rw = Math.ceil(bmp.width * cos + bmp.height * sin);
  const rh = Math.ceil(bmp.width * sin + bmp.height * cos);

  const rotated = canvas(rw, rh);
  const ctx = rotated.getContext('2d', { willReadFrequently: true });
  ctx.translate(rw / 2, rh / 2);
  ctx.rotate(rad);
  ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  bmp.close?.();

  const box = contentBox(ctx.getImageData(0, 0, rw, rh)) ?? { x: 0, y: 0, w: rw, h: rh };
  const pad = Math.round(Math.max(box.w, box.h) * 0.05);
  const fullW = box.w + pad * 2;
  const fullH = box.h + pad * 2;
  const scale = Math.min(1, MAX_OUTPUT / Math.max(fullW, fullH));

  const out = canvas(Math.round(fullW * scale), Math.round(fullH * scale));
  out.getContext('2d').drawImage(
    rotated, box.x, box.y, box.w, box.h,
    pad * scale, pad * scale, box.w * scale, box.h * scale,
  );
  return toBlob(out);
}

// Finds the rectangle holding the actual garment. Faint leftovers from background removal
// (single stray pixels, soft halos) are ignored: a row or column only counts when enough
// clearly opaque pixels lie in it.
function contentBox({ data, width, height }) {
  const cols = new Uint32Array(width);
  const rows = new Uint32Array(height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 100) {
        cols[x]++;
        rows[y]++;
      }
    }
  }
  const minCol = Math.max(2, Math.round(height * 0.004));
  const minRow = Math.max(2, Math.round(width * 0.004));
  const first = (counts, min) => counts.findIndex((c) => c >= min);
  const last = (counts, min) => counts.length - 1 - [...counts].reverse().findIndex((c) => c >= min);
  const x0 = first(cols, minCol);
  const y0 = first(rows, minRow);
  if (x0 < 0 || y0 < 0) return null;
  const x1 = last(cols, minCol);
  const y1 = last(rows, minRow);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Crops an already saved item to its real content (no empty margins) for the outfit view.
export async function tightCrop(blob) {
  const bmp = await createImageBitmap(blob);
  const probeScale = Math.min(1, 400 / Math.max(bmp.width, bmp.height));
  const probe = canvas(Math.max(1, Math.round(bmp.width * probeScale)), Math.max(1, Math.round(bmp.height * probeScale)));
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(bmp, 0, 0, probe.width, probe.height);
  const box = contentBox(pctx.getImageData(0, 0, probe.width, probe.height))
    ?? { x: 0, y: 0, w: probe.width, h: probe.height };

  const { shoulder, body } = measure(pctx.getImageData(box.x, box.y, box.w, box.h));

  const sx = box.x / probeScale;
  const sy = box.y / probeScale;
  const sw = Math.min(bmp.width - sx, box.w / probeScale);
  const sh = Math.min(bmp.height - sy, box.h / probeScale);
  const outScale = Math.min(1, 800 / Math.max(sw, sh));
  const out = canvas(Math.round(sw * outScale), Math.round(sh * outScale));
  out.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, out.width, out.height);
  bmp.close?.();
  return { blob: await toBlob(out), aspect: out.width / out.height, shoulder, body };
}

// Describes the garment's shape for lining several pieces up:
//  shoulder - where the body starts, as a share of the height (thin straps and hangers don't count),
//  body     - typical width of the garment's lower part, as a share of its full width.
function measure({ data, width, height }) {
  const widths = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let n = 0;
    for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 100) n++;
    widths[y] = n;
  }
  const smooth = widths.map((_, y) => {
    const part = widths.slice(Math.max(0, y - 1), y + 2);
    return part.reduce((a, b) => a + b, 0) / part.length;
  });
  const max = Math.max(...smooth);
  const row = Math.max(0, smooth.findIndex((w) => w >= max * 0.55));
  const lower = [...smooth.slice(Math.floor(row + (height - row) * 0.4), Math.ceil(height * 0.95))].sort((a, b) => a - b);
  const median = lower.length ? lower[Math.floor(lower.length / 2)] : max;
  return { shoulder: row / height, body: Math.max(0.2, median / width) };
}
