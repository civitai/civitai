type HumanizeListOptions = {
  separator?: string;
  lastSeparator?: string;
};

export function humanizeList(arr: any[], options?: HumanizeListOptions): string {
  if (!Array.isArray(arr))
    throw new TypeError('Expected an array, but got a non-array value ' + arr + '.');

  options = { separator: ', ', lastSeparator: ', and ', ...options };
  if (arr.length === 0) return '';
  if (arr.length === 1) return arr[0];

  return arr.slice(0, -1).join(options.separator) + options.lastSeparator + arr[arr.length - 1];
}
