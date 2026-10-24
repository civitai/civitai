import { beforeEach, describe, expect, test, vi } from 'vitest';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import type { CrucibleEntryData } from '~/components/Crucible/CrucibleEntryGrid';
import type * as EdgeMediaModule from '~/components/EdgeMedia/EdgeMedia';
import type * as UserAvatarModule from '~/components/UserAvatar/UserAvatar';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1, isModerator: true }) }));
// Media and avatars need the app's content-settings and feature-flag providers; the control
// under test doesn't.
vi.mock('~/components/EdgeMedia/EdgeMedia', async (importOriginal) => ({
  ...(await importOriginal<typeof EdgeMediaModule>()),
  EdgeMedia2: () => null,
}));
vi.mock('~/components/UserAvatar/UserAvatar', async (importOriginal) => ({
  ...(await importOriginal<typeof UserAvatarModule>()),
  UserAvatar: () => null,
}));

const { CrucibleEntryGrid } = await import('~/components/Crucible/CrucibleEntryGrid');

const entry = (id: number): CrucibleEntryData => ({
  id,
  userId: 100 + id,
  imageId: id * 10,
  score: null,
  position: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  user: { id: 100 + id, username: `entrant${id}`, deletedAt: null, image: null },
  image: {
    id: id * 10,
    name: null,
    url: `image-${id}`,
    type: 'image',
    metadata: null,
    nsfwLevel: 1,
    width: 512,
    height: 640,
  },
});

const removeButtons = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[aria-label="Remove entry"]'));

const onEntryClick = vi.fn();
const onRemoveEntry = vi.fn();

beforeEach(() => {
  onEntryClick.mockReset();
  onRemoveEntry.mockReset();
});

describe('CrucibleEntryGrid — removing an entry', () => {
  test('shows no remove control unless the page hands one in', async () => {
    renderWithProviders(
      <CrucibleEntryGrid
        entries={[entry(1), entry(2)]}
        onEntryClick={onEntryClick}
        status={CrucibleStatus.Active}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(removeButtons()).toHaveLength(0);
  });

  test('removes the entry it sits on without also opening it', async () => {
    renderWithProviders(
      <CrucibleEntryGrid
        entries={[entry(1), entry(2)]}
        onEntryClick={onEntryClick}
        onRemoveEntry={onRemoveEntry}
        status={CrucibleStatus.Active}
      />
    );
    await expect.poll(() => removeButtons()).toHaveLength(2);

    removeButtons()[1].click();

    expect(onRemoveEntry).toHaveBeenCalledTimes(1);
    expect(onRemoveEntry.mock.calls[0][0]).toMatchObject({ id: 2 });
    expect(onEntryClick).not.toHaveBeenCalled();
  });
});
