/**
 * Failure text for selftests that compare values read from a spawned env. That env carries the
 * daemon's own process.env, so printing a value can print a credential: this names keys, types
 * and lengths, never a string's content.
 */

const isObject = (v) => v !== null && typeof v === 'object';

function shape(v) {
  if (v === undefined || v === null || typeof v === 'boolean' || typeof v === 'number')
    return String(v);
  if (isObject(v)) return `an object of ${Object.keys(v).length} keys`;
  return `a ${typeof v} of ${String(v).length} chars`;
}

export function redactedMismatch(actual, expected) {
  if (isObject(actual) && isObject(expected)) {
    const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])]
      .filter((k) => actual[k] !== expected[k])
      .sort();
    return keys.length
      ? `values differ at keys: ${keys.join(', ')}`
      : 'same keys and values, but a different object';
  }
  return `expected ${shape(expected)}, got ${shape(actual)}`;
}
