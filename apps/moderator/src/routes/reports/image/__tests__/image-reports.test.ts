import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/reports/image` is the image queues' reported view under the Reports section: what it loads, which
 * of the image queues' verbs it takes, and that the old `/images/reported` lands on it.
 */

const loadImageQueue = vi.fn(async (view: string) => ({ view, kind: 'reported', items: [] }));
const verb = () => vi.fn();
const imageQueueActions = {
  accept: verb(),
  block: verb(),
  dismissFlag: verb(),
  resolveAppeal: verb(),
  setRating: verb(),
  setFlag: verb(),
  unpublishModel3d: verb(),
  bulkAccept: verb(),
  bulkBlock: verb(),
  bulkResolveAppeal: verb(),
};
vi.mock('$lib/server/image-queue', () => ({ loadImageQueue, imageQueueActions }));
const removePlacement = verb();
vi.mock('$lib/server/sticker-placement-actions', () => ({
  stickerPlacementActions: { removePlacement },
}));
const verbs = { ...imageQueueActions, removePlacement };
vi.mock('$lib/server/access', () => ({ denied: (id: string) => `needs ${id}` }));

const { load, actions } = await import('../+page.server');
const { load: imagesLoad } = await import('../../../images/[slug]/+page.server');

const url = (path: string) => new URL(`https://mod.example${path}`);

beforeEach(() => vi.clearAllMocks());

describe('/reports/image', () => {
  it('loads the reported view of the image queue', async () => {
    const data = await load({
      url: url('/reports/image?level=1'),
      locals: { user: { id: 1 }, grants: { 'image.moderate': true } },
    } as never);
    expect(loadImageQueue).toHaveBeenCalledWith('reported', expect.any(URL));
    expect(data).toMatchObject({ kind: 'reported', title: 'Image reports', canAct: true });
  });

  // The reported card's verbs plus the sticker removal, and not the review-flag or appeal ones this
  // queue never posts.
  it("takes the reported card's verbs and the sticker removal, nothing else", () => {
    expect(Object.keys(actions).sort()).toEqual(
      [
        'accept',
        'block',
        'bulkAccept',
        'bulkBlock',
        'removePlacement',
        'setFlag',
        'setRating',
        'unpublishModel3d',
      ].sort()
    );
  });
});

// Reaching the queue is the shared Reports grant; its writes remove images and settle escrow, so they
// need the `image.moderate` action grant, as every page making those writes does. Without it the verb
// is never reached.
describe('acting on /reports/image', () => {
  const event = (held: boolean) =>
    ({ locals: { user: { id: 1 }, grants: held ? { 'image.moderate': true } : {} } } as never);

  it.each([
    'accept',
    'block',
    'bulkAccept',
    'bulkBlock',
    'removePlacement',
    'setFlag',
    'setRating',
    'unpublishModel3d',
  ] as const)('%s needs image.moderate', async (name) => {
    const result = (await actions[name](event(false))) as {
      status: number;
      data: { error: string };
    };
    expect(result.status).toBe(403);
    expect(result.data.error).toBe('needs image.moderate');

    expect(verbs[name]).not.toHaveBeenCalled();
    await actions[name](event(true));
    expect(verbs[name]).toHaveBeenCalledTimes(1);
  });

  it('says it is read-only to a viewer without image.moderate', async () => {
    const data = await load({
      url: url('/reports/image'),
      locals: { user: { id: 1 }, grants: {} },
    } as never);
    expect(data).toMatchObject({ canAct: false });
  });
});

describe('/images/reported', () => {
  // `$lib/moved-pages.ts` redirects it before any route runs; the route refusing it is the backstop.
  it('is not served by the image queues any more', async () => {
    await expect(
      imagesLoad({ params: { slug: 'reported' }, url: url('/images/reported') } as never)
    ).rejects.toMatchObject({ status: 404 });
    expect(loadImageQueue).not.toHaveBeenCalled();
  });

  it('still serves the other image queues', async () => {
    await imagesLoad({ params: { slug: 'minor' }, url: url('/images/minor') } as never);
    expect(loadImageQueue).toHaveBeenCalledWith('minor', expect.any(URL));
  });
});
