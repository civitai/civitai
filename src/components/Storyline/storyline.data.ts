import type { StorylineSpaceSettings } from '~/components/Storyline/manage/StorylineSettingsForm';
import type { StorylineContinueMode } from '~/components/Storyline/storyline-ui';
import type { StorylineSubmitOutcome } from '~/components/Storyline/continue/StorylineContinueForm';
import type { StorylineQueueRow } from '~/components/Storyline/queue/StorylineQueueList';

/**
 * The storyline's placement space, for its owner.
 *
 * The read and write live in the placement router, which does not serve the storyline surface
 * yet. Until it does this reports `unavailable` and the settings form disables those controls,
 * rather than showing a default the server never said.
 */
export function useStorylineSpace(
  _storylineId: number,
  _options: { enabled: boolean }
): {
  data: StorylineSpaceSettings | null;
  unavailable: boolean;
  isSaving: boolean;
  save: (next: { mode: StorylineContinueMode; price: number | null }) => void;
} {
  return { data: null, unavailable: true, isSaving: false, save: () => undefined };
}

/** What a contributor is told before submitting: the price and who may continue. */
export function useStorylineContinueTerms(_storylineId: number | null): {
  data: { price: number; mode: StorylineContinueMode } | null;
  isLoading: boolean;
} {
  return { data: null, isLoading: false };
}

export function useSubmitStorylineContinuation(_options: {
  onSuccess: (outcome: StorylineSubmitOutcome) => void;
}): {
  unavailable: boolean;
  isPending: boolean;
  error: string | null;
  mutate: (input: { parentPostId: number; postId: number; expectedPrice: number }) => void;
} {
  return { unavailable: true, isPending: false, error: null, mutate: () => undefined };
}

/** Continuations waiting on the viewer's storylines, one page at a time. */
export function useStorylineQueue(_options: { enabled: boolean }): {
  unavailable: boolean;
  rows: StorylineQueueRow[];
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  loadMore: () => void;
} {
  return {
    unavailable: true,
    rows: [],
    isLoading: false,
    isError: false,
    hasMore: false,
    isFetchingMore: false,
    loadMore: () => undefined,
  };
}

/** Accept or decline one continuation. Throws the server's message on refusal. */
export function useActOnStorylineContinuation(): {
  act: (input: { placementId: number; action: 'approve' | 'decline' }) => Promise<void>;
} {
  return {
    act: async () => {
      throw new Error('Reviewing continuations is not available yet.');
    },
  };
}
