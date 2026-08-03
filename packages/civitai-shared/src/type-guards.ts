export function isDefined<T>(argument: T | undefined | null): argument is T {
  return argument !== undefined && argument !== null;
}
