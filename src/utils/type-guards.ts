export function isDefined<T>(argument: T | undefined): argument is T {
  return argument !== undefined;
}

export function isNumber(value: unknown) {
  return isNaN(Number(value)) === false;
}
