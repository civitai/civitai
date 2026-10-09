import { describe, expect, it, vi } from 'vitest';
// Module scope, not a test body: from a body this transform is charged to one test's 60s
// budget. See vitest.config.mts.
import { isTabValue, resolveReviewTab } from '~/pages/apps/review';
import type * as AppBlocksAccess from '~/shared/utils/app-blocks-access';

type Resolver = (c: {
  features: { appBlocks: boolean };
  session: { user: { id: number; isModerator: boolean } };
  ctx: { resolvedUrl: string };
}) => Promise<unknown>;

/**
 * `/apps/review` "App feedback" tab: the deep-link guard and who gets the tab.
 *
 * The SSR resolver is captured from a mocked `createServerSideProps` and run with a page gate
 * (`isAppReviewer`) widened to everyone, so the case this pins — a reviewer who is not a moderator
 * — is reachable even though the two predicates agree today.
 */

const { capturedResolver, reviewerGate } = vi.hoisted(() => ({
  capturedResolver: { fn: null as null | Resolver },
  reviewerGate: { widened: false },
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: (opts: { resolver: Resolver }) => {
    capturedResolver.fn = opts.resolver;
    return async () => ({ props: {} });
  },
}));

vi.mock('~/shared/utils/app-blocks-access', async (importOriginal) => {
  const actual = await importOriginal<typeof AppBlocksAccess>();
  return {
    ...actual,
    isAppReviewer: (user: { isModerator?: boolean } | null) =>
      reviewerGate.widened ? !!user : actual.isAppReviewer(user),
  };
});

const resolve = (isModerator: boolean) =>
  capturedResolver.fn!({
    features: { appBlocks: true },
    session: { user: { id: 1, isModerator } },
    ctx: { resolvedUrl: '/apps/review' },
  });

describe('isTabValue', () => {
  it('accepts every tab, including app-feedback', () => {
    for (const tab of [
      'pending',
      'approved',
      'rejected',
      'reports',
      'manage',
      'sub-listings',
      'app-feedback',
    ])
      expect(isTabValue(tab)).toBe(true);
    expect(isTabValue('feedback')).toBe(false);
    expect(isTabValue(undefined)).toBe(false);
  });
});

describe('resolveReviewTab', () => {
  it('opens app-feedback only for a viewer who has the tab', () => {
    expect(resolveReviewTab('app-feedback', { appFeedback: true })).toBe('app-feedback');
    expect(resolveReviewTab('app-feedback', { appFeedback: false })).toBe('pending');
    expect(resolveReviewTab('sub-listings', { appFeedback: false })).toBe('sub-listings');
    expect(resolveReviewTab(['app-feedback'], { appFeedback: true })).toBe('pending');
    expect(resolveReviewTab('bogus', { appFeedback: true })).toBe('pending');
  });
});

describe('getServerSideProps', () => {
  it('a moderator gets the tab', async () => {
    reviewerGate.widened = false;
    expect(await resolve(true)).toStrictEqual({ props: { canMonitorAppFeedback: true } });
  });

  it('a reviewer who is not a moderator gets the page but not the tab', async () => {
    reviewerGate.widened = true;
    expect(await resolve(false)).toStrictEqual({ props: { canMonitorAppFeedback: false } });
    reviewerGate.widened = false;
  });

  it('control: with the gate as it is, a non-moderator gets no page at all', async () => {
    reviewerGate.widened = false;
    expect(await resolve(false)).toStrictEqual({ notFound: true });
  });
});
