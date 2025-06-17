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
