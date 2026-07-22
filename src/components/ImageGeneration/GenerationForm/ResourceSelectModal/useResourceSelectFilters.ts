export type Tabs = 'all' | 'official' | 'featured' | 'recent' | 'liked' | 'mine';

// The Official/Mine tabs let a creator link any of their own / the official
// component models regardless of base-model match (e.g. a VAE shared across SDXL
// variants). Used to relax the constraint in the client-side version filter;
// mirrors the same predicate in the server picker service.
export function skipBaseModelForOwnTabs(tab: Tabs | undefined, selectSource?: string): boolean {
  return (tab === 'mine' || tab === 'official') && selectSource === 'modelVersion';
}
