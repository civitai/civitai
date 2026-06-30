import { describe, it, expect, vi } from 'vitest';

// Unit test for the v1 /api/v1/creators item mapping after switching the
// getCreators select from `models: [...]` (fetch every published model id) to
// Prisma `_count: { models: <published> }` (count in the DB). Asserts modelCount
// is derived from `_count.models` and the historical shape is preserved
// (modelCount omitted when zero).
//
// creators.ts pulls in server-only modules (PublicEndpoint, the tRPC context,
// pagination helpers) just to declare the default handler. Stub them so importing
// the file to reach the pure `mapCreatorItem` helper doesn't drag in the world.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (fn: unknown) => fn,
}));
vi.mock('~/server/createContext', () => ({ publicApiContext2: vi.fn() }));
vi.mock('~/server/utils/pagination-helpers', () => ({ getPaginationLinks: vi.fn() }));
vi.mock('~/server/utils/errorHandling', () => ({ isClientAbortError: () => false }));
// getEdgeUrl reaches into client-only modules (react hooks, providers) at import;
// stub it to a deterministic, inspectable string.
vi.mock('~/client-utils/cf-images-utils', () => ({
  getEdgeUrl: (src: string, opts: { width?: number; name?: string | null }) =>
    `edge:${src}:${opts?.width}:${opts?.name ?? ''}`,
}));

import { mapCreatorItem } from '~/pages/api/v1/creators';

const ORIGIN = 'https://civitai.com';

describe('mapCreatorItem — _count.models → modelCount', () => {
  it('derives modelCount from _count.models', () => {
    const out = mapCreatorItem(
      { username: 'alice', image: 'img-key', _count: { models: 7 } },
      ORIGIN
    );
    expect(out.modelCount).toBe(7);
    expect(out.username).toBe('alice');
    expect(out.link).toBe('https://civitai.com/api/v1/models?username=alice');
    expect(out.image).toBe('edge:img-key:96:alice');
  });

  it('omits modelCount (undefined) when _count.models is 0', () => {
    const out = mapCreatorItem({ username: 'bob', image: null, _count: { models: 0 } }, ORIGIN);
    expect(out.modelCount).toBeUndefined();
  });

  it('omits modelCount when _count is absent', () => {
    const out = mapCreatorItem({ username: 'carol', image: null }, ORIGIN);
    expect(out.modelCount).toBeUndefined();
  });

  it('omits image when there is no image key', () => {
    const out = mapCreatorItem({ username: 'dave', image: null, _count: { models: 3 } }, ORIGIN);
    expect(out.image).toBeUndefined();
    expect(out.modelCount).toBe(3);
  });
});
