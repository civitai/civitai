import { describe, expect, test, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';
import type * as BrowsingLevelModule from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as HiddenPreferencesModule from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY } from '~/shared/constants/crucible.constants';

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'crucible.getJudgingSuggestions': { useQuery: () => ({ data: [], isLoading: false }) },
    }),
  };
});

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelModule>()),
  useBrowsingLevelDebounced: () => 1,
}));

vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', async (importOriginal) => ({
  ...(await importOriginal<typeof HiddenPreferencesModule>()),
  useApplyHiddenPreferences: () => ({ items: [] }),
}));

vi.mock('~/components/Crucible/CrucibleJudgeNextButton', () => ({
  CrucibleJudgeNextButton: ({
    label,
    cycleFrom,
    variant,
  }: {
    label: string;
    cycleFrom?: { id: number; createdAt: Date };
    variant?: string;
  }) => (
    <button
      data-cycle-id={cycleFrom?.id}
      data-cycle-created-at={cycleFrom?.createdAt.toISOString()}
      data-variant={variant}
    >
      {label}
    </button>
  ),
}));

const { CrucibleJudgingDoneState } = await import('~/components/Crucible/CrucibleJudgingDoneState');

const render = (
  props: { sessionVotes?: number; onlyOwnEntries?: boolean; votesUsedUp?: boolean } = {}
) =>
  renderWithProviders(
    <CrucibleJudgingDoneState
      crucibleId={1}
      crucibleName="Test Crucible"
      crucibleCreatedAt={new Date('2026-10-01T00:00:00.000Z')}
      sessionVotes={props.sessionVotes ?? 0}
      onlyOwnEntries={props.onlyOwnEntries ?? false}
      votesUsedUp={props.votesUsedUp ?? false}
    />
  );

describe('CrucibleJudgingDoneState', () => {
  test('says the judge is done because of the per-judge vote limit, naming it', async () => {
    render({ sessionVotes: 47, votesUsedUp: true });

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        `up to ${CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY} times`
      )
    );
    expect(document.body.textContent).toContain('never shown the same pair twice');
    expect(document.body.textContent).toContain('47 pairs');
  });

  test('celebrates being caught up with a way back and a way on', async () => {
    render({ votesUsedUp: true });

    await vi.waitFor(() => expect(document.body.textContent).toContain("You're caught up here"));
    expect(document.body.textContent).toContain(
      'You judged every pair open to you in Test Crucible. New entries open new pairs until it ends.'
    );
    const back = [...document.querySelectorAll('a')].find(
      (a) => a.textContent === 'Back to crucible'
    );
    expect(back?.getAttribute('href')).toContain('/crucibles/1');
    const next = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Next crucible'
    );
    expect(next?.getAttribute('data-cycle-id')).toBe('1');
    expect(next?.getAttribute('data-cycle-created-at')).toBe('2026-10-01T00:00:00.000Z');
    expect(next?.getAttribute('data-variant')).toBe('primary');
    expect(document.body.textContent).not.toContain('more crucible');
  });

  test('keeps the plain back button when votes are not used up', async () => {
    render({ votesUsedUp: false });

    await vi.waitFor(() => expect(document.body.textContent).toContain('Back to Test Crucible'));
    expect(document.body.textContent).not.toContain('Next crucible');
  });

  test('explains own-entry exclusion instead when there is nothing to judge yet', async () => {
    render({ onlyOwnEntries: true });

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("You're never shown your own entries")
    );
    expect(document.body.textContent).not.toContain('times');
  });

  // A null pair also comes from the browsing level hiding entries; that judge has votes left.
  test('does not claim the votes are used up when the server says they are not', async () => {
    render({ sessionVotes: 3, votesUsedUp: false });

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('There are no pairs for you to judge right now')
    );
    expect(document.body.textContent).not.toContain("You've used all your votes");
    expect(document.body.textContent).not.toContain(
      `up to ${CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY} times`
    );
  });
});
