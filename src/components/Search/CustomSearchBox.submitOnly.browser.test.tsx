import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { InstantSearch } from 'react-instantsearch';
import type { InstantSearchProps } from 'react-instantsearch';
import { renderWithProviders } from '../../../test/component-setup';

const viewer = vi.hoisted(() => ({ current: null as { isModerator: boolean } | null }));

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useCurrentUser: () => viewer.current };
});
// A stand-in term rather than a real entry from the list.
vi.mock('~/utils/metadata/audit-base', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getBlockedNsfwWords: (value?: string | null) =>
      value?.includes('blockedterm') ? ['blockedterm'] : [],
  };
});

const { CustomSearchBox, searchBoxFor } = await import(
  '~/components/Search/CustomSearchComponents'
);

// Longer than the box's 300 ms debounce, so a per-keystroke search would have gone out by then.
const PAST_DEBOUNCE_MS = 700;

/**
 * Records every non-empty query the box sends: each one is a paid search for the images index.
 * `requests` counts the client calls, which tells two refines InstantSearch merged into one call
 * apart from two calls.
 */
function createRecordingClient() {
  const queries: string[] = [];
  const counts = { requests: 0 };
  const searchClient = {
    search(requests: readonly { params?: { query?: string } }[]) {
      if (requests.some((request) => request.params?.query)) counts.requests++;
      for (const request of requests) if (request.params?.query) queries.push(request.params.query);
      return Promise.resolve({
        results: requests.map((request) => ({
          hits: [],
          nbHits: 0,
          page: 0,
          nbPages: 0,
          hitsPerPage: 20,
          processingTimeMS: 0,
          query: request.params?.query ?? '',
          params: '',
          exhaustiveNbHits: true,
        })),
      });
    },
  } as unknown as InstantSearchProps['searchClient'];
  return { searchClient, queries, counts };
}

function renderBox(submitOnly: boolean, onSearchDone?: () => void, isMobile = true) {
  const client = createRecordingClient();
  renderWithProviders(
    <InstantSearch searchClient={client.searchClient} indexName="images_v6">
      <CustomSearchBox isMobile={isMobile} submitOnly={submitOnly} onSearchDone={onSearchDone} />
    </InstantSearch>
  );
  return client;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function typeQuery(text: string) {
  await userEvent.click(page.getByPlaceholder('Search...'));
  await userEvent.type(page.getByPlaceholder('Search...'), text);
  await pause(PAST_DEBOUNCE_MS);
}

beforeEach(() => {
  viewer.current = null;
});

describe('CustomSearchBox submitOnly', () => {
  test('sends nothing while typing, then one search on Enter', async () => {
    const client = renderBox(true);
    await typeQuery('rainy neon street');
    expect(client.queries).toEqual([]);

    await userEvent.keyboard('{Enter}');
    await expect.poll(() => client.queries).toEqual(['rainy neon street']);
  });

  // `onSearchDone` is what closes the mobile header overlay, so Enter has to reach it — once, and
  // without the blur it goes through sending the search a second time.
  test('Enter on mobile closes the overlay after one search', async () => {
    const onSearchDone = vi.fn();
    const client = renderBox(true, onSearchDone);
    await typeQuery('rainy neon street');

    await userEvent.keyboard('{Enter}');
    await expect.poll(() => onSearchDone).toHaveBeenCalledTimes(1);
    await pause(PAST_DEBOUNCE_MS);
    expect(onSearchDone).toHaveBeenCalledTimes(1);
    expect(client.queries).toEqual(['rainy neon street']);
    expect(client.counts.requests).toBe(1);
  });

  // Desktop Enter keeps focus, so no blur searches for it: Enter has to search on its own.
  test('Enter on desktop sends one search and keeps the box focused', async () => {
    const client = renderBox(true, undefined, false);
    await typeQuery('rainy neon street');

    await userEvent.keyboard('{Enter}');
    await expect.poll(() => client.queries).toEqual(['rainy neon street']);
    await pause(PAST_DEBOUNCE_MS);
    expect(client.counts.requests).toBe(1);
    await expect.element(page.getByPlaceholder('Search...')).toHaveFocus();
  });

  test('searches once on blur with a changed query', async () => {
    const client = renderBox(true);
    await typeQuery('rainy neon street');
    expect(client.queries).toEqual([]);

    (page.getByPlaceholder('Search...').element() as HTMLInputElement).blur();
    await expect.poll(() => client.queries).toEqual(['rainy neon street']);
  });

  // The control: without the prop the same typing searches on its own, so the assertions above
  // would see a per-keystroke search if one went out.
  test('without it, typing searches after the debounce', async () => {
    const client = renderBox(false);
    await typeQuery('rainy neon street');
    await expect.poll(() => client.queries).toContain('rainy neon street');
  });

  test('a blocked word is not sent on Enter or blur', async () => {
    const client = renderBox(true);
    await typeQuery('blockedterm street');
    await userEvent.keyboard('{Enter}');
    (page.getByPlaceholder('Search...').element() as HTMLInputElement).blur();
    await pause(PAST_DEBOUNCE_MS);
    expect(client.queries).toEqual([]);
  });

  // The control: the same text from a moderator is sent, so the test above sees the gate.
  test('a moderator searches a blocked word on Enter', async () => {
    viewer.current = { isModerator: true };
    const client = renderBox(true);
    await typeQuery('blockedterm street');
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => client.queries).toEqual(['blockedterm street']);
  });
});

// The search page picks its box by index: only an image index waits for Enter.
describe('searchBoxFor', () => {
  function renderPageBox(indexName: string) {
    const client = createRecordingClient();
    const SearchBox = searchBoxFor(indexName);
    renderWithProviders(
      <InstantSearch searchClient={client.searchClient} indexName={indexName}>
        <SearchBox isMobile={false} />
      </InstantSearch>
    );
    return client;
  }

  test('the images index sends nothing while typing', async () => {
    const client = renderPageBox('images_v6');
    await typeQuery('rainy neon street');
    expect(client.queries).toEqual([]);
  });

  test('another index searches after the debounce', async () => {
    const client = renderPageBox('models_v9');
    await typeQuery('rainy neon street');
    await expect.poll(() => client.queries).toContain('rainy neon street');
  });
});
