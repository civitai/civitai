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

const { CustomSearchBox } = await import('~/components/Search/CustomSearchComponents');

// Longer than the box's 300 ms debounce, so a per-keystroke search would have gone out by then.
const PAST_DEBOUNCE_MS = 700;

/** Records every non-empty query the box sends: each one is a paid search for the images index. */
function createRecordingClient() {
  const queries: string[] = [];
  const searchClient = {
    search(requests: readonly { params?: { query?: string } }[]) {
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
  return { searchClient, queries };
}

function renderBox(submitOnly: boolean) {
  const client = createRecordingClient();
  renderWithProviders(
    <InstantSearch searchClient={client.searchClient} indexName="images_v6">
      <CustomSearchBox isMobile submitOnly={submitOnly} />
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
    expect(client.queries).toContain('rainy neon street');
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
