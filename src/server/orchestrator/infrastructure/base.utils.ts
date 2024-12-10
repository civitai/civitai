export function unsupportedEnhancementType(type: string) {
  return new Error(`unsupported ${type} enhancement type`);
}
