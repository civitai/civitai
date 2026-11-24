import { describe, expect, it, vi } from 'vitest';
import { envMock } from '~/__tests__/mocks/env.mock';

// The wrapper only plumbs session and flags into `resolver`, so it is called directly.
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: (config: unknown) => config,
}));

type Resolver = (args: {
  session: null;
  features: { featurePages: boolean };
  ctx: { query: { slug: string }; req: { headers: Record<string, string> }; res: unknown };
}) => Promise<unknown>;

const page = (await import('~/pages/features/[slug]')) as unknown as {
  getServerSideProps: { resolver: Resolver };
};

describe('/features/[slug]', () => {
  it('is served private and never stored, so no shared cache can hand it to another viewer', async () => {
    vi.stubEnv('AUTH_JWT_ISSUER', 'https://auth.example.com');
    envMock.set({
      FEATURE_PAGES_EMBED_URL: 'https://features.example.com/feature.html',
      FEATURE_PAGES_SIGNER_URL: 'https://signer.example.com',
      FEATURE_PAGES_CLIENT_ID: 'client-id',
      FEATURE_PAGES_CLIENT_SECRET: 'client-secret',
    });
    const setHeader = vi.fn();

    const result = await page.getServerSideProps.resolver({
      session: null,
      features: { featurePages: true },
      ctx: {
        query: { slug: 'dark-mode' },
        req: { headers: { host: 'civitai.com' } },
        res: { setHeader },
      },
    });

    expect(result).toMatchObject({ props: { feature: expect.any(String) } });
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });
});
