import type { ReactElement } from 'react';
import { beforeEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders as renderInProviders } from '../../../test/component-setup';
import { FixedSessionProvider } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { SearchRefusalNotice } from '~/components/Search/SearchRefusalNotice';
import type { SearchRefusal } from '~/components/Search/search-refusal';
import {
  SemanticSearchError,
  semanticSearchStatus,
} from '~/components/SemanticSearch/SemanticSearchError';
import { SEARCH_POLICY_MESSAGE } from '~/shared/constants/search-refusal.constants';

// The notice reads the real session; each test picks whose.
const viewer = { isModerator: false };
beforeEach(() => {
  viewer.isModerator = false;
});
const renderWithProviders = (ui: ReactElement) =>
  renderInProviders(
    <FixedSessionProvider user={{ id: 1, isModerator: viewer.isModerator }}>
      {ui}
    </FixedSessionProvider>
  );

const text = () => document.body.textContent ?? '';

describe('SearchRefusalNotice', () => {
  test.each<SearchRefusal>(['profanity', 'poi', 'blocked-words', 'policy'])(
    '%s shows the policy message, naming no term or rule',
    async (refusal) => {
      await renderWithProviders(<SearchRefusalNotice refusal={refusal} />);
      await expect.element(page.getByText(SEARCH_POLICY_MESSAGE.title)).toBeVisible();
      await expect.element(page.getByText(SEARCH_POLICY_MESSAGE.body)).toBeVisible();
      expect(text()).not.toMatch(/flagged terms|real people|blocked words|moderator view/i);
    }
  );

  test('the minors refusal keeps its own warning and help links', async () => {
    await renderWithProviders(<SearchRefusalNotice refusal="illegal" />);
    await expect.element(page.getByText(/involving minors/i)).toBeVisible();
    expect(text()).not.toContain(SEARCH_POLICY_MESSAGE.title);
    expect(text()).not.toMatch(/flagged terms/i);
  });

  test('a non-moderator never sees the moderator line, even if a refusedBy is passed', async () => {
    await renderWithProviders(<SearchRefusalNotice refusal="policy" refusedBy="query guard" />);
    await expect.element(page.getByText(SEARCH_POLICY_MESSAGE.title)).toBeVisible();
    expect(text()).not.toMatch(/moderator view|query guard/i);
  });

  test("a moderator sees the server's check", async () => {
    viewer.isModerator = true;
    await renderWithProviders(<SearchRefusalNotice refusal="policy" refusedBy="query guard" />);
    await expect
      .element(page.getByText('Moderator view: refused by the query guard check'))
      .toBeVisible();
  });

  test('a moderator sees the check a browser-side refusal names', async () => {
    viewer.isModerator = true;
    await renderWithProviders(<SearchRefusalNotice refusal="poi" />);
    await expect
      .element(page.getByText('Moderator view: refused by the real people check'))
      .toBeVisible();
  });

  test('a moderator sees a check that failed closed as one', async () => {
    viewer.isModerator = true;
    await renderWithProviders(<SearchRefusalNotice refusal="policy" refusedBy="error" />);
    await expect
      .element(
        page.getByText('Moderator view: refused: the check could not complete (fail-closed)')
      )
      .toBeVisible();
  });
});

describe('SemanticSearchError', () => {
  test('a refused search (422) shows the policy message, not an outage', async () => {
    await renderWithProviders(
      <SemanticSearchError
        error={{ message: 'search_refused', data: { code: 'UNPROCESSABLE_CONTENT' } }}
      />
    );
    await expect.element(page.getByText(SEARCH_POLICY_MESSAGE.title)).toBeVisible();
    expect(text()).not.toMatch(/unavailable|search failed/i);
  });

  test('a server error (500) keeps the outage text', async () => {
    await renderWithProviders(
      <SemanticSearchError error={{ message: 'boom', data: { code: 'INTERNAL_SERVER_ERROR' } }} />
    );
    await expect
      .element(page.getByText('Search is unavailable right now, try again.'))
      .toBeVisible();
    expect(text()).not.toContain(SEARCH_POLICY_MESSAGE.title);
  });
});

describe('the semantic image search page', () => {
  const status = (over: Partial<Parameters<typeof semanticSearchStatus>[0]>) =>
    semanticSearchStatus({
      enabled: true,
      isLoading: false,
      error: null,
      empty: true,
      idleMessage: 'idle',
      emptyMessage: 'nothing matched',
      ...over,
    });

  test("shows the minors notice for text the browser's check catches, never searching it", async () => {
    // A caught text is not searched, so the page is not enabled for it.
    await renderWithProviders(<>{status({ refusal: 'illegal', enabled: false })}</>);
    await expect.element(page.getByText(/involving minors/i)).toBeVisible();
    expect(text()).not.toContain(SEARCH_POLICY_MESSAGE.title);
  });

  test('shows the policy message for a refusal only the server made (control)', async () => {
    await renderWithProviders(<>{status({ serverRefusal: {} })}</>);
    await expect.element(page.getByText(SEARCH_POLICY_MESSAGE.title)).toBeVisible();
    expect(text()).not.toMatch(/involving minors|nothing matched/i);
  });

  test('a search that found nothing says so, and found results show no status', async () => {
    await renderWithProviders(<>{status({})}</>);
    await expect.element(page.getByText('nothing matched')).toBeVisible();
    expect(status({ empty: false })).toBeNull();
  });
});
