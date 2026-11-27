/** A song's title: `Image.metadata.title` when it is a non-blank string. */
export function songTitle(metadata: unknown) {
  const title = (metadata as { title?: unknown } | null)?.title;
  return typeof title === 'string' && title.trim() ? title : undefined;
}
