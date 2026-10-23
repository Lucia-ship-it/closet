// A light, cheap photo clean-up done with plain canvas maths (no AI model, no extra download):
//  1. evens out uneven lighting and soft shadows across the garment,
//  2. stretches the contrast a little so colours look less flat,
//  3. adds a touch of colour.
// It never touches transparent pixels, and it does not iron out creases.
const GRID = 64; // lighting is measured on a coarse grid, which keeps this fast and light on memory
const RADIUS = 7; // in grid cells: shadows wider than this get evened out, fine detail stays

// amount: 0..1. maxSide (optional) shrinks the image first, used for quick previews.
export async function enhance(blob, amount, maxSide) {
  const bmp = await createImageBitmap(blob);
  const k = maxSide ? Math.min(1, maxSide / Math.max(bmp.width, bmp.height)) : 1;
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const lum = (i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

  /* 1. even out the lighting */
  const gw = Math.max(2, Math.min(GRID, w));
  const gh = Math.max(2, Math.min(GRID, h));
  let num = new Float32Array(gw * gh);
  let den = new Float32Array(gw * gh);
  let totalNum = 0;
  let totalDen = 0;
  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1, Math.floor((y * gh) / h));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = d[i + 3] / 255;
      if (a < 0.5) continue;
      const g = gy * gw + Math.min(gw - 1, Math.floor((x * gw) / w));
      const l = lum(i);
      num[g] += l;
      den[g] += 1;
      totalNum += l;
      totalDen += 1;
    }
  }
  if (!totalDen) return blob; // nothing visible to work on

  // blur numerator and denominator separately, so empty (transparent) cells do not darken the edges
  num = boxBlur(num, gw, gh, RADIUS);
  den = boxBlur(den, gw, gh, RADIUS);
  const mean = totalNum / totalDen;
  const strength = 0.65 * amount;

  const hist = new Uint32Array(256);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1, (y * gh) / h);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] < 128) continue;
      const g = Math.min(gh - 1, Math.floor(fy)) * gw + Math.min(gw - 1, Math.floor((x * gw) / w));
      const local = den[g] > 0.01 ? num[g] / den[g] : mean;
      const gain = Math.min(1.45, Math.max(0.75, Math.pow(mean / Math.max(local, 12), strength)));
      d[i] = Math.min(255, d[i] * gain);
      d[i + 1] = Math.min(255, d[i + 1] * gain);
      d[i + 2] = Math.min(255, d[i + 2] * gain);
      hist[Math.round(lum(i))]++;
    }
  }

  /* 2. gentle contrast boost, based on the 2nd and 98th percentile of brightness */
  let seen = 0;
  const total = hist.reduce((a, b) => a + b, 0);
  let lo = 0;
  let hi = 255;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen >= total * 0.02) { lo = v; break; }
  }
  seen = 0;
  for (let v = 255; v >= 0; v--) {
    seen += hist[v];
    if (seen >= total * 0.02) { hi = v; break; }
  }
  // contrast grows around the middle tone, which also moves a little towards a pleasant brightness
  const mid = (lo + hi) / 2;
  const stretch = 1 + (Math.min(1.4, Math.max(1, 220 / Math.max(40, hi - lo))) - 1) * amount;
  const midTarget = mid + (150 - mid) * 0.35 * amount;
  const sat = 1 + 0.25 * amount;

  /* 3. apply the contrast and a touch of colour */
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    for (let c = 0; c < 3; c++) d[i + c] = (d[i + c] - mid) * stretch + midTarget;
    const l = lum(i);
    for (let c = 0; c < 3; c++) {
      d[i + c] = Math.min(255, Math.max(0, l + (d[i + c] - l) * sat)); // Uint8ClampedArray rounds for us
    }
  }

  ctx.putImageData(img, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

// Two passes of a box blur in each direction (a cheap, smooth approximation of a Gaussian).
function boxBlur(src, w, h, r) {
  let a = src;
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) sum += a[y * w + xx];
        }
        tmp[y * w + x] = sum;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let dy = -r; dy <= r; dy++) {
          const yy = y + dy;
          if (yy >= 0 && yy < h) sum += tmp[yy * w + x];
        }
        out[y * w + x] = sum;
      }
    }
    a = out;
  }
  return a;
}
