import Router from 'next/router';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { CorrectedQueryNote, FeedSearchSummary } from '~/components/Search/FeedSearchSummary';
import { spellcheckFor, useSearchAsTyped } from '~/components/Search/useSearchAsTyped';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// The component setup's router stub: the singleton useRouter() returns.
const router = Router as unknown as { push: Mock; query: Record<string, unknown> };

const summary = (correctedQuery?: string) =>
  renderWithProviders(
    <FeedSearchSummary
      noun="Models"
      query="Shikata nee"
      correctedQuery={correctedQuery}
      failed={false}
      onRetry={() => undefined}
    />
  );

/** The search input's spelling flag for `query`, as the feed hooks compute it. */
function Flag({ query }: { query: string }) {
  const { asTyped } = useSearchAsTyped(query);
  return <p data-testid="flag">{JSON.stringify(spellcheckFor(asTyped))}</p>;
}

describe('"Search instead for" the query as typed', () => {
  beforeEach(() => {
    router.push.mockClear();
    router.query = { query: 'Shikata nee' };
  });

  test('is offered when the service corrected the query', async () => {
    await summary('Shibata nee');
    await expect.element(page.getByText('Shibata nee')).toBeInTheDocument();
    await page.getByRole('button', { name: 'Shikata nee' }).click();
    expect(router.push.mock.calls.at(-1)?.[0]).toMatchObject({
      query: { query: 'Shikata nee', asTyped: 'Shikata nee' },
    });
  });

  test("runs the page's own handler where the URL is not the page's to write", async () => {
    const onSearchAsTyped = vi.fn();
    await renderWithProviders(
      <CorrectedQueryNote
        query="Shikata nee"
        correctedQuery="Shibata nee"
        onSearchAsTyped={onSearchAsTyped}
      />
    );
    await page.getByRole('button', { name: 'Shikata nee' }).click();
    expect(onSearchAsTyped).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  test.each([
    ['without a correction', undefined],
    ['for a correction that changed nothing', 'Shikata nee'],
  ])('is not offered %s', async (_name, correctedQuery) => {
    await summary(correctedQuery);
    await expect.element(page.getByText('Models matching “Shikata nee”')).toBeInTheDocument();
    expect(page.getByText(/Search instead for/).query()).toBeNull();
  });

  test('turns the spelling correction off for that query', async () => {
    router.query = { query: 'Shikata nee', asTyped: 'Shikata nee' };
    await renderWithProviders(<Flag query="Shikata nee" />);
    await expect.element(page.getByTestId('flag')).toHaveTextContent('{"spellcheck":false}');
  });

  test('leaves it on for a new search (control)', async () => {
    router.query = { query: 'anime girl', asTyped: 'Shikata nee' };
    await renderWithProviders(<Flag query="anime girl" />);
    await expect.element(page.getByTestId('flag')).toHaveTextContent(/^\{\}$/);
  });
});
