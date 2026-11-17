/** Public API: Training Data files carry no metadata, independent of `toApiModelFile`'s narrowing. */
export function publicFileMetadata<M>(type: string, metadata: M): M | Record<string, never> {
  return type === 'Training Data' ? {} : metadata;
}
