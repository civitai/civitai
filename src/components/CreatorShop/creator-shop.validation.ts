import type { AutoCheck } from '~/server/schema/creator-shop.schema';
import {
  MAX_ANIMATION_FPS,
  MAX_ANIMATION_FRAMES,
  MIN_ANIMATION_FRAME_DELAY_MS,
  cosmeticDimensionsLabel,
  cosmeticDimensionsPass,
  cosmeticImageRequirements,
} from '~/server/schema/creator-shop.schema';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { formatBytes } from '~/utils/number-helpers';

export type CosmeticImageValidation = {
  checks: AutoCheck[];
  width: number;
  height: number;
  hasTransparency: boolean;
  allRequiredPassed: boolean;
};

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

// Sample the image alpha channel to decide whether it has a transparent
// background. Downscales first so this stays cheap for large uploads.
function detectTransparency(img: HTMLImageElement, width: number, height: number): boolean {
  const scale = Math.min(1, 128 / Math.max(width, height, 1));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  let transparent = 0;
  const total = w * h;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 16) transparent++;
  return transparent / total > 0.02;
}

// Frame stats for an animated WebP, parsed from the RIFF container's ANMF
// chunks (the browser can't expose frame counts/delays through <img>/canvas).
// Returns null for static or non-WebP files. Mirrors the server's sharp-based
// frame checks in validateArtwork.
async function getWebPAnimationStats(
  file: File
): Promise<{ frames: number; minDelayMs: number } | null> {
  if (file.type !== 'image/webp') return null;
  const buf = new Uint8Array(await file.arrayBuffer());
  const fourcc = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  const u32 = (o: number) =>
    (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0;
  if (buf.length < 12 || fourcc(0) !== 'RIFF' || fourcc(8) !== 'WEBP') return null;

  let frames = 0;
  let minDelayMs = Infinity;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = fourcc(offset);
    const size = u32(offset + 4);
    // ANMF payload: x(3) y(3) w(3) h(3) duration(3, little-endian ms) flags(1)
    if (id === 'ANMF' && offset + 8 + 16 <= buf.length) {
      frames++;
      const d = offset + 8 + 12;
      minDelayMs = Math.min(minDelayMs, buf[d] | (buf[d + 1] << 8) | (buf[d + 2] << 16));
    }
    // Chunks are padded to even sizes.
    offset += 8 + size + (size % 2);
  }
  if (frames <= 1) return null;
  return { frames, minDelayMs: Number.isFinite(minDelayMs) ? minDelayMs : 0 };
}

/**
 * Runs the pre-submit artwork checks a creator sees before they can pay the fee.
 * Returns the per-check results (also persisted to item meta for moderators).
 */
export async function validateCosmeticImage(
  file: File,
  type: CosmeticType,
  maxSize: number
): Promise<CosmeticImageValidation> {
  const req = cosmeticImageRequirements(type);
  const validFormat = file.type === 'image/png' || file.type === 'image/webp';

  let width = 0;
  let height = 0;
  let hasTransparency = false;
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    width = img.naturalWidth;
    height = img.naturalHeight;
    if (validFormat) hasTransparency = detectTransparency(img, width, height);
  } catch {
    // couldn't decode — checks below will report it via dimensions=0
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  const checks: AutoCheck[] = [
    { key: 'format', label: 'PNG or WebP', passed: validFormat },
    {
      key: 'dimensions',
      label: cosmeticDimensionsLabel(req),
      passed: cosmeticDimensionsPass(req, width, height),
      detail: width ? `${width}×${height}px` : 'unreadable',
    },
  ];
  if (req.requireTransparency)
    checks.push({ key: 'transparency', label: 'Transparent background', passed: hasTransparency });
  const animation = validFormat ? await getWebPAnimationStats(file) : null;
  if (animation) {
    checks.push({
      key: 'frameCount',
      label: `At most ${MAX_ANIMATION_FRAMES} frames`,
      passed: animation.frames <= MAX_ANIMATION_FRAMES,
      detail: `${animation.frames} frames`,
    });
    checks.push({
      key: 'frameRate',
      label: `At most ${MAX_ANIMATION_FPS} fps`,
      // A 0ms delay ("as fast as possible") also fails.
      passed: animation.minDelayMs >= MIN_ANIMATION_FRAME_DELAY_MS,
      detail: `~${Math.round(1000 / Math.max(1, animation.minDelayMs))} fps peak`,
    });
  }
  checks.push({
    key: 'size',
    label: `Under ${formatBytes(maxSize)}`,
    passed: file.size <= maxSize,
    detail: formatBytes(file.size),
  });

  return {
    checks,
    width,
    height,
    hasTransparency,
    allRequiredPassed: checks.every((c) => c.passed),
  };
}
