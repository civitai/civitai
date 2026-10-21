import { beforeEach, describe, expect, it, vi } from 'vitest';

const { captured, devTunnelEnabled, runnerConfigured, serverEnv } = vi.hoisted(() => ({
  serverEnv: { APP_ASSISTANT_SANDBOX_URL: undefined as string | undefined },
  captured: { fn: null as null | ((c: unknown) => Promise<unknown>) },
  devTunnelEnabled: vi.fn(async () => true),
  runnerConfigured: vi.fn(() => true),
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: (opts: { resolver: (c: unknown) => Promise<unknown> }) => {
    captured.fn = opts.resolver;
    return async () => ({ props: {} });
  },
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksDevTunnelEnabled: devTunnelEnabled,
}));
vi.mock('~/components/Apps/AppAssistant/AppAssistantWorkspace', () => ({
  AppAssistantWorkspace: () => null,
}));
vi.mock('~/env/server', () => ({ env: serverEnv }));
vi.mock('~/server/services/app-assistant/assistant-runner-tokens', () => ({
  isAssistantRunnerConfigured: runnerConfigured,
}));
vi.mock('~/components/Apps/AppsPageLayout', () => ({ AppsPageLayout: () => null }));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));

const page = await import('~/pages/apps/assistant');

const USER = { id: 7, bannedAt: null };
const ON = { appBlocks: true, appAssistant: true };

function ctx() {
  const headers = new Map<string, string>();
  return {
    headers,
    resolvedUrl: '/apps/assistant',
    res: { setHeader: (k: string, v: string) => headers.set(k, v) },
  };
}

async function resolve(features: Record<string, boolean>, user: object | null = USER) {
  const c = ctx();
  const result = await captured.fn!({ features, session: user ? { user } : null, ctx: c });
  return { result, csp: c.headers.get('Content-Security-Policy') };
}

beforeEach(() => {
  devTunnelEnabled.mockResolvedValue(true);
  runnerConfigured.mockReturnValue(true);
  serverEnv.APP_ASSISTANT_SANDBOX_URL = undefined;
});

describe('/apps/assistant getServerSideProps', () => {
  it.each([
    ['no flags', {}],
    ['the feature flag alone', { appAssistant: true }],
    ['the block runtime alone', { appBlocks: true }],
  ])('404s with %s, before looking at the session', async (_label, features) => {
    const { result, csp } = await resolve(features, null);
    expect(result).toEqual({ notFound: true });
    expect(csp).toBeUndefined();
  });

  it('sends a signed-out viewer to log in and back', async () => {
    const { result } = await resolve(ON, null);
    expect(result).toEqual({
      redirect: { destination: '/login?returnUrl=%2Fapps%2Fassistant', permanent: false },
    });
  });

  it('sends a banned user home', async () => {
    const { result } = await resolve(ON, { ...USER, bannedAt: new Date() });
    expect(result).toEqual({ redirect: { destination: '/', permanent: false } });
  });

  it('renders without a route CSP, which would outlive the page in the tab', async () => {
    const { result, csp } = await resolve({ ...ON, appBlocksAuthor: true });
    expect(result).toEqual({
      props: { canPreview: true, sandboxUrl: null, subagents: false, remoteRunner: false },
    });
    expect(csp).toBeUndefined();
  });

  it('offers the preview only to an author with dev tunnels', async () => {
    expect((await resolve(ON)).result).toEqual({
      props: { canPreview: false, sandboxUrl: null, subagents: false, remoteRunner: false },
    });
    devTunnelEnabled.mockResolvedValue(false);
    expect((await resolve({ ...ON, appBlocksAuthor: true })).result).toEqual({
      props: { canPreview: false, sandboxUrl: null, subagents: false, remoteRunner: false },
    });
  });

  it('offers subagents only with their flag', async () => {
    expect((await resolve({ ...ON, appAssistantSubagents: true })).result).toMatchObject({
      props: { subagents: true },
    });
    expect((await resolve(ON)).result).toMatchObject({ props: { subagents: false } });
  });

  it('runs replies on the server only with its flag, and only once the runner and the sandbox service are configured', async () => {
    // No sandbox service: the runner would refuse every start, so the page stays in the browser.
    expect((await resolve({ ...ON, appAssistantRemoteRunner: true })).result).toMatchObject({
      props: { remoteRunner: false },
    });
    serverEnv.APP_ASSISTANT_SANDBOX_URL = 'https://sandbox.example';
    expect((await resolve({ ...ON, appAssistantRemoteRunner: true })).result).toMatchObject({
      props: { remoteRunner: true },
    });
    expect((await resolve(ON)).result).toMatchObject({ props: { remoteRunner: false } });
    runnerConfigured.mockReturnValue(false);
    expect((await resolve({ ...ON, appAssistantRemoteRunner: true })).result).toMatchObject({
      props: { remoteRunner: false },
    });
  });

  it('gates the client render on the same predicate', () => {
    const features = (page.default as { features?: (f: object) => boolean }).features;
    expect(features?.(ON)).toBe(true);
    expect(features?.({ appBlocks: true })).toBe(false);
  });

  it('passes the sandbox service URL from the server env, read at request time', async () => {
    serverEnv.APP_ASSISTANT_SANDBOX_URL = 'https://sandbox.example';
    expect((await resolve(ON)).result).toEqual({
      props: {
        canPreview: false,
        sandboxUrl: 'https://sandbox.example',
        subagents: false,
        remoteRunner: false,
      },
    });
    serverEnv.APP_ASSISTANT_SANDBOX_URL = 'https://other-sandbox.example';
    expect((await resolve(ON)).result).toMatchObject({
      props: { sandboxUrl: 'https://other-sandbox.example' },
    });
  });
});
