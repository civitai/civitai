import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';

/**
 * Which caches a creator-announcement mutation busts.
 *
 * The panel and the profile carousel read DIFFERENT queries — `getFollowedAnnouncements`
 * and `getCreatorAnnouncements` — and tRPC is configured with `staleTime: Infinity` and
 * `refetchOnWindowFocus: false`, so a query nobody invalidates does not refetch for the rest
 * of the session. A mutation that busts only one of them therefore reports success and
 * leaves the mutated row on screen wherever the other query is the source.
 *
 * These live here rather than in the panel's browser test because that test stubs
 * `useDeleteCreatorAnnouncement` out entirely, which makes the invalidation set
 * unobservable by construction.
 */

const invalidate = vi.hoisted(() => ({
  getCreatorAnnouncements: vi.fn(),
  getFollowedAnnouncements: vi.fn(),
  getMutedCreators: vi.fn(),
  isCreatorMuted: vi.fn(),
}));

const captured = vi.hoisted(() => ({ options: {} as Record<string, any> }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  const mutationHook = (name: string) => ({
    useMutation: (options: Record<string, unknown>) => {
      captured.options[name] = options;
      return { mutate: vi.fn(), isPending: false };
    },
  });
  return {
    ...actual,
    trpc: {
      useUtils: () => ({
        announcement: {
          getCreatorAnnouncements: { invalidate: invalidate.getCreatorAnnouncements },
          getFollowedAnnouncements: { invalidate: invalidate.getFollowedAnnouncements },
          getMutedCreators: { invalidate: invalidate.getMutedCreators },
          isCreatorMuted: { invalidate: invalidate.isCreatorMuted },
        },
      }),
      announcement: {
        deleteCreatorAnnouncement: mutationHook('delete'),
        toggleAnnouncementMute: mutationHook('mute'),
      },
    },
  };
});

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ creatorAnnouncements: true }),
}));

import {
  useDeleteCreatorAnnouncement,
  useToggleAnnouncementMute,
} from '~/components/Announcements/creator-announcements.utils';

describe('creator announcement mutations invalidate both feeds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.options = {};
  });

  it('a delete busts the followed feed as well as the profile one', async () => {
    useDeleteCreatorAnnouncement();
    await captured.options.delete.onSuccess();

    // BOTH, named individually: asserting only the profile one passes against the bug this
    // covers, where a delete from the notifications panel left the card on screen.
    expect(invalidate.getCreatorAnnouncements).toHaveBeenCalled();
    expect(invalidate.getFollowedAnnouncements).toHaveBeenCalled();
  });

  it('a mute toggle busts the followed feed', async () => {
    useToggleAnnouncementMute(99);
    await captured.options.mute.onSuccess({ muted: true });

    expect(invalidate.getFollowedAnnouncements).toHaveBeenCalled();
    expect(invalidate.getMutedCreators).toHaveBeenCalled();
  });
});
