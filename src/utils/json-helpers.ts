export function toJson(obj: any) {
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'bigint') return value.toString() + 'n';
    return value;
  });
}

export function fromJson<T extends object>(str: string) {
  try {
    return JSON.parse(str, (key, value) => {
      if (typeof value === 'string' && /^\d+n$/.test(value)) return BigInt(value.slice(0, -1));
      return value;
    }) as T;
  } catch (e) {
    return null;
  }
}

export function calculateSizeInBytes(obj: any) {
  const jsonString = JSON.stringify(obj);
  const encoded = new Blob([jsonString]);

  return encoded.size;
}

export function calculateSizeInMegabytes(obj: any) {
  const sizeInBytes = calculateSizeInBytes(obj);
  return sizeInBytes / 1024 ** 2;
}
