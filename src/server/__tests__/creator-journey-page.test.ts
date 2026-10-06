import { describe, expect, it, vi } from 'vitest';

vi.mock('~/server/utils/server-side-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerSideHelpers>()),
  createServerSideProps: (options: unknown) => options,
}));

import type * as ServerSideHelpers from '~/server/utils/server-side-helpers';
import { getServerSideProps } from '~/pages/creators/journey';

type Resolver = (args: {
  session: { user?: { id: number } } | null;
  features: { creatorJourney?: boolean };
  ctx: { resolvedUrl: string };
}) => Promise<unknown>;

const resolve = (getServerSideProps as unknown as { resolver: Resolver }).resolver;
const ctx = { resolvedUrl: '/creators/journey' };

describe('/creators/journey', () => {
  it('is not found while Creator Journey is off for the viewer', async () => {
    expect(
      await resolve({ session: { user: { id: 1 } }, features: { creatorJourney: false }, ctx })
    ).toEqual({ notFound: true });
  });

  it('renders for a signed-in viewer the flag is on for', async () => {
    expect(
      await resolve({ session: { user: { id: 1 } }, features: { creatorJourney: true }, ctx })
    ).toBeUndefined();
  });

  it('still sends a signed-out viewer the flag is on for to log in', async () => {
    expect(await resolve({ session: null, features: { creatorJourney: true }, ctx })).toMatchObject(
      {
        redirect: { permanent: false },
      }
    );
  });
});
