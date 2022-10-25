export function isDefined<T>(argument: T | undefined): argument is T {
  return argument !== undefined;
}
