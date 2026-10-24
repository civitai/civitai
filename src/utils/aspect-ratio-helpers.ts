/** greatest common denominator */
const gcd = (a: number, b: number): number => (a ? gcd(b % a, a) : b);

/** lowest common multiple */
const lcm = (a: number, b: number): number => (a * b) / gcd(a, b);

/** get the ration of two numbers using their greatest common denominator */
export function getRatio(a: number, b: number) {
  const c = gcd(a, b);
  return [a / c, b / c].join(':');
}

type AspectRatio = { width: number; height: number } | `${number}:${number}`;
export function findClosestAspectRatio<TSource extends AspectRatio, TCompare extends AspectRatio>(
  source: TSource,
  comparisonArr: TCompare[]
) {
  const sourceRatio = getRatioFromAspectRatio(source);
  const ratioArr = comparisonArr.map(getRatioFromAspectRatio);
  const closest = findClosest(ratioArr, sourceRatio);
  const index = ratioArr.indexOf(closest);
  return comparisonArr[index];
}

/**
 * Width/height for an image-to-video request: the source image's own framing,
 * snapped to the nearest entry the ecosystem supports.
 *
 * The snap is the point. A user's upload can be any size, and passing those
 * dimensions through means an ecosystem generating video at whatever an arbitrary
 * image happens to be — outside the resolutions its weights were trained for, and
 * outside any constraint the backend expects (e.g. a multiple of 32). Nearest
 * supported entry keeps the framing the user chose without the extremes.
 *
 * Falls back to an explicit selection, then to the first supported entry, for the
 * workflows where the same branch also serves text-to-video.
 */
export function resolveImageDimensions<TOption extends { width: number; height: number }>(
  image: { width?: number; height?: number } | undefined,
  supported: TOption[],
  fallback?: { width: number; height: number }
): { width: number; height: number } {
  if (image?.width && image?.height) {
    const match = findClosestAspectRatio({ width: image.width, height: image.height }, supported);
    if (match) return { width: match.width, height: match.height };
  }
  return {
    width: fallback?.width ?? supported[0].width,
    height: fallback?.height ?? supported[0].height,
  };
}

function getSizeFromAspectRatio(value: AspectRatio) {
  if (typeof value === 'string') {
    const [width, height] = value.split(':').map(Number);
    return { width, height };
  } else return value;
}

function getRatioFromAspectRatio(value: AspectRatio) {
  const { width, height } = getSizeFromAspectRatio(value);
  return width / height;
}

function findClosest(array: number[], target: number) {
  return array.reduce((a, b) => {
    return Math.abs(b - target) < Math.abs(a - target) ? b : a;
  });
}

type ResolutionAspectRatios<T extends string> = Record<T, [width: number, height: number]>;
/**
 *
 * @param resolution ie. 480, 720
 * @param aspectRatios ie: ['16:9', '3:2', '1:1', '2:3', '9:16']
 * @param mod
 * @returns
 */
export function getResolutionsFromAspectRatios<T extends string>(
  resolution: number,
  aspectRatios: T[],
  mod = 16
): ResolutionAspectRatios<T> {
  return aspectRatios.reduce<ResolutionAspectRatios<T>>((acc, ar) => {
    const [w, h] = ar.split(':').map(Number);
    if (isNaN(w) || isNaN(h)) throw new Error('invalid aspectRatios format');
    const landscape = w >= h;
    let upper = landscape ? Math.round((resolution * w) / h) : Math.round((resolution * h) / w);
    const diff = upper % mod;
    if (diff > 0) upper -= diff;
    return { ...acc, [ar]: landscape ? [upper, resolution] : [resolution, upper] };
  }, {} as ResolutionAspectRatios<T>);
}

export function getResolutionsFromAspectRatiosMap<TAspectRatio extends string = string>(
  resolutions: number[],
  aspectRatios: TAspectRatio[],
  mod = 16
) {
  const map = new Map<number, ResolutionAspectRatios<TAspectRatio>>();
  for (const resolution of resolutions) {
    map.set(resolution, getResolutionsFromAspectRatios(resolution, aspectRatios, mod));
  }
  return map;
}

/**
 * What a custom width × height may be for one ecosystem. The engine's own limits
 * (`[Range]` / `[DivisibleBy]` on its input class in civitai-orchestration) are the
 * outer bound; `maxArea` and `maxRatio` are tighter, quality-driven caps — a model
 * trained at ~1MP falls apart well before its engine refuses the size.
 */
export type CustomDimensionLimits = {
  /** Every side is a multiple of this. */
  step: number;
  minSide: number;
  maxSide: number;
  /** width × height ceiling, enforced. */
  maxArea: number;
  /**
   * width × height above which the picker warns but still allows: the model's
   * training area, past which most checkpoints start to degrade. Not enforced.
   */
  recommendedArea: number;
  /** Longest side ÷ shortest side ceiling, e.g. 2.5 allows 1600×640. */
  maxRatio: number;
};

/**
 * One megapixel, as the generator counts it: 1024² px, not 10⁶. So the buckets
 * (≈1024²) read as 1 MP and 2048² — the ceiling no image may pass — reads as 4.
 */
export const MEGAPIXEL = 1024 * 1024;

/**
 * Bring a requested width × height inside `limits`, keeping its shape as far as the
 * limits allow: cap the ratio, scale down to the area ceiling, clamp each side,
 * then snap to the step. Rounding can only move a side toward the allowed range,
 * never out of it. Returns undefined for a non-positive or non-numeric request.
 */
export function fitCustomDimensions(
  requested: { width: number; height: number },
  limits: CustomDimensionLimits
): { width: number; height: number } | undefined {
  let { width, height } = requested;
  if (!(width > 0) || !(height > 0) || !isFinite(width) || !isFinite(height)) return undefined;
  const { step, minSide, maxSide, maxArea, maxRatio } = limits;

  // Ratio first: shorten the long side, which also shrinks the area.
  if (width / height > maxRatio) width = height * maxRatio;
  else if (height / width > maxRatio) height = width * maxRatio;

  const area = width * height;
  if (area > maxArea) {
    const scale = Math.sqrt(maxArea / area);
    width *= scale;
    height *= scale;
  }

  // A long side past maxSide shrinks BOTH sides: clamping it alone below would turn
  // 2752 × 1536 (16:9) into 2048 × 1536 (4:3) rather than 2048 × 1152.
  const longest = Math.max(width, height);
  if (longest > maxSide) {
    width *= maxSide / longest;
    height *= maxSide / longest;
  }

  const snap = (side: number) =>
    Math.min(maxSide, Math.max(minSide, Math.round(side / step) * step));
  width = snap(width);
  height = snap(height);

  // Rounding up may have nudged past the area or ratio ceiling: step the long side down.
  const fits = () =>
    width * height <= maxArea && Math.max(width, height) / Math.min(width, height) <= maxRatio;
  while (!fits() && Math.max(width, height) - step >= minSide) {
    if (width >= height) width -= step;
    else height -= step;
  }
  return { width, height };
}
