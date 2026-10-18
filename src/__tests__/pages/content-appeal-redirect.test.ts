import { describe, expect, it, vi } from 'vitest';

// The wrapper only plumbs session, flags and SSG into `resolver`; the redirect decision is the
// resolver's, so it is called directly with the flags it would receive.
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: (config: unknown) => config,
}));

type Resolver = (args: {
  ctx: { params: { slug: string[] }; query: Record<string, string> };
  ssg?: { content: { get: { prefetch: () => Promise<void> } } };
  features: { siteAppealForm: boolean };
}) => Promise<unknown>;

const page = (await import('~/pages/content/[[...slug]]')) as unknown as {
  getServerSideProps: { useSession: boolean; resolver: Resolver };
};
const { resolver } = page.getServerSideProps;

const visit = (slug: string, siteAppealForm: boolean, query: Record<string, string> = {}) =>
  resolver({
    ctx: { params: { slug: [slug] }, query: { slug, ...query } },
    ssg: { content: { get: { prefetch: async () => undefined } } },
    features: { siteAppealForm },
  });

describe('/content/content-appeal', () => {
  it('sends a user the on-site form is enabled for there, keeping the deep link', async () => {
    expect(await visit('content-appeal', true, { category: 'Model', id: '5' })).toEqual({
      redirect: { destination: '/appeal?category=Model&id=5', permanent: false },
    });
  });

  it('still serves the old form to everyone else', async () => {
    expect(await visit('content-appeal', false)).toEqual({ props: { slug: ['content-appeal'] } });
  });

  it('leaves every other content page alone', async () => {
    expect(await visit('tos', true)).toEqual({ props: { slug: ['tos'] } });
  });

  // The flag is per user; without the session a client-side navigation would see it off.
  it('resolves the session for the flag', () => {
    expect(page.getServerSideProps.useSession).toBe(true);
  });
});
