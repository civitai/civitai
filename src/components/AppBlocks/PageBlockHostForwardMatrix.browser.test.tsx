import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import {
  REPLY_TYPE,
  ROWS,
  TOKEN,
  replyKeysProblems,
  rowName,
  runRow,
  type MountMode,
} from '../../../test/bridgeForwardMatrix';
// Type-only namespace import for the `importOriginal` spread below.
import type * as TrpcMod from '~/utils/trpc';

/**
 * FORWARD-HANDLER CHARACTERISATION — PageBlockHost.
 *
 * Runs every `test/bridgeForwardMatrix.ts` row whose `hosts` include PageBlockHost against
 * the REAL host, driving the real postMessage bridge. The matrix header says what each row
 * asserts; `IframeHostForwardMatrix.browser.test.tsx` runs the same table on the model-slot
 * host, so a row that holds on both is a pinned parity, not a coincidence.
 *
 * The tRPC client is `test/bridgeRpcMock.ts`: one spy per procedure behind every call seam,
 * so these rows survive a handler moving between `useMutation` and `useUtils().client`.
 */

const rpc = await vi.hoisted(async () => {
  const { createBridgeRpcMock } = await import('../../../test/bridgeRpcMock');
  return createBridgeRpcMock();
});

// AppBlockChrome (in the host frame) calls useCurrentUser() for the platform-nav moderator
// gate; render the real host without a CivitaiSessionProvider.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  // Spread the real module so every other export (e.g. `setTrpcBatchingEnabled`, which
  // FeatureFlagsProvider imports) still links; a missing export fails the whole FILE to
  // import, which reports as "no tests" rather than as a failure.
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: rpc.trpc,
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';
// eslint-disable-next-line import/first
import { INVENTORY } from '~/components/AppBlocks/hostHandlerParity';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'my-page-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Matrix',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'my-page-app',
  token: TOKEN as string | null,
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: ['apps:storage:read', 'apps:storage:write'],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' },
  theme: 'light' as const,
};

function iframeEl() {
  return page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
}

function post(type: string, payload: unknown) {
  const cw = iframeEl().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type, payload },
      origin: window.location.origin,
      source: cw,
    })
  );
}

function listen() {
  const received: Array<{ type: string; payload: unknown }> = [];
  const cw = iframeEl().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d && typeof d.type === 'string') {
      // Re-clone into THIS realm: the payload was deserialised in the iframe's realm, so
      // its prototypes differ and `toStrictEqual` would reject an otherwise equal object.
      received.push({ type: d.type, payload: structuredClone(d.payload) });
      rpc.events.push(`reply:${d.type}`);
    }
  };
  cw.addEventListener('message', handler);
  return {
    of: (type: string) => received.filter((m) => m.type === type),
    stop: () => cw.removeEventListener('message', handler),
  };
}

async function mount(mode: MountMode) {
  const props =
    mode === 'noToken'
      ? { ...baseProps, token: null }
      : mode === 'review'
      ? { ...baseProps, reviewMode: true, onConsentGranted: vi.fn() }
      : mode === 'reviewRunForReal'
      ? { ...baseProps, reviewMode: true, reviewRunForReal: true, onConsentGranted: vi.fn() }
      : baseProps;
  renderWithProviders(<PageBlockHost {...props} />);
  await vi.waitFor(() => {
    if (!iframeEl().contentWindow) throw new Error('not mounted yet');
  });
  // With a null token the host sits in `loading` (the frame and every handler are live,
  // see PageBlockHostNoTokenNack) and never reaches BLOCK_READY, so do not wait for it.
  if (mode === 'noToken') return;
  await vi.waitFor(() => {
    post('BLOCK_READY', {});
    if (iframeEl().getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
}

const HOST = 'PageBlockHost' as const;
const rows = ROWS.filter((r) => r.hosts.includes(HOST));

describe('PageBlockHost forward-handler characterisation', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
  });

  test('the matrix covers exactly the forwarded types INVENTORY requires of this host', () => {
    const required = Object.keys(REPLY_TYPE).filter(
      (t) => (INVENTORY as Record<string, Record<string, unknown>>)[t]?.[HOST] === 'required'
    );
    const covered = [...new Set(rows.map((r) => r.type))];
    expect(covered.sort()).toEqual(required.sort());
    expect(covered).toHaveLength(27);
    // This loop is what enforces INVENTORY's `reply` for the forwarded types: it must equal
    // the matrix's REPLY_TYPE, which is the reply type every row observes the host sending.
    for (const t of covered) {
      expect((INVENTORY as Record<string, { reply: string }>)[t].reply).toBe(REPLY_TYPE[t]);
    }
    // INVENTORY's `replyKeys` / `errorKeys` must agree with the reply payloads the rows pin,
    // and every key they declare must show up in some row.
    expect(replyKeysProblems(rows)).toEqual([]);
  });

  for (const row of rows) {
    test(rowName(row), async () => {
      await runRow(row, { rpc, mount, post, listen });
    });
  }
});
