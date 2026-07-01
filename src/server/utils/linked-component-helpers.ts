// A linked component whose source ModelFile (settings.fileId) has been deleted
// must not surface on public reads — otherwise consumers see a component that
// 404s on download. `liveFileIds` is the set of fileIds still present in the DB.
export function selectLiveLinkedComponents<T extends { fileId?: number | null }>(
  components: T[],
  liveFileIds: Set<number>
): T[] {
  return components.filter((c) => c.fileId != null && liveFileIds.has(c.fileId));
}
