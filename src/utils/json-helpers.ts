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

export function calculateSizeInBytes(obj: any) {
  const jsonString = JSON.stringify(obj, null, 2);
  const encoded = new Blob([jsonString]);

  return encoded.size;
}

export function calculateSizeInMegabytes(obj: any) {
  const sizeInBytes = calculateSizeInBytes(obj);
  return sizeInBytes / 1024 ** 2;
}
