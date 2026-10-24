// Turns an image URL into a Jev image asset: fetched by the extension (host permissions skip CORS),
// re-encoded as a baseline JPEG (WebP, PNG, GIF frames all end up JPEG) with both sides in Jev's
// 280-1568 px range. Jev rejects out-of-range images instead of resizing them.

export const MIN_SIDE = 280;
export const MAX_SIDE = 1568;
const TARGET_LONG = 768; // big enough to read a thumbnail, small enough to stay fast and cheap

export async function imageAsset(url, { timeoutMs = 8000 } = {}) {
  const res = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`image fetch ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  const { width, height, sx, sy, sw, sh } = fit(bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // flatten transparency; JPEG has no alpha
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
  bitmap.close();
  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return {
    ref: `img-${crypto.randomUUID()}`,
    asset: { type: 'image', format: 'jpg', data_base64: toBase64(await jpeg.arrayBuffer()) },
    width,
    height,
  };
}

// Source crop and output size. Extreme aspect ratios are center-cropped so both sides fit the range.
export function fit(w, h) {
  let sx = 0;
  let sy = 0;
  let sw = w;
  let sh = h;
  const maxRatio = MAX_SIDE / MIN_SIDE;
  if (sw / sh > maxRatio) {
    sw = Math.floor(sh * maxRatio);
    sx = Math.floor((w - sw) / 2);
  } else if (sh / sw > maxRatio) {
    sh = Math.floor(sw * maxRatio);
    sy = Math.floor((h - sh) / 2);
  }
  let scale = Math.min(1, TARGET_LONG / Math.max(sw, sh));
  if (Math.min(sw, sh) * scale < MIN_SIDE) scale = MIN_SIDE / Math.min(sw, sh);
  const clamp = (v) => Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(v)));
  return { width: clamp(sw * scale), height: clamp(sh * scale), sx, sy, sw, sh };
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
