import type { AutoCheck } from '~/server/schema/creator-shop.schema';
import { cosmeticImageRequirements } from '~/server/schema/creator-shop.schema';
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
      label: req.exact ? `${req.width}×${req.height}px` : `At least ${req.width}×${req.height}px`,
      passed: req.exact
        ? width === req.width && height === req.height
        : width >= req.width && height >= req.height,
      detail: width ? `${width}×${height}px` : 'unreadable',
    },
  ];
  if (req.requireTransparency)
    checks.push({ key: 'transparency', label: 'Transparent background', passed: hasTransparency });
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
