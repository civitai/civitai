// Listed rather than read off `Date.prototype`, which a test's fake Date replaces.
const DATE_SETTERS = [
  'setDate',
  'setFullYear',
  'setHours',
  'setMilliseconds',
  'setMinutes',
  'setMonth',
  'setSeconds',
  'setTime',
  'setUTCDate',
  'setUTCFullYear',
  'setUTCHours',
  'setUTCMilliseconds',
  'setUTCMinutes',
  'setUTCMonth',
  'setUTCSeconds',
  'setYear',
];
const MAP_WRITERS = ['set', 'delete', 'clear'];
const SET_WRITERS = ['add', 'delete', 'clear'];

function blockWriters(target: object, names: string[], kind: string) {
  for (const name of names) {
    Object.defineProperty(target, name, {
      value: () => {
        throw new TypeError(`Cannot call ${kind}.prototype.${name} on frozen render state`);
      },
    });
  }
}

/**
 * Deep-freeze a value graph so an in-place write throws a TypeError (strict mode) instead of
 * changing an object something else still holds. `Object.freeze` alone does not stop a Date's
 * setters or a Map's / Set's mutators, so those get own throwing methods first. Shared references
 * and cycles are frozen once. Typed arrays and ArrayBuffers cannot be frozen and are left writable.
 * Returns the same value.
 */
export function freezeRenderState<T>(value: T): T {
  const seen = new WeakSet<object>();
  const stack: unknown[] = [value];
  while (stack.length) {
    const node = stack.pop();
    // Functions are never data, and one can reach a shared constructor (a fake Date's own
    // `constructor` is the global Date), so the walk does not enter them.
    if (node === null || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);
    if (ArrayBuffer.isView(node) || node instanceof ArrayBuffer) continue;

    // An object frozen elsewhere can still hold writable children; it only skips the blocking.
    const frozen = Object.isFrozen(node);
    if (node instanceof Date) {
      if (!frozen) blockWriters(node, DATE_SETTERS, 'Date');
    } else if (node instanceof Map) {
      for (const [key, entry] of node) stack.push(key, entry);
      if (!frozen) blockWriters(node, MAP_WRITERS, 'Map');
    } else if (node instanceof Set) {
      for (const entry of node) stack.push(entry);
      if (!frozen) blockWriters(node, SET_WRITERS, 'Set');
    }
    for (const key of Reflect.ownKeys(node)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (descriptor && 'value' in descriptor) stack.push(descriptor.value);
    }
    if (!frozen) Object.freeze(node);
  }
  return value;
}

/**
 * Freeze the handed-over SSR state everywhere but a production server: in dev and tests always,
 * and on a production build (a PR preview) when `SSR_TRPCSTATE_FREEZE=1`. Never by default in
 * production — it costs a full walk per render and would turn a latent mutation into a 500.
 */
export function shouldFreezeRenderState() {
  return process.env.NODE_ENV !== 'production' || process.env.SSR_TRPCSTATE_FREEZE === '1';
}
