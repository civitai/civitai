import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

/**
 * `/moderator/app-access-requests` MOVED: the queue is now the "Access requests" tab on
 * `/apps/review`, and the old route is a temporary redirect there so bookmarks keep working.
 *
 * The expected URL is a LITERAL, not the shared constant the page and the nav both read — a test
 * that imported the constant would pass whatever it said, including a tab value `/apps/review`
 * does not parse (which lands the moderator on Pending). That the tab value opens the queue is
 * pinned on the page side, in `src/tests/pages/apps/review/review-queue-nav.browser.test.tsx`.
 *
 * Lives under `src/tests/` (NOT co-located under `src/pages/`) — Next treats every file under
 * `pages/` as a route needing a default export.
 */

const NEW_HOME = '/apps/review?tab=access-requests';

const { captured } = vi.hoisted(() => ({
  captured: {
    opts: null as null | {
      requireModerator?: boolean;
      resolver?: (c: unknown) => Promise<unknown>;
    },
  },
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: (opts: typeof captured.opts) => {
    captured.opts = opts;
    return async () => ({ props: {} });
  },
}));

await import('~/pages/moderator/app-access-requests');

describe('/moderator/app-access-requests', () => {
  it('still requires a moderator before it redirects (non-mods keep the old refusal)', () => {
    expect(captured.opts?.requireModerator).toBe(true);
  });

  it('redirects, non-permanently, to the Access requests tab on /apps/review', async () => {
    const resolver = captured.opts?.resolver;
    expect(resolver).toBeTypeOf('function');
    expect(await resolver!({})).toEqual({
      redirect: { destination: NEW_HOME, permanent: false },
    });
  });
});

describe('the moderation nav entry', () => {
  const navSource = fs.readFileSync(
    path.resolve(__dirname, '../../../components/Moderation/ModerationNav.tsx'),
    'utf-8'
  );

  it('no longer links the old route (which would now cost a redirect hop)', () => {
    expect(navSource).not.toContain('/moderator/app-access-requests');
  });

  it('still has an App Access Requests entry, pointed at the shared new-home constant', () => {
    // The nav reads the href from the constant rather than a literal, so check both ends: the
    // entry exists and uses the constant, and the constant says what this file pins.
    expect(navSource).toMatch(
      /\{\s*label:\s*'App Access Requests',\s*href:\s*APP_ACCESS_REQUESTS_REVIEW_HREF\s*\}/
    );
  });

  it('the shared constant is the new home', async () => {
    const constants = (await import('~/shared/constants/app-access-request.constants')) as Record<
      string,
      unknown
    >;
    expect(constants.APP_ACCESS_REQUESTS_REVIEW_HREF).toBe(NEW_HOME);
  });
});
