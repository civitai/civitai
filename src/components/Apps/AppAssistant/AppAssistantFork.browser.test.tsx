import Router from 'next/router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ModalsProvider } from '@mantine/modals';
import type * as TrpcMod from '~/utils/trpc';
import type * as TokenMod from '~/components/Apps/AppAssistant/assistantToken';
import type { Sandbox, SandboxSeed } from '~/components/Apps/AppAssistant/sandboxClient';
import {
  SandboxApiError,
  SandboxSeedNotAppliedError,
} from '~/components/Apps/AppAssistant/sandboxClient';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

/**
 * FORKABLE APPS, PR 3 — App Assistant opened on a fork (`/apps/build?fork=<slug>`), through the
 * REAL `AppAssistantWorkspace`.
 *
 * Claims: the page creates the app WITH THE SEED OBJECT the fork session holds (before any reply),
 * opens a NEW chat on it, and shows "Forked from {parent}. Set it up and preview?"; Set up sends the
 * one fixed message, once, and only once the app runs with its tools. An app that already exists
 * is opened instead. Every refusal shows its whole sentence, with Try again exactly where a fresh
 * fork can help — which starts one (deleting an empty `seed_lost` app first).
 *
 * The sandbox list, the chat element and tRPC are fakes; the seed's wire format is pinned in
 * `__tests__/sandboxClient.test.ts`.
 */

const BASE = 'https://sandbox.fork.test';
const FORK_SLUG = 'pixel-garden-fork-5e6f';
const NEXT_SLUG = 'pixel-garden-fork-7c8d';
const PARENT_LISTING = 'apl_parent_ws_9201';
const SEED: SandboxSeed = {
  url: 'https://seeds.fork.test/fork-seeds/pixel-garden-fork-5e6f/aa.zip',
  sha256: 'f'.repeat(64),
  bytes: 2048,
};
const SESSION = {
  forkSlug: FORK_SLUG,
  parentName: 'Pixel Garden',
  parentListingId: PARENT_LISTING,
  seed: SEED,
};
const SETUP_MESSAGE =
  'Set up this forked app: install its dependencies, start the dev server and check the preview.';

const sandbox = (name: string, overrides: Partial<Sandbox> = {}): Sandbox => ({
  name,
  app: FORK_SLUG,
  state: 'running',
  mcpUrl: `${BASE}/s/${name}/mcp`,
  createdAt: null,
  lastActivityAt: null,
  expiresAt: null,
  ...overrides,
});

const m = vi.hoisted(() => ({
  chat: null as null | {
    onBeforeSend?: (text: string, queue: () => unknown) => void;
    onReady?: () => void;
    chatRef?: { current: unknown };
  },
  list: [] as Sandbox[],
  session: undefined as unknown,
  seedCalls: [] as Array<{ app: string; seed: SandboxSeed }>,
  seedResult: null as null | { sandbox: Sandbox } | { error: unknown },
  removed: [] as string[],
  starts: [] as unknown[],
  sent: [] as string[],
  newChat: vi.fn(),
  refetches: 0,
  /** What the service's list holds by the time the page re-reads it (made meanwhile). */
  afterRefetch: null as null | Sandbox[],
}));

vi.mock('~/components/Apps/AppAssistant/AppAssistantChat', async () => {
  const { useEffect, useLayoutEffect } = await import('react');
  return {
    AppAssistantChat: (props: NonNullable<typeof m.chat>) => {
      m.chat = props;
      useLayoutEffect(() => {
        if (!props.chatRef) return;
        props.chatRef.current = {
          newChat: m.newChat,
          send: async (text: string) => {
            m.chat?.onBeforeSend?.(text, () => ({
              release: () => undefined,
              cancel: () => undefined,
            }));
            m.sent.push(text);
          },
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        };
      });
      useEffect(() => {
        props.onReady?.();
      }, [props]);
      return <div data-testid="chat" />;
    },
  };
});
vi.mock('~/components/Apps/AppAssistant/AppAssistantPreview', () => ({
  AppAssistantPreview: () => <div data-testid="preview" />,
}));
vi.mock('~/components/Apps/AppAssistant/useSandboxes', () => ({
  useSandboxes: (client: unknown) => ({
    list: {
      data: client ? m.list : undefined,
      refetch: async () => {
        m.refetches++;
        if (m.afterRefetch) m.list = m.afterRefetch;
        return { isError: false, data: m.list };
      },
      isSuccess: !!client,
      isLoading: false,
      error: null,
    },
    open: { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null },
    seed: {
      mutate: (
        args: { app: string; seed: SandboxSeed },
        opts: { onSuccess?: (r: { sandbox: Sandbox }) => void; onError?: (e: unknown) => void }
      ) => {
        m.seedCalls.push(args);
        const result = m.seedResult;
        setTimeout(() => {
          if (result && 'sandbox' in result) {
            m.list = [...m.list, result.sandbox];
            opts.onSuccess?.(result);
          } else if (result) opts.onError?.(result.error);
        }, 0);
      },
      isPending: false,
      error: null,
    },
    suspend: { mutate: vi.fn(), isPending: false, error: null },
    remove: {
      mutate: (name: string, opts?: { onSuccess?: () => void }) => {
        m.removed.push(name);
        m.list = m.list.filter((s) => s.name !== name);
        opts?.onSuccess?.();
      },
      isPending: false,
      error: null,
    },
  }),
}));
vi.mock('~/components/Apps/AppAssistant/assistantToken', async (importOriginal) => ({
  ...(await importOriginal<typeof TokenMod>()),
  createAssistantTokenProvider: () => ({
    getToken: async () => 'sandbox-token',
    enable: async () => 'chat-token',
  }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'appListings.getForkSession': {
      useQuery: (input: { forkSlug: string }, opts?: { enabled?: boolean }) =>
        opts?.enabled
          ? {
              data: input.forkSlug === FORK_SLUG ? m.session : null,
              isFetched: true,
              isSuccess: true,
            }
          : { data: undefined, isFetched: false, isSuccess: false },
    },
    'appListings.startFork': {
      useMutation: (opts?: { onSuccess?: (data: unknown, vars: unknown) => unknown }) => ({
        mutate: (input: unknown) => {
          m.starts.push(input);
          void opts?.onSuccess?.({ forkSlug: NEXT_SLUG }, input);
        },
        isPending: false,
      }),
    },
  }),
}));

const { AppAssistantWorkspace } = await import('./AppAssistantWorkspace');

const router = Router as unknown as {
  query: Record<string, unknown>;
  pathname: string;
  push: ReturnType<typeof vi.fn>;
  replace: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
  await page.viewport(1440, 900);
  m.list = [];
  m.session = SESSION;
  m.seedCalls = [];
  m.seedResult = { sandbox: sandbox('sbx-fork00000001') };
  m.removed = [];
  m.starts = [];
  m.sent = [];
  m.refetches = 0;
  m.afterRefetch = null;
  m.newChat.mockClear();
  router.query = { fork: FORK_SLUG };
  router.pathname = '/apps/build';
  router.push.mockClear();
  router.replace.mockClear();
});

afterEach(() => {
  router.query = {};
});

async function mount() {
  await renderWithProviders(
    <ModalsProvider>
      <AppAssistantWorkspace canPreview sandboxUrl={BASE} />
    </ModalsProvider>
  );
  await expect.element(page.getByTestId('chat')).toBeInTheDocument();
}

const switcher = () => page.getByRole('button', { name: /^Switch app:/ });
const problem = () => page.getByTestId('app-fork-problem');

describe('a fresh fork', () => {
  test('creates the app WITH the seed, opens a new chat, and shows the Set up card', async () => {
    await mount();
    await expect.element(page.getByTestId('app-fork-setup')).toBeInTheDocument();
    expect(m.seedCalls).toEqual([{ app: FORK_SLUG, seed: SEED }]);
    expect(m.newChat).toHaveBeenCalledTimes(1);
    await expect.element(switcher()).toHaveAccessibleName(`Switch app: ${FORK_SLUG}, Running`);
    expect(page.getByTestId('app-fork-setup').element().textContent).toBe(
      'Forked from Pixel Garden. Set it up and preview?Set up'
    );
    // The address loses ?fork=, so a reload does not try to create it again.
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/apps/build', query: {} }, undefined, {
      shallow: true,
    });
    // Nothing was sent: no reply, no spend, until the user presses Set up.
    expect(m.sent).toEqual([]);
  });

  test('Set up sends the one fixed message, once, and the card goes', async () => {
    await mount();
    const setUp = page.getByRole('button', { name: 'Set up' });
    await expect.element(setUp).toBeEnabled();
    await userEvent.click(setUp);
    expect(m.sent).toEqual([SETUP_MESSAGE]);
    await expect.element(page.getByTestId('app-fork-setup')).not.toBeInTheDocument();
    expect(page.getByRole('button', { name: 'Set up' }).elements()).toHaveLength(0);
    expect(m.sent).toHaveLength(1);
  });

  test('Set up stays off while the app is still starting (its tools are not there yet)', async () => {
    m.seedResult = { sandbox: sandbox('sbx-fork00000002', { state: 'starting' }) };
    await mount();
    await expect.element(page.getByTestId('app-fork-setup')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Set up' })).toBeDisabled();
    expect(m.sent).toEqual([]);
  });

  test('a message of the user’s own answers the card', async () => {
    await mount();
    await expect.element(page.getByTestId('app-fork-setup')).toBeInTheDocument();
    m.chat?.onBeforeSend?.('make the flowers blue', () => ({
      release: () => undefined,
      cancel: () => undefined,
    }));
    await expect.element(page.getByTestId('app-fork-setup')).not.toBeInTheDocument();
  });
});

describe('an app already under the fork’s slug', () => {
  test('is opened — no second create, no new chat, no card', async () => {
    m.list = [sandbox('sbx-fork00000003')];
    await mount();
    await expect.element(switcher()).toHaveAccessibleName(`Switch app: ${FORK_SLUG}, Running`);
    expect(m.seedCalls).toEqual([]);
    expect(m.newChat).not.toHaveBeenCalled();
    expect(page.getByTestId('app-fork-setup').elements()).toHaveLength(0);
  });

  test('opens the FORK, not the app worked on most recently', async () => {
    m.list = [
      sandbox('sbx-recent000007', {
        app: 'recent-other-app',
        lastActivityAt: '2026-10-23T12:00:00.000Z',
      }),
      sandbox('sbx-fork00000008', { lastActivityAt: '2026-10-01T12:00:00.000Z' }),
    ];
    await mount();
    await expect.element(switcher()).toHaveAccessibleName(`Switch app: ${FORK_SLUG}, Running`);
    // And it stays there once everything has settled.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect.element(switcher()).toHaveAccessibleName(`Switch app: ${FORK_SLUG}, Running`);
  });

  test('already_exists from the service (made meanwhile) → the list is re-read and it opens', async () => {
    m.seedResult = {
      error: new SandboxApiError(
        'a sandbox for this app already exists (sbx-fork00000004); a seed only creates a new one',
        409,
        'conflict',
        'already_exists'
      ),
    };
    m.afterRefetch = [sandbox('sbx-fork00000004')];
    await mount();
    await expect.element(switcher()).toHaveAccessibleName(`Switch app: ${FORK_SLUG}, Running`);
    expect(m.refetches).toBeGreaterThan(0);
    expect(page.getByTestId('app-fork-problem').elements()).toHaveLength(0);
  });
});

const SEED_ERRORS = [
  ['seed_host_not_allowed', 400, 'Forking isn’t available right now. Try again later.', true],
  ['seed_too_large', 413, 'This app is too large to fork.', false],
  ['seed_hash_mismatch', 422, 'The app’s files didn’t arrive intact. Try again.', true],
  ['seed_rejected_entry', 422, 'This app’s files couldn’t be copied into your workspace.', false],
  ['seed_fetch_failed', 502, 'The app’s files couldn’t be downloaded. Try again.', true],
  ['seed_busy', 503, 'Forking is busy right now. Try again in a moment.', true],
] as const;

describe('the service refuses the seed', () => {
  test.each(SEED_ERRORS)('%s → its sentence; Try again: %s', async (code, status, text, retry) => {
    m.seedResult = { error: new SandboxApiError('service words', status, 'unavailable', code) };
    await mount();
    await expect.element(problem()).toBeInTheDocument();
    const tryAgain = page.getByRole('button', { name: 'Try again' });
    expect(problem().element().textContent).toBe(retry ? `${text}Try again` : text);
    expect(tryAgain.elements()).toHaveLength(retry ? 1 : 0);
    if (!retry) return;
    await userEvent.click(tryAgain);
    // A FRESH fork of the same parent; nothing to delete (nothing was created).
    expect(m.starts).toEqual([{ listingId: PARENT_LISTING }]);
    expect(m.removed).toEqual([]);
    expect(router.push).toHaveBeenCalledWith(`/apps/build?fork=${NEXT_SLUG}`, undefined, {
      shallow: true,
    });
  });

  test('a create the service did not seed (an EMPTY app) reads as seed_lost; Try again deletes it first', async () => {
    m.seedResult = {
      error: new SandboxSeedNotAppliedError(sandbox('sbx-fork00000005', { state: 'starting' })),
    };
    await mount();
    await expect.element(problem()).toBeInTheDocument();
    expect(problem().element().textContent).toBe(
      'Your fork’s files never arrived, so this app is empty.Try again'
    );
    await userEvent.click(page.getByRole('button', { name: 'Try again' }));
    expect(m.removed).toEqual(['sbx-fork00000005']);
    expect(m.starts).toEqual([{ listingId: PARENT_LISTING }]);
  });

  test('the keep-limit shows the page’s own limit message', async () => {
    m.seedResult = {
      error: new SandboxApiError('sandbox limit (3) reached; delete one first', 409, 'limit'),
    };
    await mount();
    await expect
      .element(page.getByText('You have as many apps as you can keep'))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          'Delete an app you no longer need from the app switcher at the top of the page, then try again.'
        )
      )
      .toBeInTheDocument();
    expect(problem().elements()).toHaveLength(0);
  });
});

describe('seed_lost reported by the service later', () => {
  test('the open app’s files never landed: its sentence, and Try again deletes it and forks afresh', async () => {
    m.list = [sandbox('sbx-fork00000006', { state: 'seed_lost' })];
    await mount();
    await expect.element(problem()).toBeInTheDocument();
    expect(problem().element().textContent).toBe(
      'Your fork’s files never arrived, so this app is empty.Try again'
    );
    await userEvent.click(page.getByRole('button', { name: 'Try again' }));
    expect(m.removed).toEqual(['sbx-fork00000006']);
    expect(m.starts).toEqual([{ listingId: PARENT_LISTING }]);
  });
});

describe('no usable fork session', () => {
  test('not this user’s (or gone): its sentence, and no Try again (no parent to fork)', async () => {
    m.session = null;
    await mount();
    await expect.element(problem()).toBeInTheDocument();
    expect(problem().element().textContent).toBe(
      'This fork has expired. Fork the app again from its page.'
    );
    expect(m.seedCalls).toEqual([]);
  });

  test('an expired seed: its sentence, and Try again forks the same parent afresh', async () => {
    m.session = { ...SESSION, seed: null };
    await mount();
    await expect.element(problem()).toBeInTheDocument();
    expect(problem().element().textContent).toBe(
      'This fork has expired. Fork the app again from its page.Try again'
    );
    expect(m.seedCalls).toEqual([]);
    await userEvent.click(page.getByRole('button', { name: 'Try again' }));
    expect(m.starts).toEqual([{ listingId: PARENT_LISTING }]);
  });
});
