import { describe, expect, test, vi } from 'vitest';
import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';
import type { CrucibleHeaderData } from '~/components/Crucible/CrucibleHeader';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// Everything around the entry chip needs the app's providers; the count does not.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/Crucible/CrucibleContextMenu', () => ({ CrucibleContextMenu: () => null }));
vi.mock('~/components/Crucible/CrucibleFollowToggle', () => ({ CrucibleFollowToggle: () => null }));
vi.mock('~/components/Crucible/CrucibleUserLink', () => ({ CrucibleUserLink: () => null }));
vi.mock('~/components/Crucible/CrucibleContentBadges', () => ({
  CrucibleContentBadges: () => null,
}));
vi.mock('~/components/Crucible/CrucibleTimer', () => ({ CrucibleTimer: () => null }));
vi.mock('~/components/RatingReview/OwnerRatingControls', () => ({
  OwnerRatingControls: () => null,
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('~/components/User/Username', () => ({ Username: () => null }));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({ EdgeMedia: () => null }));

const { CrucibleHeader } = await import('~/components/Crucible/CrucibleHeader');

const crucible = (rawEntries: number): CrucibleHeaderData => ({
  id: 154,
  name: 'Test crucible',
  description: null,
  status: CrucibleStatus.Active,
  nsfwLevel: 1,
  entryFee: 0,
  seededPrizePool: 0,
  buzzType: 'green',
  startAt: null,
  endAt: null,
  contentType: MediaType.image,
  user: { id: 1, username: 'host', deletedAt: null, image: null } as never,
  image: null,
  heroImage: null,
  _count: { entries: rawEntries },
  paidEntryCount: 0,
  entrantCount: 0,
});

const claimed = () => document.body.textContent?.match(/(\d+)\s(entry|entries)/)?.[0];
// The title renders first; the chip is read only once the header has drawn.
const drawn = () => vi.waitFor(() => expect(document.body.textContent).toContain('Test crucible'));

describe('CrucibleHeader entry count', () => {
  test('claims the entries the viewer can see listed, not every row', async () => {
    renderWithProviders(<CrucibleHeader crucible={crucible(5)} entryCount={4} />);

    await drawn();
    expect(claimed()).toBe('4 entries');
  });

  test('falls back to the row count until the listed count is known', async () => {
    renderWithProviders(<CrucibleHeader crucible={crucible(5)} />);

    await drawn();
    expect(claimed()).toBe('5 entries');
  });

  test('says "1 entry" for one', async () => {
    renderWithProviders(<CrucibleHeader crucible={crucible(3)} entryCount={1} />);

    await drawn();
    expect(claimed()).toBe('1 entry');
  });
});
