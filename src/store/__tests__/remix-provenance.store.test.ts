import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The unit project runs in `node`, so there is no `sessionStorage`. Installed
 * before the store module is imported because `persist` resolves its storage at
 * module scope. A real in-memory implementation rather than a no-op: a stub that
 * silently dropped writes would let a broken `transfer` pass here.
 */
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  },
});

const { remixProvenanceStore, useRemixProvenanceStore } = await import(
  '~/store/remix-provenance.store'
);

const SEEDED = 'https://image.civitai.com/abc/original=true/foo.jpeg';
const UPLOADED = 'https://orchestration-new.civitai.com/v2/consumer/blobs/xyz.jpg?sig=a';

beforeEach(() => {
  remixProvenanceStore.clearAll();
});

describe('remixProvenanceStore', () => {
  it('reads back a token by the url it was minted against', () => {
    remixProvenanceStore.setToken(SEEDED, 'tok');

    expect(remixProvenanceStore.getToken(SEEDED)).toBe('tok');
    expect(remixProvenanceStore.getToken(UPLOADED)).toBeUndefined();
  });

  /**
   * The move this store exists for. `uploadOrchestratorImage` replaces an on-site
   * url with a fresh orchestrator blob, and without the transfer the token is
   * stranded on a url that is no longer in the form — which is exactly how a
   * remix reached submit with its provenance already gone.
   */
  it('follows the image across the re-upload', () => {
    remixProvenanceStore.setToken(SEEDED, 'tok');

    remixProvenanceStore.transfer(SEEDED, UPLOADED);

    expect(remixProvenanceStore.getToken(UPLOADED)).toBe('tok');
    expect(remixProvenanceStore.getToken(SEEDED)).toBeUndefined();
  });

  /**
   * Asserts the KEY SET, not just `getToken`. Dropping the `!existing` guard
   * writes `{ [toUrl]: undefined }` — which reads back as undefined through
   * `?.token`, so a `getToken` assertion passes over it, while the valueless key
   * eats a slot against the cap and then throws in the eviction sort.
   */
  it('does nothing when there is no token to move', () => {
    remixProvenanceStore.setToken(SEEDED, 'tok');

    remixProvenanceStore.transfer('https://example.com/other.jpeg', UPLOADED);

    expect(Object.keys(useRemixProvenanceStore.getState().tokensByUrl)).toEqual([SEEDED]);
    expect(remixProvenanceStore.getToken(SEEDED)).toBe('tok');
  });

  /**
   * The cap is what stops a long session filling sessionStorage.
   *
   * Scope, stated because the name would otherwise overclaim: 60 writes in a
   * loop share a millisecond, so `storedAt` ties and this rides insertion order.
   * It pins that the cap evicts and that the newest write survives — it does NOT
   * exercise age ordering, and setting `storedAt` to a constant still passes.
   */
  it('evicts past the cap and keeps the newest write', () => {
    for (let i = 0; i < 60; i++) remixProvenanceStore.setToken(`url-${i}`, `tok-${i}`);

    expect(remixProvenanceStore.getToken('url-59')).toBe('tok-59');
    expect(remixProvenanceStore.getToken('url-0')).toBeUndefined();
  });
});
