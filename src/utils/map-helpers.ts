export function findKeyForValue<K, V>(m: Map<K, V[]>, v: V): K | undefined {
  for (const [k, vs] of m) {
    if (vs.includes(v)) return k;
  }
  return undefined;
}
