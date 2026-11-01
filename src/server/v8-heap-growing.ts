import v8 from 'node:v8';

const ENV_NAME = 'V8_HEAP_GROWING_PERCENT';
const MIN_PERCENT = 1;
const MAX_PERCENT = 400;

// `--heap-growing-percent` is rejected in NODE_OPTIONS, so it can only be set at runtime. It
// raises how far old space may grow before the next mark-compact, trading RSS for fewer major GCs.
export function applyHeapGrowingPercent(
  raw: string | undefined = process.env[ENV_NAME],
  setFlags: (flags: string) => void = v8.setFlagsFromString
): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const percent = Number(raw);
  if (percent < MIN_PERCENT || percent > MAX_PERCENT) return undefined;

  setFlags(`--heap-growing-percent=${percent}`);
  console.log(`[v8-heap-growing] applied --heap-growing-percent=${percent} from ${ENV_NAME}`);
  return percent;
}
