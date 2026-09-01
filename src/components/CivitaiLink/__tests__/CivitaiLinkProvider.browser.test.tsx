import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as CivitaiLinkApi from '~/components/CivitaiLink/civitai-link-api';

// =============================================================================
// The provider half of the cross-domain guard.
//
// `getCivitaiLinkBaseUrl` returning undefined is only half the fix — it does
// nothing unless the provider BRANCHES on it. These tests pin that branch:
// on an origin with no reachable Link host the SharedWorker must never be
// constructed, and the failure must be reported as a domain problem rather
// than left as the bare "Cannot Connect" this change exists to replace.
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
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ civitaiLink: true }),
}));

vi.mock('~/components/CivitaiLink/civitai-link-api', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiLinkApi>()),
  getCivitaiLinkBaseUrl: () => mocks.baseUrl,
}));

vi.mock('@okikio/sharedworker', () => ({
  default: class FakeSharedWorker {
    port = {
      postMessage: () => undefined,
      onmessage: null as ((e: { data: unknown }) => void) | null,
    };
    constructor() {
      mocks.workerConstructions += 1;
    }
  },
}));

import { renderWithProviders } from '../../../../test/component-setup';
import {
  CivitaiLinkProvider,
  UNAVAILABLE_ON_DOMAIN,
  useCivitaiLink,
} from '~/components/CivitaiLink/CivitaiLinkProvider';

/**
 * Renders the context's whole observable state as attributes. State is asserted
 * via attributes, never via rendered prose — a sentence can be reworded while
 * the behaviour regresses.
 */
function Probe() {
  const { error, status } = useCivitaiLink();
  return <div data-testid="probe" data-status={status} data-error={error ?? ''} />;
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
  });

  test('spawns no worker and reports the domain when no Link host is reachable', async () => {
    mocks.baseUrl = undefined;
    renderProvider();

    await expect
      .element(page.getByTestId('probe'))
      .toHaveAttribute('data-error', UNAVAILABLE_ON_DOMAIN);
    // The point of the fix: no request is ever issued, because no worker exists
    // to issue it. A worker here would 401 exactly as before.
    expect(mocks.workerConstructions).toBe(0);
  });

  test('leaves the status not-connected rather than claiming a socket problem', async () => {
    mocks.baseUrl = undefined;
    renderProvider();

    await expect.element(page.getByTestId('probe')).toHaveAttribute('data-status', 'not-connected');
  });

  // Positive control: the guard must be selective, not simply always-off.
  test('spawns the worker when a Link host on this origin IS reachable', async () => {
    mocks.baseUrl = 'https://link.civitai.com';
    renderProvider();

    await vi.waitFor(() => expect(mocks.workerConstructions).toBe(1));
    await expect.element(page.getByTestId('probe')).toHaveAttribute('data-error', '');
  });
});
