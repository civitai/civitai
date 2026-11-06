import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CacheHelpers from '~/server/utils/cache-helpers';

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: async (_key: string, fetch: () => Promise<unknown>) => fetch(),
  bustFetchThroughCache: vi.fn(async () => undefined),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  manifestOf,
  saveRemixApp,
  type RemixAppRow,
} from '~/server/services/remix-app-registry.service';
import { bustFetchThroughCache } from '~/server/utils/cache-helpers';
import type { RemixAppInput } from '~/shared/remix-apps/row.schema';
import { SEED_REMIX_APPS } from '~/shared/remix-apps/seed';

const pixelArt = SEED_REMIX_APPS.find((app) => app.slug === 'pixel-art')!;
const stored = (input: RemixAppInput, runVersion: number, status = 'remix'): RemixAppRow => ({
  id: 'apb_remix_pixel_art',
  blockId: 'remix-pixel-art',
  version: `${runVersion}.0.0`,
  manifest: manifestOf(input, runVersion),
  status,
  featuredOrder: 5,
});
const written = () =>
  dbMock.dbWrite.appBlock.update.mock.calls.at(-1)![0] as { data: { version: string } };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.oauthClient.findUnique.mockResolvedValue({ id: 'civitai-remix-apps' } as never);
});

describe('saveRemixApp', () => {
  it('keeps the run version for a listing edit, and bumps it when what runs changes', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(stored(pixelArt, 3) as never);
    await saveRemixApp({ ...pixelArt, name: 'Pixels', description: 'Retro' });
    expect(written().data.version).toBe('3.0.0');

    const spec = pixelArt.spec as Extract<RemixAppInput['spec'], { steps: unknown }>;
    await saveRemixApp({
      ...pixelArt,
      spec: { ...spec, steps: [{ ...spec.steps[0], quantity: 2 } as (typeof spec.steps)[0]] },
    });
    expect(written().data.version).toBe('4.0.0');
    expect(bustFetchThroughCache).toHaveBeenCalledTimes(2);
  });

  it('adds a new app disabled and last', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(null);
    dbMock.dbWrite.appBlock.aggregate.mockResolvedValue({ _max: { featuredOrder: 7 } } as never);
    await saveRemixApp({ ...pixelArt, slug: 'comic-it' });
    expect(dbMock.dbWrite.appBlock.create.mock.calls[0][0].data).toMatchObject({
      blockId: 'remix-comic-it',
      appId: 'civitai-remix-apps',
      status: 'remix_disabled',
      featuredOrder: 8,
      version: '1.0.0',
    });
  });

  it('will not take over a block id another app holds', async () => {
    dbMock.dbWrite.appBlock.findUnique.mockResolvedValue(stored(pixelArt, 1, 'approved') as never);
    await expect(saveRemixApp(pixelArt)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(dbMock.dbWrite.appBlock.update).not.toHaveBeenCalled();
  });

  it('refuses to write before the seed migration has made its client', async () => {
    dbMock.dbWrite.oauthClient.findUnique.mockResolvedValue(null);
    await expect(saveRemixApp(pixelArt)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(dbMock.dbWrite.appBlock.create).not.toHaveBeenCalled();
  });
});
