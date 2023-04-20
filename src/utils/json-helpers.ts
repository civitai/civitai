export function toJson(obj: any) {
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'bigint') return value.toString() + 'n';
    return value;
  });
}

export function fromJson(str: string) {
  return JSON.parse(str, (key, value) => {
    if (typeof value === 'string' && /^\d+n$/.test(value)) return BigInt(value.slice(0, -1));
    return value;
  });
}
