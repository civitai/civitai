import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as CivitaiLinkApi from '~/components/CivitaiLink/civitai-link-api';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';

// =============================================================================
// The provider half of the cross-domain guard.
//
// `getCivitaiLinkBaseUrl` returning undefined is only half the fix — it does
// nothing unless the provider BRANCHES on it. These tests pin that branch: on an
// origin with no reachable Link host the SharedWorker must never be constructed,
// and the context must carry the domain-specific message rather than being left
// on the generic connection failure.
//
// Both directions are asserted. The available case is the positive control:
// without it, a provider that never spawns a worker at all would pass the
// unavailable case for entirely the wrong reason.
// =============================================================================

const mocks = vi.hoisted(() => ({
  /** What `getCivitaiLinkBaseUrl` returns for the test at hand. */
  baseUrl: undefined as string | undefined,
  /** How many times the provider constructed a SharedWorker. */
  workerConstructions: 0,
  /** Every message the provider posted to the worker, in order. */
  posted: [] as unknown[],
  /** The live fake port, so a test can push worker messages back. */
  port: null as { onmessage: ((e: { data: unknown }) => void) | null } | null,
}));

// `importOriginal` spread, NOT a bare replacement naming only `useFeatureFlags`.
// A wholesale mock of this module is a known silent-zero shape here: when
// something in the graph starts importing another of its exports, the file fails
// to IMPORT, collects 0 tests and reports 0 failures — see
// `src/components/AppBlocks/__tests__/featureFlagsMockCompleteness.test.ts`,
// which records six suites that went quietly to zero exactly this way. The tier
// that runs this file is report-only, so that would be silent.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsProvider>()),
  useFeatureFlags: () => ({ civitaiLink: true }),
}));

vi.mock('~/components/CivitaiLink/civitai-link-api', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiLinkApi>()),
  getCivitaiLinkBaseUrl: () => mocks.baseUrl,
}));

vi.mock('@okikio/sharedworker', () => ({
  default: class FakeSharedWorker {
    port = {
      postMessage: (message: unknown) => {
        mocks.posted.push(message);
      },
      onmessage: null as ((e: { data: unknown }) => void) | null,
    };
    constructor() {
      mocks.workerConstructions += 1;
      mocks.port = this.port;
    }
  },
}));

import { renderWithProviders } from '../../../../test/component-setup';
import {
  CivitaiLinkProvider,
  UNAVAILABLE_ON_DOMAIN,
  useCivitaiLink,
} from '~/components/CivitaiLink/CivitaiLinkProvider';

// Pinned as a LITERAL, deliberately not as the imported constant. Asserting
// `toHaveAttribute('data-error', UNAVAILABLE_ON_DOMAIN)` passes even when the
// constant is emptied — that pins the wiring and lets the message say anything.
const UNAVAILABLE_MESSAGE = 'Civitai Link is not available on this domain';

/**
 * Renders the context's whole observable state as attributes. State is asserted
 * via attributes, never via rendered prose — a sentence can be reworded while
 * the behaviour regresses.
 */
function Probe() {
  const { error, status, instances, pairingStatus, awaitPairing } = useCivitaiLink();
  return (
    <div
      data-testid="probe"
      data-status={status}
      data-error={error ?? ''}
      data-instances={(instances ?? []).map((x) => x.id).join(',')}
      data-pairing={pairingStatus ?? ''}
    >
      <button type="button" data-testid="await-pairing" onClick={() => awaitPairing()}>
        await
      </button>
    </div>
  );
}

const renderProvider = () =>
  renderWithProviders(
    <CivitaiLinkProvider>
      <Probe />
    </CivitaiLinkProvider>
  );

describe('CivitaiLinkProvider — cross-domain guard', () => {
  beforeEach(() => {
    mocks.baseUrl = undefined;
    mocks.workerConstructions = 0;
    mocks.posted = [];
    mocks.port = null;
  });

  test('the exported constant still says what these tests assert', () => {
    expect(UNAVAILABLE_ON_DOMAIN).toBe(UNAVAILABLE_MESSAGE);
  });

  test('spawns no worker and reports the domain when no Link host is reachable', async () => {
    mocks.baseUrl = undefined;
    renderProvider();

    const probe = page.getByTestId('probe');
    // The literal, so emptying or rewording the constant is red. It also
    // separates this from the feature-flag-off path, whose message differs.
    await expect.element(probe).toHaveAttribute('data-error', UNAVAILABLE_MESSAGE);
    await expect.element(probe).toHaveAttribute('data-status', 'not-connected');
    // The point of the fix: no request is ever issued, because no worker exists
    // to issue it. A worker here would 401 exactly as before.
    expect(mocks.workerConstructions).toBe(0);
  });

  // Positive control: the guard must be selective, not simply always-off.
  test('spawns the worker when a Link host on this origin IS reachable', async () => {
    mocks.baseUrl = 'https://link.civitai.com';
    renderProvider();

    await vi.waitFor(() => expect(mocks.workerConstructions).toBe(1));
    await expect.element(page.getByTestId('probe')).toHaveAttribute('data-error', '');
  });

  // The worker half is untestable (module-scope `io()` + `self.onconnect`), so
  // this pins the contract between them: the snapshot the provider sends, and
  // the status it surfaces. Every state asserted here is absorbing — it arrives
  // and stays — so no matcher is racing a state that deletes itself.
  test('awaitPairing snapshots the instance list and surfaces the worker status', async () => {
    mocks.baseUrl = 'https://link.civitai.com';
    renderProvider();

    await vi.waitFor(() => expect(mocks.port).not.toBeNull());
    const port = mocks.port!;
    // The provider only resolves its worker promise on `ready`; without this,
    // every `workerReq` stays pending forever.
    port.onmessage?.({ data: { type: 'ready' } });
    port.onmessage?.({
      data: {
        type: 'instancesUpdate',
        payload: [
          {
            id: 7,
            key: 'abcdef',
            name: 'Workstation',
            activated: true,
            origin: null,
            oauthPaired: true,
            createdAt: new Date('2026-09-01T00:00:00Z'),
          },
        ],
      },
    });

    const probe = page.getByTestId('probe');
    await expect.element(probe).toHaveAttribute('data-instances', '7');

    await page.getByTestId('await-pairing').click();
    await vi.waitFor(() =>
      expect(mocks.posted).toContainEqual({
        type: 'awaitPairing',
        knownIds: [7],
        knownKeys: { 7: 'abcdef' },
      })
    );
    await expect.element(probe).toHaveAttribute('data-pairing', 'waiting');

    port.onmessage?.({ data: { type: 'pairing', status: 'paired' } });
    await expect.element(probe).toHaveAttribute('data-pairing', 'paired');
  });
});
