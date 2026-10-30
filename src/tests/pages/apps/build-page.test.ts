import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/apps/build` `getServerSideProps` — what each viewer gets from the ONE build page.
 *
 * The page hosts the build states (pitch / first app / workbench) AND, since `/apps/assistant`
 * 301s here, the App Assistant workspace. Every expectation below is a literal outcome for a named
 * viewer, not a call back into the predicates under test, so a change to either gate shows up as a
 * changed row.
 */

const { captured, devTunnelEnabled, runnerConfigured, serverEnv, setHeader } = vi.hoisted(() => ({
  serverEnv: { APP_ASSISTANT_SANDBOX_URL: undefined as string | undefined },
  captured: { fn: null as null | ((c: unknown) => Promise<unknown>) },
  devTunnelEnabled: vi.fn(async () => true),
  runnerConfigured: vi.fn(() => true),
  setHeader: vi.fn(),
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
vi.mock('~/components/Apps/AppsBuildBody', () => ({ AppsBuildBody: () => null }));
vi.mock('~/components/AppLayout/AppLayout', () => ({ AppLayout: () => null }));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));

await import('~/pages/apps/build');

type User = { id: number; isModerator: boolean; bannedAt: Date | null };
const MEMBER: User = { id: 7, isModerator: false, bannedAt: null };
const MODERATOR: User = { id: 3, isModerator: true, bannedAt: null };
const BANNED: User = { id: 9, isModerator: false, bannedAt: new Date('2026-09-01T00:00:00Z') };

const ASSISTANT = { appBlocks: true, appAssistant: true };

const NOT_FOUND = { notFound: true };
const BUILD = { props: { mode: 'build' } };
const ASSISTANT_PROPS = {
  props: {
    mode: 'assistant',
    canPreview: false,
    sandboxUrl: null,
    subagents: false,
    remoteRunner: false,
  },
};

async function resolve(features: Record<string, boolean>, user: User | null) {
  return captured.fn!({ features, session: user ? { user } : null, ctx: { res: { setHeader } } });
}

beforeEach(() => {
  setHeader.mockClear();
  devTunnelEnabled.mockResolvedValue(true);
  runnerConfigured.mockReturnValue(true);
  serverEnv.APP_ASSISTANT_SANDBOX_URL = undefined;
});

describe('/apps/build — the page each viewer gets', () => {
  // [flags, signed out, member, moderator]
  it.each([
    ['no flags', {}, NOT_FOUND, NOT_FOUND, NOT_FOUND],
    ['the store alone', { appListings: true }, NOT_FOUND, NOT_FOUND, BUILD],
    ['store + get-started', { appListings: true, appBlocksGetStarted: true }, BUILD, BUILD, BUILD],
    // The author flag is evaluated PER VIEWER, so a resolved `true` admits whoever it was resolved
    // for — signed out included. (A signed-out viewer does not hold it in practice.)
    ['store + author', { appListings: true, appBlocksAuthor: true }, BUILD, BUILD, BUILD],
    [
      'get-started WITHOUT the store',
      { appBlocksGetStarted: true },
      NOT_FOUND,
      NOT_FOUND,
      NOT_FOUND,
    ],
    [
      'the assistant flag without the runtime',
      { appAssistant: true },
      NOT_FOUND,
      NOT_FOUND,
      NOT_FOUND,
    ],
    ['the runtime without the assistant flag', { appBlocks: true }, NOT_FOUND, NOT_FOUND, BUILD],
    // Signed out with only the assistant flags is unreachable in production (the flag's only
    // rollouts are segments an anonymous context cannot match); it is a plain 404 here.
    ['the assistant', ASSISTANT, NOT_FOUND, ASSISTANT_PROPS, ASSISTANT_PROPS],
    [
      'the assistant + get-started',
      { ...ASSISTANT, appBlocksGetStarted: true },
      BUILD,
      ASSISTANT_PROPS,
      ASSISTANT_PROPS,
    ],
  ])('%s → anon / member / moderator', async (_label, features, anon, member, mod) => {
    expect(await resolve(features, null)).toEqual(anon);
    expect(await resolve(features, MEMBER)).toEqual(member);
    expect(await resolve(features, MODERATOR)).toEqual(mod);
  });

  it('sends a banned account home instead of into the assistant', async () => {
    expect(await resolve(ASSISTANT, BANNED)).toEqual({
      redirect: { destination: '/', permanent: false },
    });
  });
});

describe('/apps/build — the assistant view’s props', () => {
  /**
   * No route CSP: a header CSP persists across the tab's client-side navigations and would block
   * payment and captcha frames on later pages.
   */
  it('sets no response header for the assistant view', async () => {
    const remote = { ...ASSISTANT, appAssistantRemoteRunner: true, appBlocksAuthor: true };
    serverEnv.APP_ASSISTANT_SANDBOX_URL = 'https://sandbox.example';
    expect(await resolve(remote, MEMBER)).toMatchObject({ props: { mode: 'assistant' } });
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('offers the preview only to an author with dev tunnels', async () => {
    expect(await resolve({ ...ASSISTANT, appBlocksAuthor: true }, MEMBER)).toMatchObject({
      props: { canPreview: true },
    });
    expect(await resolve(ASSISTANT, MEMBER)).toMatchObject({ props: { canPreview: false } });
    devTunnelEnabled.mockResolvedValue(false);
    expect(await resolve({ ...ASSISTANT, appBlocksAuthor: true }, MEMBER)).toMatchObject({
      props: { canPreview: false },
    });
  });

  it('offers subagents only with their flag', async () => {
    expect(await resolve({ ...ASSISTANT, appAssistantSubagents: true }, MEMBER)).toMatchObject({
      props: { subagents: true },
    });
    expect(await resolve(ASSISTANT, MEMBER)).toMatchObject({ props: { subagents: false } });
  });

  it('runs replies on the server only with its flag, and only once the runner and the sandbox service are configured', async () => {
    const remote = { ...ASSISTANT, appAssistantRemoteRunner: true };
    expect(await resolve(remote, MEMBER)).toMatchObject({ props: { remoteRunner: false } });
    serverEnv.APP_ASSISTANT_SANDBOX_URL = 'https://sandbox.example';
    expect(await resolve(remote, MEMBER)).toMatchObject({ props: { remoteRunner: true } });
    expect(await resolve(ASSISTANT, MEMBER)).toMatchObject({ props: { remoteRunner: false } });
    runnerConfigured.mockReturnValue(false);
    expect(await resolve(remote, MEMBER)).toMatchObject({ props: { remoteRunner: false } });
  });

  it('passes the sandbox service URL from the server env, read at request time', async () => {
    serverEnv.APP_ASSISTANT_SANDBOX_URL = 'https://sandbox.example';
    expect(await resolve(ASSISTANT, MEMBER)).toMatchObject({
      props: { sandboxUrl: 'https://sandbox.example' },
    });
    serverEnv.APP_ASSISTANT_SANDBOX_URL = 'https://other-sandbox.example';
    expect(await resolve(ASSISTANT, MEMBER)).toMatchObject({
      props: { sandboxUrl: 'https://other-sandbox.example' },
    });
  });
});
