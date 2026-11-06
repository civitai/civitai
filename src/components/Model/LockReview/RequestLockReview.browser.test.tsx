import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import type * as DialogStore from '~/components/Dialog/dialogStore';
import type * as TrpcModule from '~/utils/trpc';

const OWNER = 82;

const mocks = vi.hoisted(() => ({
  user: null as { id: number; isModerator?: boolean } | null,
  state: null as unknown,
  queried: [] as { enabled?: boolean }[],
  trigger: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));
vi.mock('~/components/Dialog/dialogStore', async (importOriginal) => ({
  ...(await importOriginal<typeof DialogStore>()),
  dialogStore: { trigger: mocks.trigger },
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'report.getLockReviewState': {
      useQuery: (_input: unknown, opts: { enabled?: boolean }) => {
        mocks.queried.push(opts);
        return { data: opts.enabled ? mocks.state : undefined, isLoading: false };
      },
    },
  }),
}));

const { RequestLockReviewLink } = await import('./RequestLockReview');

/** Renders beside a sentinel, so an absence is asserted only after the render has landed. */
const renderLink = async (lockedProperties: string[]) => {
  renderWithProviders(
    <>
      <span>rendered</span>
      <RequestLockReviewLink model={model(lockedProperties)} />
    </>
  );
  await expect.element(page.getByText('rendered')).toBeVisible();
};

const model = (lockedProperties: string[]) => ({ id: 71, user: { id: OWNER }, lockedProperties });
const open = { requestable: ['nsfw'], pending: false, reopensAt: null };

beforeEach(() => {
  mocks.user = { id: OWNER };
  mocks.state = open;
  mocks.queried = [];
  mocks.trigger.mockReset();
});

describe('Request review, beside a locked setting', () => {
  test('opens the request form for the owner', async () => {
    renderWithProviders(<RequestLockReviewLink model={model(['nsfw'])} />);

    await page.getByRole('button', { name: 'Request review' }).click();
    expect(mocks.trigger).toHaveBeenCalledWith(expect.objectContaining({ props: { modelId: 71 } }));
  });

  test('is not shown when the only locks cannot be requested', async () => {
    await renderLink(['poi', 'minor']);

    expect(page.getByRole('button').elements()).toHaveLength(0);
    expect(mocks.queried.every((opts) => !opts.enabled)).toBe(true);
  });

  test('is not shown while a real-person or minor lock is set, whatever else is locked', async () => {
    await renderLink(['poi', 'nsfw', 'sfwOnly']);

    expect(page.getByRole('button').elements()).toHaveLength(0);
    expect(mocks.queried.every((opts) => !opts.enabled)).toBe(true);
  });

  test.each([['poi'], ['minor']])(
    'is not shown on a model its owner marked %s, though only nsfw is locked',
    async (flag) => {
      renderWithProviders(
        <>
          <span>rendered</span>
          <RequestLockReviewLink model={{ ...model(['nsfw']), [flag]: true }} />
        </>
      );
      await expect.element(page.getByText('rendered')).toBeVisible();

      expect(page.getByRole('button').elements()).toHaveLength(0);
      expect(mocks.queried.every((opts) => !opts.enabled)).toBe(true);
    }
  );

  test('is shown for any requestable lock', async () => {
    renderWithProviders(<RequestLockReviewLink model={model(['category'])} />);

    await expect.element(page.getByRole('button', { name: 'Request review' })).toBeVisible();
  });

  test('is not shown to someone else', async () => {
    mocks.user = { id: OWNER + 1 };
    await renderLink(['nsfw']);
    expect(page.getByRole('button').elements()).toHaveLength(0);
  });

  test('is not shown to a moderator, who can change the setting directly', async () => {
    mocks.user = { id: OWNER, isModerator: true };
    await renderLink(['nsfw']);
    expect(page.getByRole('button').elements()).toHaveLength(0);
  });

  test('says a request is open instead of offering another', async () => {
    mocks.state = { ...open, pending: true };
    renderWithProviders(<RequestLockReviewLink model={model(['nsfw'])} />);

    await expect.element(page.getByText('Review requested', { exact: true })).toBeVisible();
    expect(page.getByRole('button').elements()).toHaveLength(0);
  });

  test('says when it can be asked again, during a cooldown', async () => {
    mocks.state = { ...open, reopensAt: new Date('2026-11-20T12:00:00Z') };
    renderWithProviders(<RequestLockReviewLink model={model(['nsfw'])} />);

    const label = page.getByText('Review requested recently');
    await expect.element(label).toBeVisible();
    await label.hover();
    await expect.element(page.getByText(/You can ask again on Nov 20, 2026/)).toBeVisible();
    expect(page.getByRole('button').elements()).toHaveLength(0);
  });
});
