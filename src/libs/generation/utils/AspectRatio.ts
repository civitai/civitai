import { maxResolution, minResolution } from '~/libs/generation/utils/constants';

const gcd = (a: number, b: number): number => (a ? gcd(b % a, a) : b);

function findClosest(array: number[], target: number) {
  return array.reduce((a, b) => {
    return Math.abs(b - target) < Math.abs(a - target) ? b : a;
  });
}

function findClosestIndex(array: number[], target: number) {
  const closest = findClosest(array, target);
  return array.indexOf(closest);
}

function parseAspectRatio(value: string) {
  const regex = new RegExp(/(\d+:\d+)/);
  const validated = regex.test(value);
  if (!validated) return null;
  const match = regex.exec(value);
  return match?.[0] ?? null;
}

const getOptions = (options?: AspectRatioOptions) => ({ ...defaultOptions, ...options });

const defaultOptions = {
  min: minResolution,
  max: maxResolution,
  multiplier: 64,
} satisfies AspectRatioOptions;

function getAspectRatioFromSize(
  { width, height }: { width: number; height: number },
  options?: AspectRatioOptions
) {
  const { multiplier } = getOptions(options);
  const [w, h] = [width, height].map((val) => {
    const offset = val % multiplier;
    return val - offset;
  });
  const d = gcd(w, h);
  return AspectRatio(`${w / d}:${h / d}`, options);
}

type AspectRatioOptions = { min?: number; max?: number; multiplier?: number };

export type AspectRatio = typeof AspectRatio;
export function AspectRatio(aspectRatio: string, options?: AspectRatioOptions) {
  const { min = minResolution, max = maxResolution, multiplier = 64 } = getOptions(options);
  const { rw, rh, direction, ratio } = getSizeFromAspectRatioString(aspectRatio);
  const sizes = new Map<number, { width: number; height: number }>();

  function getSizeFromAspectRatioString(aspectRatio: string) {
    const match = parseAspectRatio(aspectRatio);
    if (!match) throw new Error('invalid aspect ratio syntax');
    const [rw, rh] = match.split(':').map(Number);
    const ratio = rw / rh;
    const direction = ratio < 1 ? 'portrait' : 'landscape';
    return {
      rw,
      rh,
      ratio,
      direction,
    };
  }

  function getMaxSize(resolution: number) {
    return Math.ceil(direction === 'landscape' ? resolution * (rw / rh) : resolution * (rh / rw));
  }

  function getMinSize(resolution: number) {
    const min = Math.ceil(
      direction === 'landscape' ? resolution * (rh / rw) : resolution * (rw / rh)
    );
    const offset = min % multiplier;
    return min - offset;
  }

  function getSizeOptions(resolution: number) {
    const options: number[] = [];
    const maxr = Math.min(resolution, max);
    const minr = Math.max(resolution, min);
    const maxSize = Math.min(getMaxSize(maxr), max);
    const minSize = Math.max(getMinSize(minr), min);
    for (let i = minSize; i <= maxSize; i += multiplier) {
      options.push(i);
    }
    return options;
  }

  function getSize(resolution: number) {
    const size = sizes.get(resolution);
    if (size) return size;
    const matches: { width: number; height: number; pixels: number }[] = [];
    const pixels = resolution * resolution;
    const options = getSizeOptions(resolution);

    let lastIndex = 0;
    width: for (const width of options) {
      for (let i = lastIndex; i < options.length; i++) {
        const height = options[i];
        const r = width / height;
        if (r === ratio) {
          const optionPixels = width * height;
          matches.push({ width, height, pixels: optionPixels });
          lastIndex = i + 1;
          if (optionPixels >= pixels) break width;
          break;
        } else if (direction === 'landscape' && r < 1) break;
      }
    }
    // TODO - handle empty matches array (larger multipliers are more likely have missing matches)
    if (!matches.length)
      throw new Error(
        `could not find an aspect ratio that matches the given resolution: ${resolution}`
      );
    const closestIndex = findClosestIndex(
      matches.map((x) => x.pixels),
      pixels
    );
    const match = matches[closestIndex];
    const newSize = { width: match.width, height: match.height };
    sizes.set(resolution, newSize);
    return newSize;
  }

  function getSize2(resolution: number) {
    const res = resolution - (resolution % multiplier);
    const computed = direction === 'landscape' ? res * (rw / rh) : res * (rh / rw);
    const computedOffset = computed % multiplier;
    const width = direction === 'landscape' ? computed - computedOffset : res;
    const height = direction === 'landscape' ? res : computed - computedOffset;
    return {
      width,
      height,
    };
  }

  return {
    direction,
    ratio,
    getSize,
    getSize2,
  };
}

AspectRatio.parse = parseAspectRatio;
AspectRatio.fromSize = getAspectRatioFromSize;

export function AspectRatioMap<T extends string>(aspectRatios: T[], options?: AspectRatioOptions) {
  return aspectRatios.reduce(
    (acc, key) => ({ ...acc, [key]: AspectRatio(key, options) }),
    {}
  ) as Record<T, ReturnType<typeof AspectRatio>>;
}
