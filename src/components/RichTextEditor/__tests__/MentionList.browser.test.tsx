import React from 'react';
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

/**
 * A DISABLED React Query reports `isFetching: false`, so before the fix the whole 300ms
 * debounce window fell through to the empty-state branch — ~1.0s of "No results" for text
 * nobody had searched yet.
 */
type Hit = { id: number; username: string };

const queryCalls: Array<{ input: { query: string }; opts: Record<string, unknown> }> = [];
let nextResult: { data?: Array<Hit>; isError?: boolean } = {};
let lastData: Array<Hit> | undefined;

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  return {
    ...actual,
    trpc: {
      user: {
        getAll: {
          useQuery: (input: { query: string }, opts: Record<string, unknown>) => {
            queryCalls.push({ input, opts });
            // placeholderData applies to any PENDING query, disabled included, so the previous
            // payload survives a key change. Without it the "bare @" test passes vacuously.
            const carried = opts.placeholderData ? lastData : undefined;
            // Disabled: no fetch, and NOT reported as fetching — the trap this file exists for.
            if (!opts.enabled) return { data: carried, isFetching: false, isError: false };
            // An errored query has no placeholder — placeholderData covers pending only.
            if (nextResult.isError) return { data: undefined, isFetching: false, isError: true };
            if (!nextResult.data) return { data: carried, isFetching: true, isError: false };
            lastData = nextResult.data;
            return { data: nextResult.data, isFetching: false, isError: false };
          },
        },
      },
    },
  };
});

const { MentionList } = await import('~/components/RichTextEditor/MentionList');

type ListProps = React.ComponentProps<typeof MentionList>;

const props = (query: string, items: Array<{ id: number; label: string }> = []) =>
  ({ query, items, command: vi.fn(), editor: null } as unknown as ListProps);

const shownText = (container: HTMLElement) => container.textContent ?? '';

beforeEach(() => {
  queryCalls.length = 0;
  nextResult = {};
  lastData = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MentionList', () => {
  test('🔴 does not claim "No results" during the debounce window', async () => {
    // Fake timers hold the debounce open, so the asserted state cannot delete itself
    // mid-assertion; a real 300ms timer would be green locally and red on a busy box.
    vi.useFakeTimers();

    // Mounting straight to 'nof' seeds useDebouncedValue's initial state with it and skips
    // the gap entirely — the test would then pass against the bug.
    const { rerender, container } = await renderWithProviders(<MentionList {...props('')} />);
    await rerender(<MentionList {...props('nof')} />);

    // Control: without this the assertions below could pass for a reason unrelated to the gap.
    expect(queryCalls.at(-1)?.opts.enabled).toBe(false);

    const shown = shownText(container);
    expect(shown).not.toContain('No results');
    expect(shown).toContain('Fetching');
  });

  test('says "No results" once the query has actually settled empty', async () => {
    const { rerender } = await renderWithProviders(<MentionList {...props('')} />);
    nextResult = { data: [] };
    await rerender(<MentionList {...props('zzzznobody')} />);

    await expect.element(page.getByText('No results')).toBeInTheDocument();
  });

  test('renders results once they arrive', async () => {
    const { rerender, container } = await renderWithProviders(<MentionList {...props('')} />);
    nextResult = { data: [{ id: 9178756, username: 'nofmegan895' }] };
    await rerender(<MentionList {...props('nofmegan895')} />);

    await expect.element(page.getByText('nofmegan895')).toBeInTheDocument();
    expect(shownText(container)).not.toContain('No results');
  });

  test('a failed search reads as unavailable, not as an absent user', async () => {
    const { rerender, container } = await renderWithProviders(<MentionList {...props('')} />);
    nextResult = { isError: true };
    await rerender(<MentionList {...props('nofmegan895')} />);

    await expect.element(page.getByText(/Search unavailable/)).toBeInTheDocument();
    expect(shownText(container)).not.toContain('No results');
  });

  test('asks for keepPreviousData so the list does not blank between keystrokes', async () => {
    const { rerender } = await renderWithProviders(<MentionList {...props('')} />);
    nextResult = { data: [{ id: 1, username: 'nofear' }] };
    await rerender(<MentionList {...props('nof')} />);

    await expect.element(page.getByText('nofear')).toBeInTheDocument();
    // Without it every key change resets `data` to undefined and the list blanks mid-type.
    expect(queryCalls.at(-1)?.opts.placeholderData).toBeTypeOf('function');
  });

  test('drops server hits when the user deletes back to a bare @', async () => {
    nextResult = { data: [{ id: 1, username: 'nofear' }] };
    const { rerender } = await renderWithProviders(<MentionList {...props('')} />);
    await rerender(<MentionList {...props('nof')} />);
    await expect.element(page.getByText('nofear')).toBeInTheDocument();

    // Polled, not read synchronously: `debouncedQuery` trails back to '' on the same
    // 300ms timer, so the hits are still on screen at the moment of the rerender.
    await rerender(<MentionList {...props('', [{ id: 42, label: 'ThreadParticipant' }])} />);
    await expect.element(page.getByText('ThreadParticipant')).toBeInTheDocument();
    await expect.element(page.getByText('nofear')).not.toBeInTheDocument();
  });
});
