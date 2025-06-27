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

export function getResolutionsFromAspectRatiosMap<
  TResolution extends number = number,
  TAspectRatio extends string = string
>(resolutions: TResolution[], aspectRatios: TAspectRatio[], mod = 16) {
  const map = new Map<TResolution, ResolutionAspectRatios<TAspectRatio>>();
  for (const resolution of resolutions) {
    map.set(resolution, getResolutionsFromAspectRatios(resolution, aspectRatios, mod));
  }
  return map;
}
