import { isDefined } from '~/utils/type-guards';

export function parseNumericString(value: unknown) {
  return typeof value === 'string'
    ? parseInt(value, 10)
    : typeof value === 'number'
    ? value
    : undefined;
}

export function parseNumericStringArray(value: unknown) {
  const parsed = Array.isArray(value)
    ? value.map(parseNumericString)
    : typeof value === 'string' || typeof value === 'number'
    ? [parseNumericString(value)]
    : undefined;
  return parsed ? parsed.filter(isDefined) : undefined;
}
