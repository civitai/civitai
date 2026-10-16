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
vi.mock('$lib/server/sticker-placement-actions', () => ({
  stickerPlacementActions: { removePlacement: verb() },
}));
const canAccess = vi.fn(() => true);
vi.mock('$lib/server/access', () => ({ canAccess }));

const { load, actions } = await import('../+page.server');
const { load: imagesLoad } = await import('../../../images/[slug]/+page.server');

const url = (path: string) => new URL(`https://mod.example${path}`);

beforeEach(() => vi.clearAllMocks());

describe('/reports/image', () => {
  it('loads the reported view of the image queue', async () => {
    const data = await load({
      url: url('/reports/image?level=1'),
      locals: { user: { id: 1 } },
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

// Reaching the queue is the shared Reports grant; its writes remove images and settle escrow, so
// they need `/users`, as the user and post queues' do. Without it the verb is never reached.
describe('acting on /reports/image', () => {
  const event = { locals: { user: { id: 1 } } } as never;

  it.each([
    'accept',
    'block',
    'bulkAccept',
    'bulkBlock',
    'removePlacement',
    'setFlag',
    'setRating',
    'unpublishModel3d',
  ] as const)('%s needs /users', async (name) => {
    canAccess.mockReturnValue(false);
    const result = (await actions[name](event)) as { status: number };
    expect(result.status).toBe(403);
    expect(canAccess).toHaveBeenCalledWith({ id: 1 }, '/users');

    canAccess.mockReturnValue(true);
    await actions[name](event);
  });

  it('says it is read-only to a viewer without /users', async () => {
    canAccess.mockReturnValue(false);
    const data = await load({ url: url('/reports/image'), locals: { user: { id: 1 } } } as never);
    expect(data).toMatchObject({ canAct: false });
    canAccess.mockReturnValue(true);
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
