// Small-sample-honest statistics for experiment readouts. Normal approximations throughout, so
// read nothing into an arm with fewer than ~30 users or fewer than ~5 successes.

const Z95 = 1.959963984540054;

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 erf, |error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(x) / Math.SQRT2));
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

const twoSidedP = (z: number) => 2 * (1 - normalCdf(Math.abs(z)));

export type Interval = { low: number; high: number };

export function wilson(successes: number, n: number): Interval {
  if (n === 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export type Comparison = { diff: number; ci: Interval; p: number };

/** Treatment minus control. p from the pooled z-test; CI from the unpooled standard error. */
export function twoProportion(
  control: { successes: number; n: number },
  treatment: { successes: number; n: number }
): Comparison {
  const p1 = control.successes / control.n;
  const p2 = treatment.successes / treatment.n;
  const diff = p2 - p1;
  const pooled = (control.successes + treatment.successes) / (control.n + treatment.n);
  const sePooled = Math.sqrt(pooled * (1 - pooled) * (1 / control.n + 1 / treatment.n));
  const se = Math.sqrt((p1 * (1 - p1)) / control.n + (p2 * (1 - p2)) / treatment.n);
  return {
    diff,
    ci: { low: diff - Z95 * se, high: diff + Z95 * se },
    p: sePooled === 0 ? 1 : twoSidedP(diff / sePooled),
  };
}

export type Moments = { n: number; mean: number; variance: number };

export function moments(values: readonly number[]): Moments {
  const n = values.length;
  if (n === 0) return { n, mean: 0, variance: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n < 2 ? 0 : values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1);
  return { n, mean, variance };
}

/** Treatment minus control means, Welch standard error, normal reference (large n). */
export function welch(control: Moments, treatment: Moments): Comparison {
  const diff = treatment.mean - control.mean;
  const se = Math.sqrt(control.variance / control.n + treatment.variance / treatment.n);
  return {
    diff,
    ci: { low: diff - Z95 * se, high: diff + Z95 * se },
    p: se === 0 ? (diff === 0 ? 1 : 0) : twoSidedP(diff / se),
  };
}

function logGamma(x: number): number {
  const c = [
    76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155,
    0.00120865097386618, -0.000005395239384953,
  ];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.00000000019001;
  for (const ci of c) ser += ci / ++y;
  return -tmp + Math.log((Math.sqrt(2 * Math.PI) * ser) / x);
}

/** Upper regularized incomplete gamma Q(a, x). */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const gln = logGamma(a);
  if (x < a + 1) {
    let sum = 1 / a;
    let del = sum;
    for (let ap = a, i = 0; i < 500; i++) {
      del *= x / ++ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  let b = x + 1 - a;
  let c = 1e300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

export function chiSquareP(statistic: number, df: number): number {
  return gammaQ(df / 2, statistic / 2);
}

/** Sample-ratio mismatch: observed users per arm against the configured split (shares sum to 1). */
export function sampleRatio(observed: readonly number[], shares: readonly number[]) {
  const total = observed.reduce((a, b) => a + b, 0);
  const statistic = observed.reduce((acc, o, i) => {
    const expected = total * shares[i];
    return expected === 0 ? acc : acc + (o - expected) ** 2 / expected;
  }, 0);
  return { statistic, p: chiSquareP(statistic, observed.length - 1) };
}
