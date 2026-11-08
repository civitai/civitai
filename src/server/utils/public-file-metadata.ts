/** A file's metadata as the public API sends it: a training dataset's is sent empty, as the
 *  site's own file lists do. */
export function publicFileMetadata<M>(type: string, metadata: M): M | Record<string, never> {
  return type === 'Training Data' ? {} : metadata;
}
