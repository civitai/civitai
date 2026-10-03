// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrucibleEntryData } from '~/components/Crucible/CrucibleEntryGrid';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';

// Media, avatars and the profile link need the app's providers. The stand-ins still print the
// creator, so a gate that leaves the avatar or the link outside it shows up in the markup.
type Viewer = { id: number; isModerator: boolean };
const signedIn = vi.hoisted(() => ({ current: null as Viewer | null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => signedIn.current }));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia2: ({ src }: { src: string }) => createElement('img', { alt: src }),
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string | null } }) =>
    createElement('i', { 'data-avatar': user.username }),
}));
vi.mock('~/components/Crucible/CrucibleUserLink', () => ({
  CrucibleUserLink: ({
    user,
    children,
  }: {
    user: { username: string | null };
    children: ReactNode;
  }) => createElement('a', { href: `/user/${user.username}` }, children),
}));

const { CrucibleEntryGrid } = await import('~/components/Crucible/CrucibleEntryGrid');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
const entries = [entry(1), entry(2)];

let container: HTMLDivElement;
let root: Root;
const onEntryClick = vi.fn();

beforeEach(() => {
  onEntryClick.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// Rendered the way the crucible page renders it: the viewer's own entries arrive separately and get
// their own section.
const renderGrid = (
  status: CrucibleStatus,
  as: Viewer | null,
  { list = entries, hasMore = false } = {}
) => {
  signedIn.current = as;
  act(() =>
    root.render(
      createElement(
        MantineProvider,
        // No transitions or portals, so the viewer modal renders synchronously.
        { env: 'test' },
        createElement(CrucibleEntryGrid, {
          entries: list,
          viewerEntries: list.filter((e) => e.userId === as?.id),
          hasMore,
          showUserEntries: !!as,
          currentUserId: as?.id,
          onEntryClick,
          status,
        })
      )
    )
  );
};

// The grid's own cards; with no portal the open viewer's media is in the container too.
const clickEntry = (id: number) => {
  const media = container.querySelector<HTMLImageElement>(`.group img[alt="image-${id}"]`);
  if (!media) throw new Error(`entry ${id} did not render`);
  act(() => media.click());
};

const shownCreators = () =>
  ['entrant1', 'entrant2'].filter((name) => document.body.innerHTML.includes(name));

/** Clicks every entry; returns the ones that opened, and the ids each was handed to page through. */
const openedEntries = () => {
  onEntryClick.mockReset();
  clickEntry(1);
  clickEntry(2);
  return onEntryClick.mock.calls.map(([opened, pageable]) => [
    (opened as CrucibleEntryData).id,
    pageable,
  ]);
};

const viewerElement = () => document.querySelector('[data-testid="crucible-entry-media-viewer"]');
/** What the media-only viewer is showing: its media and position, or null when closed. */
const viewerShows = () => {
  const open = viewerElement();
  if (!open) return null;
  return {
    media: open.querySelector('img')?.getAttribute('alt'),
    position: open.querySelector('p')?.textContent,
  };
};
const press = (label: string) => {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`no ${label} button`);
  act(() => button.click());
};

const stranger = { id: 1, isModerator: false };
// entry(1) belongs to user 101.
const entrant = { id: 101, isModerator: false };
const moderator = { id: 2, isModerator: true };

describe('CrucibleEntryGrid while judging is blind', () => {
  it('shows a logged-out visitor no creator and only the media while the crucible runs', () => {
    renderGrid(CrucibleStatus.Active, null);

    expect(openedEntries()).toEqual([]);
    expect(viewerShows()).toEqual({ media: 'image-2', position: '2 / 2' });
    expect(shownCreators()).toEqual([]);
  });

  it('shows a judge only the media, paging through the other entries, while the crucible runs', () => {
    renderGrid(CrucibleStatus.Active, stranger);

    clickEntry(1);
    expect(viewerShows()).toEqual({ media: 'image-1', position: '1 / 2' });
    expect(shownCreators()).toEqual([]);

    press('Next entry');
    expect(viewerShows()).toEqual({ media: 'image-2', position: '2 / 2' });
    expect(shownCreators()).toEqual([]);

    press('Close entry viewer');
    expect(viewerShows()).toBeNull();
    expect(onEntryClick).not.toHaveBeenCalled();
  });

  it('keeps showing the same entry when the list changes under the viewer', () => {
    renderGrid(CrucibleStatus.Active, stranger);
    clickEntry(2);

    renderGrid(CrucibleStatus.Active, stranger, { list: [entry(3), entry(1), entry(2)] });
    expect(viewerShows()).toEqual({ media: 'image-2', position: '3 / 3' });
  });

  it('counts only the loaded entries as a floor while more are unloaded', () => {
    renderGrid(CrucibleStatus.Active, stranger, { hasMore: true });
    clickEntry(2);

    expect(viewerShows()).toEqual({ media: 'image-2', position: '2 / 2+' });
  });

  it("opens an entrant's own entry in full and everyone else's media-only", () => {
    renderGrid(CrucibleStatus.Active, entrant);

    expect(openedEntries()).toEqual([[1, [10]]]);
    expect(viewerShows()).toEqual({ media: 'image-2', position: '1 / 1' });
    expect(shownCreators()).toEqual(['entrant1']);
  });

  it('shows a moderator everything while the crucible runs', () => {
    renderGrid(CrucibleStatus.Active, moderator);

    expect(shownCreators()).toEqual(['entrant1', 'entrant2']);
    expect(openedEntries()).toEqual([
      [1, [10, 20]],
      [2, [10, 20]],
    ]);
    expect(viewerShows()).toBeNull();
  });

  it('reveals every creator once the crucible is completed', () => {
    renderGrid(CrucibleStatus.Completed, stranger);

    expect(shownCreators()).toEqual(['entrant1', 'entrant2']);
    expect(openedEntries()).toEqual([
      [1, [10, 20]],
      [2, [10, 20]],
    ]);
    expect(viewerShows()).toBeNull();
  });
});
