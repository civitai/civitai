export function isDefined<T>(argument: T | undefined | null): argument is T {
  return argument !== undefined && argument !== null;
}

export function isNumber(value: unknown) {
  return isNaN(Number(value)) === false;
}

export function isPromise(value: unknown): value is Promise<unknown> {
  return value instanceof Promise;
}

export function isValidURL(value: unknown): value is string {
  try {
    new URL(value as string);
    return true;
  } catch {
    return false;
  }
}
