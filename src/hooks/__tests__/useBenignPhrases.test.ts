// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import type * as Trpc from '~/utils/trpc';

const act = (React as unknown as { act: typeof actType }).act;

type QueryResult = {
  data?: { prompt: string[]; profanityWords: string[] | null; available: boolean };
  isFetched: boolean;
};

let queryResult: QueryResult = { data: undefined, isFetched: false };
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  return {
    ...actual,
    trpc: {
      ...actual.trpc,
      system: {
        ...actual.trpc.system,
        getBenignPhrases: { useQuery: () => queryResult },
      },
    },
  };
});

import { useBenignPhrases } from '~/hooks/useBenignPhrases';

type Hook = ReturnType<typeof useBenignPhrases>;

function renderHook(): Hook {
  let captured: Hook | undefined;
  function Probe() {
    captured = useBenignPhrases();
    return null;
  }
  const container = document.createElement('div');
  act(() => {
    createRoot(container).render(React.createElement(Probe));
  });
  if (!captured) throw new Error('hook did not render');
  return captured;
}

describe('useBenignPhrases', () => {
  beforeEach(() => {
    queryResult = { data: undefined, isFetched: false };
  });

  describe('the window before the lists arrive', () => {
    it('strips nothing, so the gates judge the raw query and flag MORE', () => {
      const { strip } = renderHook();
      expect(strip('emma stone portrait')).toBe('emma stone portrait');
    });

    it('is not settled, so a caller with a side effect can hold it', () => {
      expect(renderHook().settled).toBe(false);
    });
  });

  describe('once the lists arrive', () => {
    beforeEach(() => {
      queryResult = {
        data: { prompt: ['emma stone'], profanityWords: ['spreadsheet'], available: true },
        isFetched: true,
      };
    });

    it('strips the whitelisted phrase and leaves the rest', () => {
      expect(renderHook().strip('emma stone portrait').trim()).toBe('portrait');
    });

    it('reports settled and passes the moderator word list through', () => {
      const hook = renderHook();
      expect(hook.settled).toBe(true);
      expect(hook.profanityWords).toEqual(['spreadsheet']);
    });
  });

  // `null` (no moderator row) and `[]` (a moderator deleted every entry) are different states,
  // and the profanity filter treats them differently — `null` falls back to the ~450 words
  // shipped in the bundle, `[]` honours the emptying. A `?? []` here would re-read every
  // ordinary "we don't know yet" as a deliberate emptying and drop the shipped list on a
  // normal page load, on a failed fetch, and before the seed migration is applied.
  describe('unknown is not the same as empty', () => {
    it('reports null before the query resolves, not an empty list', () => {
      expect(renderHook().profanityWords).toBeNull();
    });

    it('reports null when the server could not read the lists', () => {
      queryResult = {
        data: { prompt: [], profanityWords: null, available: false },
        isFetched: true,
      };
      expect(renderHook().profanityWords).toBeNull();
    });

    it('preserves an EMPTY moderator list as empty', () => {
      queryResult = {
        data: { prompt: [], profanityWords: [], available: true },
        isFetched: true,
      };
      expect(renderHook().profanityWords).toEqual([]);
    });

    it('settles even when the fetch failed, so a held side effect is not suppressed forever', () => {
      queryResult = { data: undefined, isFetched: true };
      expect(renderHook().settled).toBe(true);
    });
  });
});
