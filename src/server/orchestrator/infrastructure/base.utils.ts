export function unsupportedGenerationType(type: string) {
  return new Error(`unsupported ${type} enhancement type`);
}
