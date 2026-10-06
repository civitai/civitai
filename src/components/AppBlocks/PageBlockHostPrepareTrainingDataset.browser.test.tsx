import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import { BLOCK_TRAINING_DATASET_MAX_ITEMS } from '~/server/schema/blocks/workflow.schema';

/**
 * PREPARE_TRAINING_DATASET → TRAINING_DATASET_RESULT on the PAGE host, end to end
 * through the real `onMessage` dispatcher.
 *
 * Step 1 of the `kind:'training'` block flow. A block cannot call
 * `blocks.prepareTrainingDataset` itself (its origin is refused by the web tRPC
 * endpoint), so the page host calls it with the page's block token and replies.
 * Before this bridge the page host answered this message with nothing at all.
 *
 * Also here: the estimate leg of the same flow — a `kind:'training'` body on
 * `ESTIMATE_WORKFLOW` reaches the procedure untouched and `trainingQuote` comes
 * back on the reply. That one is an INVARIANT guard (it passes before this change
 * too): it pins that the existing estimate bridge already serves training.
 */

const { prepareMutate, estimateMutate } = vi.hoisted(() => ({
  prepareMutate: vi.fn(),
  estimateMutate: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

/** A sub-router whose every procedure answers with an inert mutation hook. */
function inertSubRouter() {
  return new Proxy(
    {},
    {
      has: () => true,
      get: (_t, key) =>
        key === 'then' ? undefined : { useMutation: () => ({ mutateAsync: vi.fn() }) },
    }
  );
}

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  setTrpcBatchingEnabled: vi.fn(),
  trpc: makeTrpcProxy(
    {
      'blocks.estimateWorkflow': { useMutation: () => ({ mutateAsync: estimateMutate }) },
      'apps.shared': inertSubRouter(),
      'apps.storage': inertSubRouter(),
    },
    {
      useUtils: () => ({
        client: { blocks: { prepareTrainingDataset: { mutate: prepareMutate } } },
      }),
    }
  ),
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

function iframe() {
  return page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
}

function postFromBlock(type: string, payload?: unknown) {
  const cw = iframe().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type, payload },
      origin: window.location.origin,
      source: cw,
    })
  );
}

function listenForReply() {
  const received: Array<{ type: string; payload: unknown }> = [];
  const cw = iframe().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
  };
  cw.addEventListener('message', handler);
  return {
    of: (type: string) => received.filter((m) => m.type === type),
    stop: () => cw.removeEventListener('message', handler),
  };
}

const SAME_ORIGIN_SRC = `${window.location.origin}/`;
const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'trainer-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'LoRA Trainer',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'trainer-app',
  token: 'tok_page',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: [] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' } as { id: number; username: string | null } | null,
  theme: 'light' as const,
};

async function mountReady(over: Partial<typeof baseProps> = {}) {
  renderWithProviders(<PageBlockHost {...baseProps} {...over} />);
  await vi.waitFor(() => {
    if (!iframe().contentWindow) throw new Error('not mounted yet');
  });
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    if (iframe().getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
  return listenForReply();
}

const ITEMS = [
  { imageId: 11, caption: 'a red fox' },
  { imageId: 23, caption: '' },
];
const RESULT = {
  datasetId: `tds_${'d'.repeat(32)}`,
  count: 1,
  rejected: [{ imageId: 23, reason: 'unavailable' }],
};

async function replyFor(replies: ReturnType<typeof listenForReply>, requestId: string) {
  let found: unknown;
  await vi.waitFor(() => {
    const r = replies
      .of('TRAINING_DATASET_RESULT')
      .find((m) => (m.payload as { requestId?: string }).requestId === requestId);
    if (!r) throw new Error('no TRAINING_DATASET_RESULT yet');
    found = r.payload;
  });
  return found;
}

describe('PageBlockHost PREPARE_TRAINING_DATASET (training dataset bridge)', () => {
  beforeEach(() => {
    prepareMutate.mockReset();
    estimateMutate.mockReset();
    prepareMutate.mockResolvedValue({ ...RESULT, serverOnly: 'not for the block' });
  });

  test("calls the procedure with the PAGE token and replies with the server's dataset", async () => {
    const replies = await mountReady();
    postFromBlock('PREPARE_TRAINING_DATASET', { requestId: 'rq_1', items: ITEMS });

    expect(await replyFor(replies, 'rq_1')).toEqual({ requestId: 'rq_1', result: RESULT });
    expect(prepareMutate).toHaveBeenCalledTimes(1);
    expect(prepareMutate).toHaveBeenCalledWith({ blockToken: 'tok_page', items: ITEMS });
    expect(replies.of('TRAINING_DATASET_RESULT')).toHaveLength(1);
    replies.stop();
  });

  test('an oversized payload is refused on the host and never reaches the server', async () => {
    const replies = await mountReady();
    const tooMany = Array.from({ length: BLOCK_TRAINING_DATASET_MAX_ITEMS + 1 }, (_, i) => ({
      imageId: i + 1,
      caption: '',
    }));
    postFromBlock('PREPARE_TRAINING_DATASET', { requestId: 'rq_2', items: tooMany });

    expect(await replyFor(replies, 'rq_2')).toEqual({
      requestId: 'rq_2',
      error: 'invalid training dataset',
    });
    expect(prepareMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('a server refusal reaches the block as an error', async () => {
    prepareMutate.mockRejectedValueOnce(new Error('block lacks ai:write:budgeted scope'));
    const replies = await mountReady();
    postFromBlock('PREPARE_TRAINING_DATASET', { requestId: 'rq_3', items: ITEMS });

    expect(await replyFor(replies, 'rq_3')).toEqual({
      requestId: 'rq_3',
      error: 'block lacks ai:write:budgeted scope',
    });
    replies.stop();
  });

  test('an anonymous viewer is refused without a call', async () => {
    const replies = await mountReady({ viewer: null });
    postFromBlock('PREPARE_TRAINING_DATASET', { requestId: 'rq_4', items: ITEMS });

    expect(await replyFor(replies, 'rq_4')).toEqual({
      requestId: 'rq_4',
      error: 'sign in to train',
    });
    expect(prepareMutate).not.toHaveBeenCalled();
    replies.stop();
  });

  test('INVARIANT: a training ESTIMATE_WORKFLOW body is forwarded untouched and trainingQuote returns', async () => {
    const trainingQuote = {
      quoteId: `tq_${'e'.repeat(32)}`,
      total: 900,
      imageCount: 1,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    const snapshot = {
      workflowId: 'wf_estimate',
      status: 'pending',
      cost: { total: 900 },
      trainingQuote,
    };
    estimateMutate.mockResolvedValue({ snapshot });
    const body = {
      kind: 'training',
      datasetId: RESULT.datasetId,
      engine: 'ai-toolkit',
      model: 'sdxl',
      params: {},
      triggerWord: 'fx',
      samplePrompts: [],
    };
    const replies = await mountReady();
    postFromBlock('ESTIMATE_WORKFLOW', { requestId: 'rq_est', body });

    await vi.waitFor(() => {
      if (replies.of('ESTIMATE_RESULT').length === 0) throw new Error('no ESTIMATE_RESULT yet');
    });
    expect(estimateMutate).toHaveBeenCalledWith({ blockToken: 'tok_page', body });
    expect(replies.of('ESTIMATE_RESULT')[0].payload).toEqual({ requestId: 'rq_est', snapshot });
    replies.stop();
  });
});
