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
const viewer = vi.hoisted(() => ({ current: null as Viewer | null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => viewer.current }));
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
const renderGrid = (status: CrucibleStatus, as: Viewer | null) => {
  viewer.current = as;
  act(() =>
    root.render(
      createElement(
        MantineProvider,
        null,
        createElement(CrucibleEntryGrid, {
          entries,
          viewerEntries: entries.filter((e) => e.userId === as?.id),
          showUserEntries: !!as,
          currentUserId: as?.id,
          onEntryClick,
          status,
        })
      )
    )
  );
};

const clickEntry = (id: number) => {
  const media = container.querySelector<HTMLImageElement>(`img[alt="image-${id}"]`);
  if (!media) throw new Error(`entry ${id} did not render`);
  act(() => media.click());
};

const shownCreators = () =>
  ['entrant1', 'entrant2'].filter((name) => container.innerHTML.includes(name));

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

const stranger = { id: 1, isModerator: false };
// entry(1) belongs to user 101.
const entrant = { id: 101, isModerator: false };
const moderator = { id: 2, isModerator: true };

describe('CrucibleEntryGrid while judging is blind', () => {
  it('shows a logged-out visitor no creator and opens nothing while the crucible runs', () => {
    renderGrid(CrucibleStatus.Active, null);

    expect(shownCreators()).toEqual([]);
    expect(openedEntries()).toEqual([]);
  });

  it('shows a judge no creator and opens nothing while the crucible runs', () => {
    renderGrid(CrucibleStatus.Active, stranger);

    expect(shownCreators()).toEqual([]);
    expect(openedEntries()).toEqual([]);
  });

  it("opens an entrant's own entry without paging into anyone else's", () => {
    renderGrid(CrucibleStatus.Active, entrant);

    expect(shownCreators()).toEqual(['entrant1']);
    expect(openedEntries()).toEqual([[1, [10]]]);
  });

  it('shows a moderator everything while the crucible runs', () => {
    renderGrid(CrucibleStatus.Active, moderator);

    expect(shownCreators()).toEqual(['entrant1', 'entrant2']);
    expect(openedEntries()).toEqual([
      [1, [10, 20]],
      [2, [10, 20]],
    ]);
  });

  it('reveals every creator once the crucible is completed', () => {
    renderGrid(CrucibleStatus.Completed, stranger);

    expect(shownCreators()).toEqual(['entrant1', 'entrant2']);
    expect(openedEntries()).toEqual([
      [1, [10, 20]],
      [2, [10, 20]],
    ]);
  });
});
