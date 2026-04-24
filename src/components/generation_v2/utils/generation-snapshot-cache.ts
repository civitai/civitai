/**
 * Module-level cache of the latest generation graph snapshot.
 *
 * Populated by GenerationFormProvider via a graph subscription. Readers (e.g.
 * QueueItem's civitai.red CTAs) can consume it to build cross-domain handoff
 * URLs without needing to live inside the DataGraphProvider subtree.
 *
 * Why: on mobile the form and the queue live on separate tabs, and switching
 * to the queue unmounts the provider. The cache survives unmount so the last
 * known form state can still be shipped into the handoff URL.
 *
 * Semantics: last-writer-wins. Only one V2 GenerationFormProvider is ever
 * mounted at a time, so there's no contention in practice.
 */

interface CachedGenerationSnapshot {
  snapshot: Record<string, unknown>;
  computedKeys: string[];
}

let cached: CachedGenerationSnapshot | null = null;

export function setGenerationSnapshotCache(value: CachedGenerationSnapshot) {
  cached = value;
}

export function getGenerationSnapshotCache(): CachedGenerationSnapshot | null {
  return cached;
}
