import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
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
 * FORWARD-HANDLER CHARACTERISATION — IframeHost (the model-slot host).
 *
 * Runs every `test/bridgeForwardMatrix.ts` row whose `hosts` include IframeHost against the
 * REAL host. IframeHost cannot mount without a token and has no review preview, so only the
 * `default` mount mode applies here; `PageBlockHostForwardMatrix.browser.test.tsx` runs the
 * PageBlockHost-only modes. The shared rows are the same objects on both hosts.
 */

const rpc = await vi.hoisted(async () => {
  const { createBridgeRpcMock } = await import('../../../test/bridgeRpcMock');
  // The two loaded shapes the model-slot host renders from (as IframeHostUnhandledNack).
  return createBridgeRpcMock({
    'blocks.getEffectiveCheckpoint': {
      useQuery: () => ({ data: { checkpoint: null }, isLoading: false }),
    },
    'blocks.getShowcaseImages': { useQuery: () => ({ data: [], isLoading: false }) },
  });
});

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// Replaces the module, so it names every export this file's graph imports — omitting one
// fails the FILE to import, which reports as "no tests" rather than as a failure.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
  useOptionalFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: rpc.trpc,
}));

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => 1,
}));

// eslint-disable-next-line import/first
import { IframeHost } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import type { BlockInstall, ModelSlotContext } from '~/components/AppBlocks/types';
// eslint-disable-next-line import/first
import { INVENTORY } from '~/components/AppBlocks/hostHandlerParity';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

const install: BlockInstall = {
  blockInstanceId: 'inst_test',
  blockId: 'my-model-app',
  appId: 'app_test',
  appBlockId: 'apb_test',
  manifest: {
    name: 'Slot App',
    scopes: [],
    iframe: {
      src: SAME_ORIGIN_SRC,
      minHeight: 200,
      maxHeight: 800,
      resizable: true,
      sandbox: 'allow-scripts',
    },
  },
  publisherSettings: {},
  enabled: true,
  renderMode: 'iframe',
  trustTier: 'internal',
};

const context: ModelSlotContext = {
  slotId: 'model.sidebar_top',
  entityType: 'model',
  modelId: 123,
  modelVersionId: 456,
  modelName: 'Some Model',
  modelType: 'Checkpoint',
  modelNsfwLevel: 1,
  creatorUserId: 7,
  viewerUserId: 42,
  viewerNsfwEnabled: false,
  viewerUsername: 'tester',
  theme: 'light',
};

function iframeEl() {
  return page.getByTestId('block-iframe').element() as HTMLIFrameElement;
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
  if (mode !== 'default') throw new Error(`IframeHost has no "${mode}" mount mode`);
  renderWithProviders(
    <IframeHost
      install={install}
      context={context}
      token={TOKEN}
      expiresAt={new Date(Date.now() + 15 * 60_000).toISOString()}
    />
  );
  await vi.waitFor(() => {
    if (!iframeEl().contentWindow) throw new Error('not mounted yet');
  });
  await vi.waitFor(() => {
    post('BLOCK_READY', {});
    if (iframeEl().getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
}

const HOST = 'IframeHost' as const;
const rows = ROWS.filter((r) => r.hosts.includes(HOST));

describe('IframeHost forward-handler characterisation', () => {
  test('the matrix covers exactly the forwarded types INVENTORY requires of this host', () => {
    const required = Object.keys(REPLY_TYPE).filter(
      (t) => (INVENTORY as Record<string, Record<string, unknown>>)[t]?.[HOST] === 'required'
    );
    const covered = [...new Set(rows.map((r) => r.type))];
    expect(covered.sort()).toEqual(required.sort());
    expect(covered).toHaveLength(20);
    // INVENTORY's `reply` must agree with the reply type the rows assert against.
    for (const t of covered) {
      expect((INVENTORY as Record<string, { reply: string }>)[t].reply).toBe(REPLY_TYPE[t]);
    }
    // INVENTORY's `replyKeys` / `errorKeys` must agree with the reply payloads the rows pin,
    // and every key they declare must show up in some row.
    expect(replyKeysProblems(rows)).toEqual([]);
    // Every IframeHost row is a default-mode row: the PBH-only modes cannot reach this host.
    expect(rows.every((r) => r.mode === 'default')).toBe(true);
  });

  for (const row of rows) {
    test(rowName(row), async () => {
      await runRow(row, { rpc, mount, post, listen });
    });
  }
});
