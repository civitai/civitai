// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrucibleEntryData } from '~/components/Crucible/CrucibleEntryGrid';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';

// Media, avatars and the profile link need the app's providers; what the grid draws around them
// is the subject here.
const viewer = vi.hoisted(() => ({ current: null as { id: number; isModerator: boolean } | null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => viewer.current }));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia2: ({ src }: { src: string }) => createElement('img', { alt: src }),
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('~/components/Crucible/CrucibleUserLink', () => ({
  CrucibleUserLink: ({ children }: { children: ReactNode }) => children,
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

const renderGrid = (status: CrucibleStatus) =>
  act(() =>
    root.render(
      createElement(
        MantineProvider,
        null,
        createElement(CrucibleEntryGrid, {
          entries: [entry(1), entry(2)],
          onEntryClick,
          status,
        })
      )
    )
  );

const clickEntry = (id: number) => {
  const media = container.querySelector<HTMLImageElement>(`img[alt="image-${id}"]`);
  if (!media) throw new Error(`entry ${id} did not render`);
  act(() => media.click());
};

const shownCreators = () =>
  ['entrant1', 'entrant2'].filter((name) => container.textContent?.includes(name));

const openedEntries = () => {
  onEntryClick.mockReset();
  clickEntry(1);
  clickEntry(2);
  return onEntryClick.mock.calls.map(([entry]) => (entry as CrucibleEntryData).id);
};

const stranger = { id: 1, isModerator: false };
// entry(1) belongs to user 101.
const entrant = { id: 101, isModerator: false };
const moderator = { id: 2, isModerator: true };

describe('CrucibleEntryGrid while judging is blind', () => {
  it('shows a judge no creator and opens nothing while the crucible runs', () => {
    viewer.current = stranger;
    renderGrid(CrucibleStatus.Active);

    expect(shownCreators()).toEqual([]);
    expect(openedEntries()).toEqual([]);
  });

  it('shows an entrant their own entry but not the others', () => {
    viewer.current = entrant;
    renderGrid(CrucibleStatus.Active);

    expect(shownCreators()).toEqual(['entrant1']);
    expect(openedEntries()).toEqual([1]);
  });

  it('shows a moderator everything while the crucible runs', () => {
    viewer.current = moderator;
    renderGrid(CrucibleStatus.Active);

    expect(shownCreators()).toEqual(['entrant1', 'entrant2']);
    expect(openedEntries()).toEqual([1, 2]);
  });

  it('reveals every creator once the crucible is completed', () => {
    viewer.current = stranger;
    renderGrid(CrucibleStatus.Completed);

    expect(shownCreators()).toEqual(['entrant1', 'entrant2']);
    expect(openedEntries()).toEqual([1, 2]);
  });
});
