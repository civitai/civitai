import { describe, expect, it, vi } from 'vitest';

// The wrapper only plumbs session and flags into `resolver`; the redirect decision is the
// resolver's, so it is called directly with what it would receive for a signed-out visitor.
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: (config: unknown) => config,
}));

type Resolver = (args: {
  session: null;
  features: { imageGeneration: boolean };
  ctx: { req: { url: string } };
}) => Promise<unknown>;

const page = (await import('~/pages/generate/index')) as unknown as {
  getServerSideProps: { resolver: Resolver };
};

const visit = (imageGeneration: boolean) =>
  page.getServerSideProps.resolver({
    session: null,
    features: { imageGeneration },
    ctx: { req: { url: '/generate?modelVersionId=3405360&resolution=2k&thinkingMode=ultra' } },
  });

describe('/generate for a signed-out visitor', () => {
  it('renders the page, with no redirect to login', async () => {
    expect(await visit(true)).toBeUndefined();
  });

  it('is still a 404 where image generation is off', async () => {
    expect(await visit(false)).toEqual({ notFound: true });
  });
});
